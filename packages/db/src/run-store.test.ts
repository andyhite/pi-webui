import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { removeStateDir } from "./remove-state-dir.js";
import {
  humanAuthor,
  DEFAULT_COMPACTION_POLICY,
  DEFAULT_RUN_RETENTION_POLICY,
  INHERIT_APP_TOOLS,
  type CommandId,
  type ObjectId,
  type RunId,
  type VersionId,
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
import { SessionStore } from "./session-store.js";
import { StandingInstructionStore } from "./standing-instruction-store.js";
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
  removeStateDir(dir);
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

/**
 * A session for the initiation rows to point at. `run_initiations.session_id`
 * is a real foreign key, so a settled claim cannot name a session that never
 * existed — the same reason `run_inputs.version_id` is one (§15-1).
 */
function session() {
  return new SessionStore(state, clock.now).start({
    workstreamId,
    mode: "open",
    launch: {
      model: "fixture-model",
      effort: "medium",
      toolPermissions: INHERIT_APP_TOOLS,
    },
    initiatedBy: humanAuthor,
    runtime: { adapterId: "scripted", ref: "native-1" },
  }).session;
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
    expect(run.inputs[0]?.versionId).toBe(ticket.versionId as VersionId);
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
      ).toBe(objectId as ObjectId);
    }
  });

  it("derives latest rather than storing it", () => {
    const { commandId, addresses } = threeRuns();

    expect(
      runs.resolve({ commandId, name: "pull_request", at: "latest" })?.objectId,
    ).toBe(addresses[2] as ObjectId);

    // No column anywhere records which run is latest; it is a query.
    const columns = state.sqlite
      .prepare<{ name: string }, []>("PRAGMA table_info(runs)")
      .all()
      .map((row) => row.name)
      .concat(
        state.sqlite
          .prepare<{ name: string }, []>("PRAGMA table_info(run_outputs)")
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
    expect(before?.objectId).toBe(addresses[0] as ObjectId);
    expect(
      runs.resolve({ commandId, name: "pull_request", at: "latest" })?.objectId,
    ).toBe(fourth.objectId as ObjectId);
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
    expect(placeholder.boundObjectId).toBe(output.objectId as ObjectId);
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
    expect(remaining).toContain(ids[0] as RunId); // pinned
    expect(remaining).toContain(ids[4] as RunId); // latest
    expect(remaining).toHaveLength(5 - removed);
  });

  it("never compacts the run an address still resolves to", () => {
    const command = wired(["input"]);
    const ids = manyRuns(5, command.command.id);
    clock.advance(policy.windowSeconds + 1);

    runs.compactRuns(policy);

    expect(runs.history(command.command.id).map((each) => each.id)).toContain(
      ids[4] as RunId,
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

describe("idempotent initiation (principle 9)", () => {
  it("hands a retry the settled claim, and refuses a key reused elsewhere", () => {
    const command = wired(["input"]);
    const other = wired(["input"]);

    expect(runs.claimInitiation("gesture", command.command.id).state).toBe(
      "claimed",
    );

    const { run } = runs.start({ commandId: command.command.id });
    runs.settleInitiation("gesture", run.id, session().id);

    const replay = runs.claimInitiation("gesture", command.command.id);
    expect(replay.state).toBe("settled");
    expect(replay.state === "settled" ? replay.initiation.runId : null).toBe(
      run.id,
    );

    expect(() => runs.claimInitiation("gesture", other.command.id)).toThrow(
      RunRefused,
    );
  });

  it("frees a claim no attempt can still hold, and keeps settled ones", () => {
    const command = wired(["input"]);
    const { run } = runs.start({ commandId: command.command.id });

    runs.claimInitiation("settled-gesture", command.command.id);
    runs.settleInitiation("settled-gesture", run.id, session().id);
    // A process that died between claiming and settling leaves this behind; it
    // would otherwise refuse that gesture forever.
    runs.claimInitiation("stranded-gesture", command.command.id);

    expect(runs.releaseUnsettledInitiations()).toEqual(["stranded-gesture"]);

    expect(runs.initiation("stranded-gesture")).toBeUndefined();
    expect(runs.initiation("settled-gesture")?.runId).toBe(run.id);
    // Idempotent: a second boot finds nothing left to free.
    expect(runs.releaseUnsettledInitiations()).toEqual([]);
  });
});

describe("the content-budget verdict is recomputed, never remembered (§15-1)", () => {
  it("gives a finished run the same warning it started with", () => {
    const definition = define({
      budget: {
        modelWindowTokens: 40,
        warnAtFraction: 0.5,
        hardCapTokens: null,
      },
    });
    const command = wired(["x".repeat(400)], definition.id);

    const { run, warning } = runs.start({ commandId: command.command.id });

    expect(warning).toMatch(/close to the model's 40-token/);
    // Both inputs are on the run (§15-1), so the answer is the run's own, not a
    // second opinion about it — and it survives the definition being edited.
    commands.edit(definition.id, {
      budget: {
        modelWindowTokens: 1_000_000,
        warnAtFraction: 0.99,
        hardCapTokens: null,
      },
    });

    expect(runs.assemblyWarning(run.id)).toBe(warning);
    expect(runs.contentBudget(run.id).state).toBe("warn");
  });

  it("reports no warning for a run that was comfortably inside the window", () => {
    const command = wired(["short input"]);
    const { run, warning } = runs.start({ commandId: command.command.id });

    expect(warning).toBeNull();
    expect(runs.assemblyWarning(run.id)).toBeNull();
    expect(runs.contentBudget(run.id).state).toBe("ok");
  });
});

describe("the run preview (§4.1)", () => {
  it("says exactly what would execute, and records nothing", () => {
    const command = wired(["first input", "second input"]);

    const preview = runs.preview(command.command.id);

    expect(preview.runnable).toBe(true);
    expect(preview.inputs.map((each) => each.ordinal)).toEqual([1, 2]);
    expect(preview.body.indexOf("first input")).toBeLessThan(
      preview.body.indexOf("second input"),
    );
    expect(preview.bytes).toBe(Buffer.byteLength(preview.body, "utf8"));
    expect(preview.estimatedTokens).toBeGreaterThan(0);
    expect(preview.nextOrdinal).toBe(1);
    expect(preview.configuration?.instruction).toBe(
      "Implement it and open a pull request.",
    );

    // A preview is a read: no run exists afterwards, and the next run still
    // takes ordinal 1.
    expect(runs.history(command.command.id)).toHaveLength(0);
    expect(runs.start({ commandId: command.command.id }).run.ordinal).toBe(1);
  });

  it("is byte-identical to what the run then records (§15-1)", () => {
    const command = wired(["what the agent will read"]);

    const preview = runs.preview(command.command.id);
    const { run } = runs.start({ commandId: command.command.id });

    expect(runs.assembledContent(run.id)).toBe(preview.body);
    expect(run.inputs.map((each) => each.versionId)).toEqual(
      preview.inputs.map((each) => each.versionId),
    );
  });

  it("reports every blocker instead of refusing, and says it is not runnable", () => {
    const definition = define({
      parameters: [
        { name: "repo", label: "Repository", type: "text", required: true },
      ],
    });
    const command = wired(["input"], definition.id);
    commands.proposeDefault(
      command.command.id,
      "repo",
      "guessed",
      "the target",
    );

    const preview = runs.preview(command.command.id);

    expect(preview.runnable).toBe(false);
    expect(preview.configuration).toBeNull();
    expect(preview.blockers.map((each) => each.reason)).toEqual([
      "parameters_unconfirmed",
    ]);
    // The same command refuses to start, with the reason the preview showed.
    expect(() => runs.start({ commandId: command.command.id })).toThrow(
      RunRefused,
    );
  });

  it("reports a content budget refusal as a blocker, not as a truncation", () => {
    const definition = define({
      budget: { modelWindowTokens: 100, warnAtFraction: 0.5, hardCapTokens: 5 },
    });
    const command = wired(["y".repeat(400)], definition.id);

    const preview = runs.preview(command.command.id);

    expect(preview.runnable).toBe(false);
    expect(preview.budget.state).toBe("refused");
    expect(preview.blockers.map((each) => each.reason)).toEqual([
      "content_budget",
    ]);
    // The content is still reported whole: the preview shows what was asked
    // for, so removing an input is a decision the operator can make.
    expect(preview.body).toContain("y".repeat(400));
  });

  it("prices from this definition's history once there is some", () => {
    const definition = define();
    const first = wired(["input"], definition.id);
    const second = wired(["input"], definition.id);

    expect(runs.preview(first.command.id).estimate.basis).toBe(
      "input-size-only",
    );

    const one = runs.start({ commandId: first.command.id });
    runs.complete(one.run.id, {
      cost: { inputTokens: 100, outputTokens: 20, costMicros: 40_000 },
    });
    const two = runs.start({ commandId: second.command.id });
    runs.complete(two.run.id, {
      cost: { inputTokens: 90, outputTokens: 10, costMicros: 20_000 },
    });

    const estimate = runs.preview(first.command.id).estimate;
    expect(estimate.basis).toBe("prior-runs");
    expect(estimate.priorRuns).toBe(2);
    expect(estimate.range).toEqual({
      lowMicros: 20_000,
      highMicros: 40_000,
      medianMicros: 30_000,
    });
    expect(estimate.description).toMatch(/based on 2 prior runs/);
  });

  it("records the spend cap the operator accepted (§4.1, §8)", () => {
    const command = wired(["input"]);

    const { run } = runs.start({
      commandId: command.command.id,
      spendCapMicros: 250_000,
    });

    expect(run.spendCapMicros).toBe(250_000);
    expect(runs.run(run.id).spendCapMicros).toBe(250_000);
    // No cap accepted is null, never zero: zero would read as "spend nothing".
    const other = runs.start({ commandId: wired(["input"]).command.id });
    expect(other.run.spendCapMicros).toBeNull();
  });
});

describe("standing instructions in assembly (§3.8)", () => {
  /** A world-scoped note, marked standing, and what it says. */
  function standing(body: string, title = "House rules") {
    const object = objects.write({
      kind: "note",
      title,
      renderings: makeRenderings({ agentContent: body }),
    });
    const declared = standingStore().declare({
      objectId: object.objectId,
      by: humanAuthor,
    });
    if (!declared.ok) throw new Error(declared.refusal.message);
    return declared.value;
  }

  const standingStore = () => new StandingInstructionStore(state, clock.now);

  it("assembles nothing extra until the workstream opts in (principle 6)", () => {
    standing("This repository uses pnpm, never npm.");
    const command = wired(["the ticket"]);

    const plan = runs.plan(command.command.id);
    expect(plan.inputs).toHaveLength(1);
    expect(plan.body).not.toContain("pnpm");
  });

  it("prepends the opted-in instructions before the wired inputs", () => {
    const first = standing("This repository uses pnpm, never npm.", "Rule one");
    clock.advance(1);
    const second = standing("Never touch the generated directory.", "Rule two");
    const store = standingStore();
    // Opted in newest-first: the resolution's order is the answer, not row order.
    store.optIn({
      workstreamId,
      instructionId: second.id,
      by: humanAuthor,
    });
    store.optIn({ workstreamId, instructionId: first.id, by: humanAuthor });

    const command = wired(["the ticket"]);
    const { run } = runs.start({ commandId: command.command.id });
    const content = runs.assembledContent(run.id);

    expect(content.indexOf("pnpm")).toBeLessThan(
      content.indexOf("generated directory"),
    );
    expect(content.indexOf("generated directory")).toBeLessThan(
      content.indexOf("the ticket"),
    );
    // §15-1: the run recorded every input it saw, standing ones included, with
    // the version each was read at — and no node, because none was drawn.
    expect(run.inputs.map((each) => each.ordinal)).toEqual([1, 2, 3]);
    expect(run.inputs.slice(0, 2).map((each) => each.nodeId)).toEqual([
      null,
      null,
    ]);
    expect(run.inputs[0]?.versionId).not.toBe("");
  });

  it("stops assembling one that was retired or opted out of", () => {
    const instruction = standing("This repository uses pnpm, never npm.");
    const store = standingStore();
    store.optIn({
      workstreamId,
      instructionId: instruction.id,
      by: humanAuthor,
    });
    const command = wired(["the ticket"]);
    expect(runs.plan(command.command.id).body).toContain("pnpm");

    store.optOut(workstreamId, instruction.id);
    expect(runs.plan(command.command.id).body).not.toContain("pnpm");

    store.optIn({
      workstreamId,
      instructionId: instruction.id,
      by: humanAuthor,
    });
    store.retire(instruction.id, humanAuthor);
    expect(runs.plan(command.command.id).body).not.toContain("pnpm");
  });

  it("counts toward the content budget the run is checked against (§3.5)", () => {
    const instruction = standing("x".repeat(40_000));
    standingStore().optIn({
      workstreamId,
      instructionId: instruction.id,
      by: humanAuthor,
    });
    const command = wired(
      ["the ticket"],
      define({
        budget: {
          modelWindowTokens: 200_000,
          warnAtFraction: 0.85,
          hardCapTokens: 100,
        },
      }).id,
    );

    const plan = runs.plan(command.command.id);
    expect(plan.budget.state).toBe("refused");
    expect(plan.blockers.map((each) => each.reason)).toContain(
      "content_budget",
    );
  });
});

describe("the instruction reaches the session (§3.5, §15-1)", () => {
  /** The workstream's opted-in house rules, so ordering can be asserted against them. */
  function standing(body: string) {
    const object = objects.write({
      kind: "note",
      title: "House rules",
      renderings: makeRenderings({ agentContent: body }),
    });
    const store = new StandingInstructionStore(state, clock.now);
    const declared = store.declare({
      objectId: object.objectId,
      by: humanAuthor,
    });
    if (!declared.ok) throw new Error(declared.refusal.message);
    store.optIn({
      workstreamId,
      instructionId: declared.value.id,
      by: humanAuthor,
    });
  }

  it("is in the bytes the runtime is handed, not only in the record", () => {
    const command = wired(["the ticket"]);

    const { run } = runs.start({ commandId: command.command.id });
    const content = runs.assembledContent(run.id);

    // The assertion that did not exist: `configuration.instruction` proves it
    // was recorded, and a run whose prompt is a pile of context with no task in
    // it passes that check every time.
    expect(content).toContain("Implement it and open a pull request.");
    expect(
      content.indexOf("Implement it and open a pull request."),
    ).toBeLessThan(content.indexOf("the ticket"));
  });

  it("frames the workstream's standing instructions rather than following them", () => {
    standing("This repository uses pnpm, never npm.");
    const command = wired(["the ticket"]);

    const content = runs.assembledContent(
      runs.start({ commandId: command.command.id }).run.id,
    );

    // Present before ordered: a missing string indexes at -1, which precedes
    // everything and would let this pass while nothing was delivered at all.
    expect(content).toContain("Implement it and open a pull request.");
    expect(content.indexOf("Implement it")).toBeLessThan(
      content.indexOf("pnpm"),
    );
    expect(content.indexOf("pnpm")).toBeLessThan(content.indexOf("the ticket"));
  });

  it("delivers the confirmed parameter values, so a parameterised command is one at run time", () => {
    const definition = define({
      instruction: "Review the diff and report against the standard.",
      parameters: [
        { name: "repo", label: "Repository", type: "text", required: true },
        { name: "strict", label: "strict", type: "boolean", required: true },
      ],
    });
    const command = wired(["the diff"], definition.id);
    // Bound in the reverse of the declaration order, so an implementation that
    // walked the resolved values instead of the declarations would put `strict`
    // first and the ordering assertion below would catch it.
    commands.proposeDefault(
      command.command.id,
      "strict",
      true,
      "the definition's default",
    );
    commands.confirmDefault(command.command.id, "strict");
    commands.proposeDefault(
      command.command.id,
      "repo",
      "plotroom",
      "the workstream subject",
    );
    commands.confirmDefault(command.command.id, "repo");

    const { run } = runs.start({ commandId: command.command.id });
    const content = runs.assembledContent(run.id);

    expect(content).toContain("- **repo** (Repository): plotroom");
    expect(content).toContain("- **strict**: true");
    // Declaration order, not binding order: `strict` was confirmed first above,
    // and two runs of one definition must still assemble alike (§3.7).
    expect(content.indexOf("**repo**")).toBeLessThan(
      content.indexOf("**strict**"),
    );
    expect(runs.configuration(run.id).parameters).toEqual({
      repo: "plotroom",
      strict: true,
    });
  });

  it("delivers no value while a parameter is still a proposal", () => {
    const definition = define({
      instruction: "Review the diff.",
      parameters: [
        { name: "repo", label: "Repository", type: "text", required: true },
      ],
    });
    const command = wired(["the diff"], definition.id);
    commands.proposeDefault(
      command.command.id,
      "repo",
      "plotroom",
      "the workstream subject",
    );

    const plan = runs.plan(command.command.id);

    // §3.5: a derived default is a proposal. The preview shows the instruction
    // it would run, and the value nobody confirmed appears nowhere in it.
    expect(plan.body).toContain("Review the diff.");
    expect(plan.body).not.toContain("plotroom");
    expect(plan.blockers.map((each) => each.reason)).toContain(
      "parameters_unconfirmed",
    );
  });

  it("delivers the instruction as it read at run time, not as it reads now", () => {
    const definition = define();
    const command = wired(["the ticket"], definition.id);
    const { run } = runs.start({ commandId: command.command.id });

    commands.edit(definition.id, { instruction: "Completely different now." });

    expect(runs.assembledContent(run.id)).toContain(
      "Implement it and open a pull request.",
    );
    expect(runs.assembledContent(run.id)).not.toContain(
      "Completely different now.",
    );
  });

  it("counts toward the content budget, because it is content that is sent (§3.5)", () => {
    const command = wired(
      ["the ticket"],
      define({
        instruction: "x".repeat(40_000),
        budget: {
          modelWindowTokens: 200_000,
          warnAtFraction: 0.85,
          hardCapTokens: 100,
        },
      }).id,
    );

    const plan = runs.plan(command.command.id);

    expect(plan.budget.state).toBe("refused");
    expect(plan.blockers.map((each) => each.reason)).toContain(
      "content_budget",
    );
  });

  it("is not a run input: it has no object and no version to be one", () => {
    const command = wired(["the ticket"]);

    const { run } = runs.start({ commandId: command.command.id });

    // §15-1's two halves stay distinct: the instruction is in the assembled
    // bytes, and `run_inputs` still records only content that had a version.
    expect(run.inputs).toHaveLength(1);
    expect(run.inputs[0]?.nodeId).not.toBeNull();
  });
});
