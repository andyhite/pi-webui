/**
 * Run comparison and cross-run outcomes (spec §4.4, §8; §15-1 paying off).
 *
 * "Adjust → re-run → compare is the most-repeated action in context engineering,
 * and the product makes it first-class: compare two runs of the same command —
 * what went in, what came out, which model, what it cost. **Cross-run outcomes**
 * aggregate across many runs of the same definition — how many attempts it
 * typically takes, what usually fails, what it costs."
 *
 * Both halves are only possible because run history records the *whole* run
 * (§15-1). Nothing here re-derives anything from the current state of an object:
 * a comparison of two runs reads what each run recorded, which is why it keeps
 * working after the inputs have moved on — the case the invariant exists for.
 *
 * These are pure functions over recorded runs. The store supplies the rows and
 * the assembled bytes; the rules about what "the same" and "changed" mean live
 * here, so the endpoint and any later surface cannot answer differently
 * (principle 8).
 */

import type { CommandDefinitionId, CommandId } from "./ids.js";
import {
  estimateRunCost,
  formatMicros,
  type AssembledInput,
  type CostEstimate,
  type Run,
  type RunConfiguration,
  type RunOutput,
  type RunStatus,
  RUN_STATUSES,
} from "./runs.js";

/* ----------------------------------------------------------- comparing two runs */

/**
 * One run as comparison reads it: the recorded run plus what it produced and
 * where its assembled bytes are addressable.
 *
 * `assembledAddress` rather than the bytes themselves: the assembled content of
 * two runs is the largest thing in the comparison, a diff is derivable from the
 * two addresses, and a surface that wants the text asks for it. The hash is
 * carried on the run, so "did the input change" is answerable without either
 * fetch.
 */
export interface ComparableRun {
  readonly run: Run;
  readonly outputs: readonly RunOutput[];
  /** Where the exact bytes this run ran on can be read (§15-1). */
  readonly assembledAddress: string;
}

export const RUN_COMPARISON_REFUSALS = [
  /** §4.4 compares "two runs of the same command"; across definitions there is nothing to compare. */
  "different_definitions",
  /** Comparing a run with itself answers nothing and hides a client bug. */
  "same_run",
] as const;

export type RunComparisonRefusalReason =
  (typeof RUN_COMPARISON_REFUSALS)[number];

export interface RunComparisonRefusal {
  readonly reason: RunComparisonRefusalReason;
  readonly message: string;
}

/** How one input differs between the two runs, by ordinal position. */
export interface InputComparison {
  readonly ordinal: number;
  readonly objectId: string | null;
  /** Null when this run had no input at that position. */
  readonly left: AssembledInput | null;
  readonly right: AssembledInput | null;
  /**
   * `same` when the exact same version and bytes went in; `content` when the
   * object is the same but its version or content changed; `added`/`removed`
   * when only one run had it at all.
   */
  readonly change: "same" | "content" | "added" | "removed" | "replaced";
}

/** What differs about the configuration — "which model", and everything with it. */
export interface ConfigurationComparison {
  readonly field: string;
  readonly left: string;
  readonly right: string;
}

export interface OutputComparison {
  readonly name: string;
  readonly left: RunOutput | null;
  readonly right: RunOutput | null;
  readonly change: "same" | "different" | "added" | "removed";
}

export interface CostComparison {
  readonly leftMicros: number;
  readonly rightMicros: number;
  /** Right minus left: positive means the newer run cost more. */
  readonly deltaMicros: number;
  readonly description: string;
}

export interface RunComparison {
  readonly definitionId: CommandDefinitionId;
  readonly commandId: CommandId;
  readonly left: ComparableRun;
  readonly right: ComparableRun;
  readonly inputs: readonly InputComparison[];
  readonly configuration: readonly ConfigurationComparison[];
  readonly outputs: readonly OutputComparison[];
  readonly cost: CostComparison;
  /** True when the assembled bytes were identical — the same context, exactly. */
  readonly sameAssembledContent: boolean;
  readonly summary: string;
}

