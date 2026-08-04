import { describe, expect, it } from "vitest";

import {
  aggregateRunOutcomes,
  compareRuns,
  type ComparableRun,
  type RunOutcomeFact,
} from "./run-comparison.js";
import type {
  AssembledInput,
  Run,
  RunConfiguration,
  RunOutput,
} from "./runs.js";
import type {
  CommandDefinitionId,
  CommandId,
  ObjectId,
  RunId,
  VersionId,
} from "./ids.js";

/**
 * §4.4's two gestures, as rules (§15-1 paying off).
 *
 * The point of every assertion here is that a comparison reads what each run
 * *recorded*, so it keeps answering after the inputs have moved on — and that the
 * outcome histogram never folds out-of-budget or interrupted into failure, because
 * that is what would make "is delegating this working?" answer wrong.
 */
const configuration = (
  over: Partial<RunConfiguration> = {},
): RunConfiguration => ({
  definitionId: "cmddef_1" as CommandDefinitionId,
  definitionName: "Implement the ticket",
  instruction: "Implement it.",
  model: { model: "fixture-model", effort: "medium" },
  permissions: { allowed: [], denied: [] },
  askPoints: [],
  lifecycle: "producing",
  outcome: null,
  parameters: {},
  budget: {
    modelWindowTokens: 100_000,
    warnAtFraction: 0.8,
    hardCapTokens: null,
  },
  ...over,
});

const input = (over: Partial<AssembledInput> = {}): AssembledInput => ({
  ordinal: 1,
  nodeId: null,
  objectId: "obj_ticket" as ObjectId,
  versionId: "ver_1" as VersionId,
  contentHash: "hash-1",
  bytes: 10,
  ...over,
});

const run = (over: Partial<Run> = {}): Run => ({
  id: "run_1" as RunId,
  commandId: "cmd_1" as CommandId,
  definitionId: "cmddef_1" as CommandDefinitionId,
  ordinal: 1,
  status: "completed",
  assembledBlobId: "blob_1",
  assembledHash: "assembled-1",
  assembledBytes: 100,
  configuration: configuration(),
  inputs: [input()],
  cost: { inputTokens: 100, outputTokens: 50, costMicros: 20_000 },
  spendCapMicros: null,
  pinned: false,
  startedAt: 1_000,
  endedAt: 2_000,
  ...over,
});

const comparable = (
  over: Partial<Run> = {},
  outputs: readonly RunOutput[] = [],
): ComparableRun => {
  const value = run(over);
  return {
    run: value,
    outputs,
    assembledAddress: `/api/runs/${value.id}/assembled`,
  };
};

describe("compareRuns (§4.4)", () => {
  it("refuses two runs of different definitions, with the reason", () => {
    const result = compareRuns(
      comparable(),
      comparable({
        id: "run_2" as RunId,
        definitionId: "cmddef_other" as CommandDefinitionId,
        configuration: configuration({
          definitionId: "cmddef_other" as CommandDefinitionId,
          definitionName: "Review the PR",
        }),
      }),
    );

    expect(result.comparable).toBe(false);
    if (result.comparable) return;
    expect(result.refusal.reason).toBe("different_definitions");
    // The reason says why, rather than only that: a side-by-side of two recipes
    // reads a difference in instruction as a difference in outcome.
    expect(result.refusal.message).toContain("Review the PR");
  });

  it("refuses comparing a run with itself", () => {
    const result = compareRuns(comparable(), comparable());
    expect(result.comparable).toBe(false);
    if (result.comparable) return;
    expect(result.refusal.reason).toBe("same_run");
  });

  it("compares runs of the same definition in different command nodes", () => {
    // The same recipe run in two workstreams is the same evidence — the grain
    // retention and cost estimation already use.
    const result = compareRuns(
      comparable(),
      comparable({ id: "run_2" as RunId, commandId: "cmd_other" as CommandId }),
    );

    expect(result.comparable).toBe(true);
  });

  it("names what changed about the inputs, by position", () => {
    const result = compareRuns(
      comparable({
        inputs: [
          input(),
          input({ ordinal: 2, objectId: "obj_note" as ObjectId }),
        ],
      }),
      comparable({
        id: "run_2" as RunId,
        ordinal: 2,
        inputs: [
          input({ versionId: "ver_2" as VersionId, contentHash: "hash-2" }),
        ],
      }),
    );

    expect(result.comparable).toBe(true);
    if (!result.comparable) return;
    const [first, second] = result.comparison.inputs;
    // Same object, new version: the drift-then-re-run case, which is the whole
    // reason §15-1 records the version each run consumed.
    expect(first?.change).toBe("content");
    expect(second?.change).toBe("removed");
  });

  it("says when both runs assembled byte-identical content", () => {
    const result = compareRuns(
      comparable(),
      comparable({ id: "run_2" as RunId, ordinal: 2 }),
    );

    expect(result.comparable).toBe(true);
    if (!result.comparable) return;
    expect(result.comparison.sameAssembledContent).toBe(true);
    // Both bodies stay addressable rather than being inlined, so a diff is
    // derivable without the comparison carrying two whole contexts.
    expect(result.comparison.left.assembledAddress).toBe(
      "/api/runs/run_1/assembled",
    );
  });

  it("does not report an instruction change as '0 of 1 inputs differ' (§4.4)", () => {
    const result = compareRuns(
      comparable(),
      comparable({
        id: "run_2" as RunId,
        ordinal: 2,
        // Edit the instruction, run it again, compare: the inputs are untouched
        // and the assembled bytes are not, because the instruction is in them.
        assembledHash: "assembled-2",
        configuration: configuration({ instruction: "Do it differently." }),
      }),
    );

    expect(result.comparable).toBe(true);
    if (!result.comparable) return;
    expect(result.comparison.sameAssembledContent).toBe(false);
    expect(result.comparison.summary).toContain(
      "the same inputs, but the assembled content differs",
    );
    expect(result.comparison.summary).not.toContain("0 of 1 inputs differ");
    expect(result.comparison.summary).toContain(
      "configuration differs in instruction",
    );
  });

  it("reports which model and configuration differed, and what it cost", () => {
    const result = compareRuns(
      comparable(),
      comparable({
        id: "run_2" as RunId,
        ordinal: 2,
        configuration: configuration({
          model: { model: "other-model", effort: "high" },
        }),
        cost: { inputTokens: 100, outputTokens: 50, costMicros: 50_000 },
      }),
    );

    expect(result.comparable).toBe(true);
    if (!result.comparable) return;
    expect(result.comparison.configuration.map((one) => one.field)).toEqual([
      "model",
      "effort",
    ]);
    expect(result.comparison.cost.deltaMicros).toBe(30_000);
    expect(result.comparison.cost.description).toContain("$0.02");
  });

  it("refuses to compare money when one run recorded none (§4.1)", () => {
    const result = compareRuns(
      comparable({ cost: { inputTokens: 0, outputTokens: 0, costMicros: 0 } }),
      comparable({ id: "run_2" as RunId }),
    );

    expect(result.comparable).toBe(true);
    if (!result.comparable) return;
    expect(result.comparison.cost.description).toContain("nothing to compare");
  });

  it("pairs outputs by name, saying which changed", () => {
    const output = (over: Partial<RunOutput>): RunOutput => ({
      runId: "run_1" as RunId,
      name: "result",
      objectId: "obj_result" as ObjectId,
      versionId: "ver_a" as VersionId,
      ...over,
    });

    const result = compareRuns(
      comparable({}, [output({})]),
      comparable({ id: "run_2" as RunId }, [
        output({ runId: "run_2" as RunId, versionId: "ver_b" as VersionId }),
        output({ runId: "run_2" as RunId, name: "notes" }),
      ]),
    );

    expect(result.comparable).toBe(true);
    if (!result.comparable) return;
    expect(
      result.comparison.outputs.map((one) => [one.name, one.change]),
    ).toEqual([
      ["notes", "added"],
      ["result", "different"],
    ]);
  });
});

