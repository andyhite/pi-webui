import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_COMPACTION_POLICY,
  DEFAULT_RUN_RETENTION_POLICY,
  humanAuthor,
  type CommandId,
} from "@plotroom/core";
import {
  makeRenderings,
  manualClock,
  type ManualClock,
} from "@plotroom/core/testing";
import { BlobStore } from "./blob-store.js";
import { openDatabase, type PlotroomDatabase } from "./client.js";
import { CommandStore } from "./command-store.js";
import { GraphStore } from "./graph-store.js";
import { ObjectStore } from "./object-store.js";
import { RunRefused, RunStore } from "./run-store.js";
import { WorkstreamStore } from "./workstream-store.js";

let dir: string;
let state: PlotroomDatabase;
let clock: ManualClock;
let runs: RunStore;
let commands: CommandStore;
let graph: GraphStore;
let objects: ObjectStore;
let workstreamId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-runs-"));
  state = openDatabase({ stateDir: dir });
  clock = manualClock();
  runs = new RunStore(state, clock.now);
  commands = new CommandStore(state, clock.now);
  graph = new GraphStore(state, clock.now);
  objects = new ObjectStore(state, clock.now);
  workstreamId = new WorkstreamStore(state, clock.now).create({
    author: humanAuthor,
  }).id;
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

function define(overrides: Record<string, unknown> = {}) {
  return commands.define({
    name: "Implement the ticket",
    instruction: "Implement it and open a pull request.",
    model: "fixture-model",
    effort: "medium",
    lifecycle: "producing",
    outcome: { name: "pull_request", kind: "pull_request", conditions: [] },
    ...overrides,
  });
}

/** A command node with `titles` wired in, in that assembly order (§3.5). */
function wired(contents: readonly string[], definitionId?: string) {
  const instance = commands.instantiate({
    definitionId: definitionId ?? define().id,
    workstreamId,
    author: humanAuthor,
  });

  for (const [index, content] of contents.entries()) {
    const object = objects.write({
      kind: "note",
      title: `note ${index + 1}`,
      renderings: makeRenderings({ agentContent: content }),
      workstreamId,
    });
    const node = graph.place({
      role: "content",
      refId: object.objectId,
      workstreamId,
    });
    graph.addContextEdge({
      from: node.id,
      to: instance.node.id,
      author: humanAuthor,
    });
  }

  return instance;
}

/** Something a run produced, as an object with a version. */
function produced(title = "PR") {
  const written = objects.write({
    kind: "pull_request",
    title,
    renderings: makeRenderings({ agentContent: title }),
    workstreamId,
  });
  return { name: "pull_request", ...written };
}