export type RunComparisonResult =
  | { readonly comparable: true; readonly comparison: RunComparison }
  | { readonly comparable: false; readonly refusal: RunComparisonRefusal };

/**
 * Compare two recorded runs.
 *
 * Runs of **different definitions are refused, with the reason** rather than
 * compared anyway: §4.4's gesture is "two runs of the same command", and a
 * side-by-side of two different recipes would invite reading a difference in
 * instruction as a difference in outcome. Two runs of the same *definition* in
 * different command nodes are comparable — that is the grain retention and cost
 * estimation already use, and the same recipe run in two workstreams is exactly
 * what "is this kind of work working?" asks about.
 */
export function compareRuns(
  left: ComparableRun,
  right: ComparableRun,
): RunComparisonResult {
  if (left.run.id === right.run.id) {
    return {
      comparable: false,
      refusal: {
        reason: "same_run",
        message: `${left.run.id} cannot be compared with itself`,
      },
    };
  }

  if (left.run.definitionId !== right.run.definitionId) {
    return {
      comparable: false,
      refusal: {
        reason: "different_definitions",
        message:
          `${left.run.id} ran ${left.run.configuration.definitionName} and ${right.run.id} ran ` +
          `${right.run.configuration.definitionName}; §4.4 compares two runs of the same command, and a ` +
          "side-by-side of two different recipes reads a difference in instruction as a difference in outcome",
      },
    };
  }

  const inputs = compareInputs(left.run.inputs, right.run.inputs);
  const configuration = compareConfiguration(
    left.run.configuration,
    right.run.configuration,
  );
  const outputs = compareOutputs(left.outputs, right.outputs);
  const cost = compareCost(left.run, right.run);
  const sameAssembledContent =
    left.run.assembledHash === right.run.assembledHash;

  return {
    comparable: true,
    comparison: {
      definitionId: left.run.definitionId,
      commandId: left.run.commandId,
      left,
      right,
      inputs,
      configuration,
      outputs,
      cost,
      sameAssembledContent,
      summary: summarize({
        inputs,
        configuration,
        outputs,
        cost,
        sameAssembledContent,
        left: left.run,
        right: right.run,
      }),
    },
  };
}

function compareInputs(
  left: readonly AssembledInput[],
  right: readonly AssembledInput[],
): readonly InputComparison[] {
  const count = Math.max(left.length, right.length);
  const comparisons: InputComparison[] = [];

  for (let index = 0; index < count; index += 1) {
    const a = left[index] ?? null;
    const b = right[index] ?? null;
    comparisons.push({
      ordinal: index + 1,
      objectId: b?.objectId ?? a?.objectId ?? null,
      left: a,
      right: b,
      change: inputChange(a, b),
    });
  }

  return comparisons;
}

function inputChange(
  left: AssembledInput | null,
  right: AssembledInput | null,
): InputComparison["change"] {
  if (left === null) return "added";
  if (right === null) return "removed";
  if (left.objectId !== right.objectId) return "replaced";
  if (
    left.versionId === right.versionId &&
    left.contentHash === right.contentHash
  ) {
    return "same";
  }
  return "content";
}

/**
 * The configuration fields §4.4 names ("which model") plus the rest of what a run
 * recorded, because a difference in instruction or effort explains a difference in
 * outcome just as often as the model does. Compared as text so a nested value
 * shows as one difference rather than being walked.
 */