describe("aggregateRunOutcomes (§4.4)", () => {
  const fact = (over: Partial<RunOutcomeFact> = {}): RunOutcomeFact => ({
    commandId: "cmd_1" as CommandId,
    status: "completed",
    costMicros: 10_000,
    inputTokens: 100,
    outputTokens: 20,
    submissions: 1,
    ...over,
  });

  it("says nothing has been observed rather than inventing a typical anything", () => {
    const aggregate = aggregateRunOutcomes({
      definitionId: "cmddef_1" as CommandDefinitionId,
      runs: [],
    });

    expect(aggregate.attempts).toBe(0);
    expect(aggregate.attemptsPerCompletion).toBeNull();
    expect(aggregate.cost.range).toBeNull();
    expect(aggregate.description).toContain("nothing has been observed");
  });

  it("keeps out-of-budget and interrupted out of the failure count (§3.6, principle 11)", () => {
    const aggregate = aggregateRunOutcomes({
      definitionId: "cmddef_1" as CommandDefinitionId,
      runs: [
        fact({ status: "failed" }),
        fact({ status: "out_of_budget" }),
        fact({ status: "interrupted" }),
        fact({ status: "completed" }),
      ],
    });

    expect(aggregate.byStatus).toEqual([
      { status: "completed", runs: 1 },
      { status: "failed", runs: 1 },
      { status: "out_of_budget", runs: 1 },
      { status: "interrupted", runs: 1 },
    ]);
  });

  it("counts attempts per completion over the commands that completed", () => {
    const aggregate = aggregateRunOutcomes({
      definitionId: "cmddef_1" as CommandDefinitionId,
      runs: [
        fact({ status: "failed" }),
        fact({ status: "failed" }),
        fact({ status: "completed" }),
        // A second command node that never completed contributes nothing to
        // "typically": an average over work that never worked is not typical.
        fact({ commandId: "cmd_2" as CommandId, status: "failed" }),
      ],
    });

    expect(aggregate.commands).toBe(2);
    expect(aggregate.attemptsPerCompletion).toBe(3);
  });

  it("prices from the same estimate the run preview uses", () => {
    const aggregate = aggregateRunOutcomes({
      definitionId: "cmddef_1" as CommandDefinitionId,
      inputTokens: 500,
      runs: [
        fact({ costMicros: 10_000 }),
        fact({ costMicros: 30_000 }),
        // A run whose runtime reported no cost is no evidence about money, so it
        // does not average a zero into the range.
        fact({ costMicros: 0 }),
      ],
    });

    expect(aggregate.cost.basis).toBe("prior-runs");
    expect(aggregate.cost.priorRuns).toBe(2);
    expect(aggregate.cost.range).toEqual({
      lowMicros: 10_000,
      highMicros: 30_000,
      medianMicros: 20_000,
    });
  });

  it("reports submission attempts, which is what §3.5's loop costs", () => {
    const aggregate = aggregateRunOutcomes({
      definitionId: "cmddef_1" as CommandDefinitionId,
      runs: [fact({ submissions: 3 }), fact({ submissions: 1 })],
    });

    expect(aggregate.submissions).toEqual({ total: 4, perRun: 2 });
  });
});