describe("§15 invariant 1: run history records full content and configuration", () => {
  it("stores the exact assembled content, in edge order", () => {
    const command = wired(["first input", "second input"]);

    const { run } = runs.start({ commandId: command.command.id });

    const content = runs.assembledContent(run.id);
    expect(content.indexOf("first input")).toBeLessThan(
      content.indexOf("second input"),
    );
    expect(run.inputs.map((each) => each.ordinal)).toEqual([1, 2]);
  });

  it("stores the configuration it ran under, not the definition as it reads now", () => {
    const definition = define();
    const command = wired(["input"], definition.id);
    const { run } = runs.start({ commandId: command.command.id });

    commands.edit(definition.id, { instruction: "Completely different now." });

    expect(runs.configuration(run.id).instruction).toBe(
      "Implement it and open a pull request.",
    );
    expect(runs.configuration(run.id).model).toEqual({
      model: "fixture-model",
      effort: "medium",
    });
    expect(runs.configuration(run.id).askPoints).toContain(
      "irreversible_write",
    );
  });

  it("cannot record a run without assembled content or configuration", () => {
    const command = wired(["input"]);
    const definitionId = commands.command(command.command.id).definitionId;

    expect(() =>
      state.sqlite
        .prepare(
          `INSERT INTO runs (id, command_id, definition_id, ordinal, status, assembled_hash, assembled_bytes, config_json)
           VALUES ('run_x', ?, ?, 99, 'running', 'h', 1, '{}')`,
        )
        .run(command.command.id, definitionId),
    ).toThrow(/NOT NULL constraint failed: runs.assembled_blob_id/);

    expect(() =>
      state.sqlite
        .prepare(
          `INSERT INTO runs (id, command_id, definition_id, ordinal, status, assembled_blob_id, assembled_hash, assembled_bytes)
           VALUES ('run_y', ?, ?, 98, 'running', 'blob_none', 'h', 1)`,
        )
        .run(command.command.id, definitionId),
    ).toThrow(/NOT NULL constraint failed: runs.config_json/);
  });

  it("still answers with the original content after its inputs change", () => {
    const external = { system: "jira", id: "OXY-2982" };
    const instance = commands.instantiate({
      definitionId: define().id,
      workstreamId,
      author: humanAuthor,
    });
    const ticket = objects.write({
      kind: "ticket",
      title: "OXY-2982",
      renderings: makeRenderings({ agentContent: "the original input" }),
      external,
    });
    graph.addContextEdge({
      from: graph.place({ role: "content", refId: ticket.objectId }).id,
      to: instance.node.id,
      author: humanAuthor,
    });

    const { run } = runs.start({ commandId: instance.command.id });

    // The ticket is re-read and has changed: a new version of the same object.
    const rewritten = objects.write({
      kind: "ticket",
      title: "OXY-2982",
      renderings: makeRenderings({ agentContent: "rewritten entirely" }),
      external,
    });
    expect(rewritten.objectId).toBe(ticket.objectId);
    expect(rewritten.versionId).not.toBe(ticket.versionId);

    expect(runs.assembledContent(run.id)).toContain("the original input");
    expect(runs.assembledContent(run.id)).not.toContain("rewritten entirely");
    expect(run.inputs[0]?.versionId).toBe(ticket.versionId);
  });

  it("survives version compaction and blob compaction untouched", () => {
    const command = wired(["content a run consumed"]);
    const { run } = runs.start({ commandId: command.command.id });

    clock.advance(DEFAULT_COMPACTION_POLICY.windowSeconds + 1);
    objects.compactVersions();
    new BlobStore(state, clock.now).compact();

    expect(runs.assembledContent(run.id)).toContain("content a run consumed");
    expect(runs.run(run.id).inputs).toHaveLength(1);
  });

  it("marks consumed versions run-referenced so compaction skips them", () => {
    const command = wired(["consumed"]);
    const { run } = runs.start({ commandId: command.command.id });
    const versionId = run.inputs[0]!.versionId;

    const version = objects
      .versions(run.inputs[0]!.objectId)
      .find((each) => each.id === versionId);

    expect(version?.runReferenced).toBe(true);
  });

  it("refuses to delete a version a run consumed, whatever asks", () => {
    const command = wired(["consumed"]);
    const { run } = runs.start({ commandId: command.command.id });

    expect(() =>
      state.sqlite
        .prepare("DELETE FROM object_versions WHERE id = ?")
        .run(run.inputs[0]!.versionId),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe("§15 invariant 4: per-run output addressing", () => {
  function threeRuns() {
    const command = wired(["input"]);
    const addresses: string[] = [];

    for (let n = 1; n <= 3; n += 1) {
      const { run } = runs.start({ commandId: command.command.id });
      const output = produced(`PR ${n}`);
      runs.complete(run.id, {
        outputs: [
          {
            name: "pull_request",
            objectId: output.objectId,
            versionId: output.versionId,
          },
        ],
      });
      addresses.push(output.objectId);
    }

    return { commandId: command.command.id as CommandId, addresses };
  }

  it("addresses each run's output by its ordinal", () => {
    const { commandId, addresses } = threeRuns();

    for (const [index, objectId] of addresses.entries()) {
      expect(
        runs.resolve({
          commandId,
          name: "pull_request",
          at: "ordinal",
          runOrdinal: index + 1,
        })?.objectId,
      ).toBe(objectId);
    }
  });

  it("derives latest rather than storing it", () => {
    const { commandId, addresses } = threeRuns();

    expect(
      runs.resolve({ commandId, name: "pull_request", at: "latest" })?.objectId,
    ).toBe(addresses[2]);

    // No column anywhere records which run is latest; it is a query.
    const columns = state.sqlite
      .prepare<[], { name: string }>("PRAGMA table_info(runs)")
      .all()
      .map((row) => row.name)
      .concat(
        state.sqlite
          .prepare<[], { name: string }>("PRAGMA table_info(run_outputs)")
          .all()
          .map((row) => row.name),
      );

    expect(columns.some((name) => name.includes("latest"))).toBe(false);
  });

  it("never rewrites what an earlier ordinal means when a new run lands", () => {
    const { commandId, addresses } = threeRuns();
    const before = runs.resolve({
      commandId,
      name: "pull_request",
      at: "ordinal",
      runOrdinal: 1,
    });

    const { run } = runs.start({ commandId });
    const fourth = produced("PR 4");
    runs.complete(run.id, {
      outputs: [
        {
          name: "pull_request",
          objectId: fourth.objectId,
          versionId: fourth.versionId,
        },
      ],
    });

    expect(
      runs.resolve({
        commandId,
        name: "pull_request",
        at: "ordinal",
        runOrdinal: 1,
      }),
    ).toEqual(before);
    expect(before?.objectId).toBe(addresses[0]);
    expect(
      runs.resolve({ commandId, name: "pull_request", at: "latest" })?.objectId,
    ).toBe(fourth.objectId);
  });

  it("addresses a pinned run directly, however many runs follow it", () => {
    const { commandId } = threeRuns();
    const first = runs.history(commandId)[0]!;
    runs.pin(first.id);

    expect(
      runs.resolve({
        commandId,
        name: "pull_request",
        at: "pinned",
        runId: first.id,
      })?.runId,
    ).toBe(first.id);
  });

  it("answers null for an address nothing has produced", () => {
    const command = wired(["input"]);

    expect(
      runs.resolve({
        commandId: command.command.id as CommandId,
        name: "pull_request",
        at: "latest",
      }),
    ).toBeNull();
  });
});

describe("starting a run refuses rather than degrades (§3.5)", () => {
  it("refuses to run a deleted command until it is restored (principle 10)", () => {
    const command = wired(["input"]);
    commands.delete(command.command.id);

    expect(() => runs.start({ commandId: command.command.id })).toThrow(
      RunRefused,
    );
    expect(runs.history(command.command.id)).toHaveLength(0);

    commands.restore(command.command.id);

    expect(runs.start({ commandId: command.command.id }).run.ordinal).toBe(1);
  });

  it("refuses while a derived default is still a proposal", () => {
    const definition = define({
      parameters: [
        { name: "repo", label: "Repository", type: "text", required: true },
      ],
    });
    const command = wired(["input"], definition.id);
    commands.proposeDefault(command.command.id, "repo", "plotroom", "subject");

    expect(() => runs.start({ commandId: command.command.id })).toThrow(
      /a derived default is a proposal, not a value/,
    );
  });

  it("refuses over an opt-in hard cap rather than truncating", () => {
    const definition = define({
      budget: {
        modelWindowTokens: 1_000_000,
        warnAtFraction: 0.85,
        hardCapTokens: 1,
      },
    });
    const command = wired(
      ["a long enough input to exceed one token"],
      definition.id,
    );

    expect(() => runs.start({ commandId: command.command.id })).toThrow(
      /hard cap/,
    );
  });

  it("warns without refusing as content approaches the window", () => {
    const definition = define({
      budget: {
        modelWindowTokens: 10,
        warnAtFraction: 0.1,
        hardCapTokens: null,
      },
    });
    const command = wired(["some input"], definition.id);

    expect(runs.start({ commandId: command.command.id }).warning).toContain(
      "close to the model's",
    );
  });

  it("blocks on a placeholder nothing has produced yet (§3.5)", () => {
    const upstream = commands.instantiate({
      definitionId: define().id,
      workstreamId,
      author: humanAuthor,
    });
    const downstream = commands.instantiate({
      definitionId: define({ name: "downstream" }).id,
      workstreamId,
      author: humanAuthor,
    });
    graph.addContextEdge({
      from: graph.nodeFor("content", upstream.outputs[0]!.id).id,
      to: downstream.node.id,
      author: humanAuthor,
    });

    expect(() => runs.start({ commandId: downstream.command.id })).toThrow(
      RunRefused,
    );
  });
});

describe("ending a run (§3.5, §3.6)", () => {
  it("rejects a submission whose world conditions fail and keeps the run open", () => {
    const definition = define({
      outcome: {
        name: "pull_request",
        kind: "pull_request",
        conditions: [
          { id: "ci", predicate: "checks_green", description: "checks green" },
        ],
      },
    });
    const command = wired(["input"], definition.id);
    const { run } = runs.start({ commandId: command.command.id });

    const result = runs.complete(run.id, {
      evaluations: [{ conditionId: "ci", holds: false, detail: "lint failed" }],
    });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.feedback).toContain("lint failed");
    expect(runs.run(run.id).status).toBe("running");
  });

  it("records proof once and never re-ends a finished run", () => {
    const command = wired(["input"]);
    const { run } = runs.start({ commandId: command.command.id });
    runs.complete(run.id);

    const proof = runs.proof(run.id);
    expect(proof?.provenAt).toBe(clock.now());
    expect(() => runs.complete(run.id)).toThrow(/already ended/);
    expect(runs.proof(run.id)).toEqual(proof);
  });

  it("records an out-of-budget stop as its own outcome, not a failure", () => {
    const command = wired(["input"]);
    const { run } = runs.start({ commandId: command.command.id });

    expect(runs.stopOutOfBudget(run.id).status).toBe("out_of_budget");
  });

  it("records what it cost", () => {
    const command = wired(["input"]);
    const { run } = runs.start({ commandId: command.command.id });
    runs.complete(run.id, {
      cost: { inputTokens: 10, outputTokens: 20, costMicros: 4200 },
    });

    expect(runs.run(run.id).cost).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      costMicros: 4200,
    });
  });

  it("binds the command's placeholder output to what was produced (§3.5)", () => {
    const command = wired(["input"]);
    const { run } = runs.start({ commandId: command.command.id });
    const output = produced();

    runs.complete(run.id, {
      outputs: [
        {
          name: "pull_request",
          objectId: output.objectId,
          versionId: output.versionId,
        },
      ],
    });

    const placeholder = commands.outputs(command.command.id)[0]!;
    expect(placeholder.boundObjectId).toBe(output.objectId);
    expect(placeholder.boundRunId).toBe(run.id);
    expect(commands.bindState(placeholder.id)).toBe("post_bind");
  });
});

describe("run-history retention (§4.4)", () => {
  function manyRuns(count: number, commandId: string) {
    const ids: string[] = [];
    for (let n = 0; n < count; n += 1) {
      const { run } = runs.start({ commandId });
      runs.complete(run.id);
      ids.push(run.id);
      clock.advance(60);
    }
    return ids;
  }

  const policy = { keepPerDefinition: 2, windowSeconds: 100 };

  it("keeps the last N per definition, the window, and pinned runs", () => {
    const command = wired(["input"]);
    const ids = manyRuns(5, command.command.id);
    runs.pin(ids[0]!);
    clock.advance(policy.windowSeconds + 1);

    const { removed } = runs.compactRuns(policy);

    const remaining = runs.history(command.command.id).map((each) => each.id);
    expect(removed).toBeGreaterThan(0);
    expect(remaining).toContain(ids[0]); // pinned
    expect(remaining).toContain(ids[4]); // latest
    expect(remaining).toHaveLength(5 - removed);
  });

  it("never compacts the run an address still resolves to", () => {
    const command = wired(["input"]);
    const ids = manyRuns(5, command.command.id);
    clock.advance(policy.windowSeconds + 1);

    runs.compactRuns(policy);

    expect(runs.history(command.command.id).map((each) => each.id)).toContain(
      ids[4],
    );
  });

  it("keeps an old run that `latest` still resolves to for its output name", () => {
    // The output name matches no declared placeholder, so nothing is bound to
    // this run and it is not the newest run of its command. `latest` for that
    // name still points at it, so retention must leave it alone — an address
    // that answers null after compaction is the failure the rule forbids.
    const command = wired(["input"]);
    const commandId = command.command.id as CommandId;

    const holder = runs.start({ commandId }).run;
    const side = produced("a side note");
    runs.complete(holder.id, {
      outputs: [
        {
          name: "side_note",
          objectId: side.objectId,
          versionId: side.versionId,
        },
      ],
    });
    clock.advance(60);

    // Five later runs, none of which produce `side_note`.
    manyRuns(5, commandId);
    clock.advance(policy.windowSeconds + 1);

    const before = runs.resolve({
      commandId,
      name: "side_note",
      at: "latest",
    });
    expect(before?.runId).toBe(holder.id);
    expect(commands.outputs(commandId).map((each) => each.name)).not.toContain(
      "side_note",
    );

    const { removed } = runs.compactRuns(policy);

    expect(removed).toBeGreaterThan(0);
    expect(
      runs.resolve({ commandId, name: "side_note", at: "latest" }),
    ).toEqual(before);
  });

  it("keeps everything inside the window, however far past N", () => {
    const command = wired(["input"]);
    // Five runs, 60 seconds apart, all comfortably inside a wide window.
    manyRuns(5, command.command.id);

    expect(
      runs.compactRuns({ keepPerDefinition: 2, windowSeconds: 10_000 }),
    ).toEqual({ removed: 0 });
    expect(runs.history(command.command.id)).toHaveLength(5);
  });

  it("keeps everything by default, which is a deliberate N", () => {
    expect(DEFAULT_RUN_RETENTION_POLICY.keepPerDefinition).toBe(20);
    expect(DEFAULT_RUN_RETENTION_POLICY.windowSeconds).toBe(30 * 24 * 60 * 60);
  });

  it("releases versions no surviving run references", () => {
    const command = wired(["input"]);
    const ids = manyRuns(5, command.command.id);
    clock.advance(policy.windowSeconds + 1);
    const versionId = runs.run(ids[1]!).inputs[0]!.versionId;

    runs.compactRuns(policy);

    // The same version fed every run here, so a surviving run still holds it.
    const objectId = runs.run(ids[4]!).inputs[0]!.objectId;
    const version = objects
      .versions(objectId)
      .find((each) => each.id === versionId);
    expect(version?.runReferenced).toBe(true);
  });

  it("pins everything a pinned run references (§4.4)", () => {
    const command = wired(["input"]);
    const { run } = runs.start({ commandId: command.command.id });

    runs.pin(run.id);

    const version = objects
      .versions(runs.run(run.id).inputs[0]!.objectId)
      .find((each) => each.id === runs.run(run.id).inputs[0]!.versionId);
    expect(version?.pinned).toBe(true);
  });
});