function compareConfiguration(
  left: RunConfiguration,
  right: RunConfiguration,
): readonly ConfigurationComparison[] {
  const fields: readonly (readonly [
    string,
    (c: RunConfiguration) => unknown,
  ])[] = [
    ["definitionName", (c) => c.definitionName],
    ["instruction", (c) => c.instruction],
    ["model", (c) => c.model.model],
    ["effort", (c) => c.model.effort],
    ["permissions", (c) => c.permissions],
    ["askPoints", (c) => c.askPoints],
    ["lifecycle", (c) => c.lifecycle],
    ["outcome", (c) => c.outcome],
    ["parameters", (c) => c.parameters],
    ["contentBudget", (c) => c.budget],
  ];

  const differences: ConfigurationComparison[] = [];
  for (const [field, read] of fields) {
    const a = stringify(read(left));
    const b = stringify(read(right));
    if (a !== b) differences.push({ field, left: a, right: b });
  }
  return differences;
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function compareOutputs(
  left: readonly RunOutput[],
  right: readonly RunOutput[],
): readonly OutputComparison[] {
  const names = [
    ...new Set([...left.map((o) => o.name), ...right.map((o) => o.name)]),
  ].sort();

  return names.map((name) => {
    const a = left.find((output) => output.name === name) ?? null;
    const b = right.find((output) => output.name === name) ?? null;
    return { name, left: a, right: b, change: outputChange(a, b) };
  });
}

function outputChange(
  left: RunOutput | null,
  right: RunOutput | null,
): OutputComparison["change"] {
  if (left === null) return "added";
  if (right === null) return "removed";
  return left.versionId === right.versionId ? "same" : "different";
}

function compareCost(left: Run, right: Run): CostComparison {
  const leftMicros = left.cost.costMicros;
  const rightMicros = right.cost.costMicros;

  // A run whose runtime reported no cost is no evidence about money (§4.1), so
  // the comparison says that rather than reporting a delta against a zero.
  const description =
    leftMicros === 0 || rightMicros === 0
      ? "one of these runs recorded no cost, so there is nothing to compare about money"
      : `${formatMicros(leftMicros)} → ${formatMicros(rightMicros)}`;

  return {
    leftMicros,
    rightMicros,
    deltaMicros: rightMicros - leftMicros,
    description,
  };
}

function summarize(input: {
  readonly inputs: readonly InputComparison[];
  readonly configuration: readonly ConfigurationComparison[];
  readonly outputs: readonly OutputComparison[];
  readonly cost: CostComparison;
  readonly sameAssembledContent: boolean;
  readonly left: Run;
  readonly right: Run;
}): string {
  const changedInputs = input.inputs.filter((one) => one.change !== "same");
  const parts = [
    `run ${input.left.ordinal} (${input.left.status}) vs run ${input.right.ordinal} (${input.right.status})`,
    // Three cases, not two. The assembled bytes carry the definition's
    // instruction and its parameter values as well as the inputs
    // (`assembleRunBody`), so two runs can differ in what was sent while every
    // input is identical — which is §4.4's headline gesture: adjust the
    // instruction, run it again, compare. Reported as "0 of 1 inputs differ",
    // that reads as a comparison that found nothing.
    input.sameAssembledContent
      ? "the same assembled content, byte for byte"
      : changedInputs.length === 0
        ? "the same inputs, but the assembled content differs"
        : `${changedInputs.length} of ${input.inputs.length} inputs differ`,
  ];
  if (input.configuration.length > 0) {
    parts.push(
      `configuration differs in ${input.configuration.map((one) => one.field).join(", ")}`,
    );
  }
  parts.push(input.cost.description);
  return parts.join("; ");
}

/* ------------------------------------------------ cross-run outcomes (§4.4, §8) */

/** One run as the aggregate reads it. Only what the rule needs. */
export interface RunOutcomeFact {
  readonly commandId: CommandId;
  readonly status: RunStatus;
  readonly costMicros: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** How many times the session submitted before the run settled (§3.5). */
  readonly submissions: number;
}

export interface RunStatusCount {
  readonly status: RunStatus;
  readonly runs: number;
}

export interface RunOutcomeAggregate {
  readonly definitionId: CommandDefinitionId;
  /** Every retained run of this definition (§4.4's retention bounds this). */
  readonly attempts: number;
  /** The end-state histogram — "what usually fails", as counts, not a guess. */
  readonly byStatus: readonly RunStatusCount[];
  /**
   * "How many attempts it typically takes": runs per command node that reached a
   * proven completion, averaged over the command nodes that reached one. Null
   * when none has — an average over zero completions is not a typical anything.
   */
  readonly attemptsPerCompletion: number | null;
  /** How many command nodes this definition has ever run in. */
  readonly commands: number;
  /**
   * The same estimate the run preview shows, from the same function: cross-run
   * cost and pre-run cost cannot disagree, because there is one of them (§4.1).
   */
  readonly cost: CostEstimate;
  /** Submission attempts per run, where any were recorded (§3.5's loop). */
  readonly submissions: {
    readonly total: number;
    readonly perRun: number | null;
  };
  readonly description: string;
}

/**
 * Aggregate across many runs of one definition (§4.4).
 *
 * Per **definition** rather than per command node, matching retention's grain and
 * cost estimation's: "the same recipe run in two workstreams is the same evidence
 * about what it costs" — and about whether it works.
 *
 * The histogram is counts of recorded statuses and nothing more. Out-of-budget and
 * interrupted are their own rows, never folded into `failed`: reporting a stop for
 * money or a restart as a failure is what would make "is delegating this kind of
 * work actually working?" answer wrong (§3.6, principle 11).
 */
export function aggregateRunOutcomes(input: {
  readonly definitionId: CommandDefinitionId;
  readonly runs: readonly RunOutcomeFact[];
  /** What a next run would assemble, for the estimate's input-size half. */
  readonly inputTokens?: number;
}): RunOutcomeAggregate {
  const runs = input.runs;
  const counts = new Map<RunStatus, number>();
  for (const run of runs) {
    counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  }

  const byStatus = RUN_STATUSES.filter((status) => counts.has(status)).map(
    (status) => ({ status, runs: counts.get(status) ?? 0 }),
  );

  const perCommand = new Map<string, { runs: number; completed: boolean }>();
  for (const run of runs) {
    const entry = perCommand.get(run.commandId) ?? {
      runs: 0,
      completed: false,
    };
    perCommand.set(run.commandId, {
      runs: entry.runs + 1,
      completed: entry.completed || run.status === "completed",
    });
  }

  const completing = [...perCommand.values()].filter((one) => one.completed);
  const attemptsPerCompletion =
    completing.length === 0
      ? null
      : round(
          completing.reduce((total, one) => total + one.runs, 0) /
            completing.length,
        );

  const submissionTotal = runs.reduce(
    (total, run) => total + run.submissions,
    0,
  );

  const cost = estimateRunCost({
    inputTokens: input.inputTokens ?? 0,
    priorRuns: runs.map((run) => ({
      costMicros: run.costMicros,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
    })),
  });

  return {
    definitionId: input.definitionId,
    attempts: runs.length,
    byStatus,
    attemptsPerCompletion,
    commands: perCommand.size,
    cost,
    submissions: {
      total: submissionTotal,
      perRun: runs.length === 0 ? null : round(submissionTotal / runs.length),
    },
    description: describeOutcomes(
      runs.length,
      byStatus,
      attemptsPerCompletion,
      cost,
    ),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function describeOutcomes(
  attempts: number,
  byStatus: readonly RunStatusCount[],
  attemptsPerCompletion: number | null,
  cost: CostEstimate,
): string {
  if (attempts === 0) {
    return "no retained runs of this definition; nothing has been observed about it yet";
  }

  const outcomes = byStatus
    .map((entry) => `${entry.runs} ${entry.status}`)
    .join(", ");
  const typical =
    attemptsPerCompletion === null
      ? "nothing has completed yet"
      : `typically ${attemptsPerCompletion} ${attemptsPerCompletion === 1 ? "attempt" : "attempts"} to complete`;

  return `${attempts} retained ${attempts === 1 ? "run" : "runs"} (${outcomes}); ${typical}; ${cost.description}`;
}
