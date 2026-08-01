import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { humanAuthor } from "@plotroom/core";
import {
  makeRenderings,
  manualClock,
  type ManualClock,
} from "@plotroom/core/testing";
import { BlobStore } from "./blob-store.js";
import { openDatabase, type PlotroomDatabase } from "./client.js";
import { CommandStore, PublishRefused } from "./command-store.js";
import { ConnectionRefused, GraphStore } from "./graph-store.js";
import { ObjectStore } from "./object-store.js";
import { WorkstreamStore } from "./workstream-store.js";

let dir: string;
let state: PlotroomDatabase;
let clock: ManualClock;
let store: CommandStore;
let graph: GraphStore;
let objects: ObjectStore;
let workstreams: WorkstreamStore;
let workstreamId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-commands-"));
  state = openDatabase({ stateDir: dir });
  clock = manualClock();
  store = new CommandStore(state, clock.now);
  graph = new GraphStore(state, clock.now);
  objects = new ObjectStore(state, clock.now);
  workstreams = new WorkstreamStore(state, clock.now);
  workstreamId = workstreams.create({ author: humanAuthor }).id;
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A bind points at a real run by foreign key — an output cannot claim to have
 * been produced by a run that never happened. RunStore is what starts one in
 * production; this writes the minimum row so these tests stay about outputs.
 */
function recordRun(commandId: string): string {
  const definitionId = store.command(commandId).definitionId;
  const blob = new BlobStore(state, clock.now).put("assembled", {
    kind: "assembled_content",
  });
  const id = `run_${commandId}`;

  state.sqlite
    .prepare(
      `INSERT INTO runs
         (id, command_id, definition_id, ordinal, status,
          assembled_blob_id, assembled_hash, assembled_bytes, config_json, started_at)
       VALUES (?, ?, ?, 1, 'completed', ?, 'hash', 9, '{}', 1)`,
    )
    .run(id, commandId, definitionId, blob.id);

  return id;
}

function producing(overrides: Record<string, unknown> = {}) {
  return store.define({
    name: "Implement the ticket",
    instruction: "Implement it and open a pull request.",
    model: "fixture-model",
    effort: "medium",
    lifecycle: "producing",
    outcome: {
      name: "pull_request",
      kind: "pull_request",
      conditions: [
        {
          id: "ci",
          predicate: "checks_green",
          description: "checks are green",
        },
      ],
    },
    ...overrides,
  });
}

function openWork() {
  return store.define({
    name: "Figure out why the build is flaky",
    instruction: "Investigate.",
    model: "fixture-model",
    effort: "high",
    lifecycle: "open",
  });
}

describe("command definitions are content, not code (§3.5)", () => {
  it("records the instruction, model, effort, permissions, and ask-points", () => {
    const definition = store.definition(
      producing({
        permissions: { allowed: ["read", "write"], denied: ["shell"] },
        askPoints: ["external_write"],
      }).id,
    );

    expect(definition.instruction).toContain("pull request");
    expect(definition.model).toEqual({
      model: "fixture-model",
      effort: "medium",
    });
    expect(definition.permissions.denied).toEqual(["shell"]);
    expect(definition.askPoints).toEqual(["external_write"]);
  });

  it("is editable, and editing bumps updatedAt", () => {
    const id = producing().id;
    clock.advance(60);

    const edited = store.edit(id, { instruction: "Do it differently." });

    expect(edited.instruction).toBe("Do it differently.");
    expect(edited.updatedAt).toBeGreaterThan(edited.createdAt);
  });

  it("duplicates a shipped definition as the user's own content", () => {
    const builtin = producing({ source: "builtin" });
    const copy = store.duplicate(builtin.id, "My version");

    expect(copy.id).not.toBe(builtin.id);
    expect(copy.name).toBe("My version");
    expect(copy.source).toBe("user");
    expect(copy.duplicatedFrom).toBe(builtin.id);
    expect(copy.instruction).toBe(builtin.instruction);
  });

  it("organizes definitions into authored folders", () => {
    const id = producing().id;
    store.organize(id, "review");

    expect(store.definitions("review").map((each) => each.id)).toEqual([id]);
    expect(store.definitions(null)).toEqual([]);
  });

  it("asks before an irreversible write whatever the definition declared (§6.6)", () => {
    expect(store.askPoints(producing({ askPoints: [] }).id)).toContain(
      "irreversible_write",
    );
  });
});

describe("the two lifecycles are enforced, not described (§3.5)", () => {
  it("refuses a producing definition with no expected outcome", () => {
    expect(() =>
      store.define({
        name: "broken",
        instruction: "x",
        model: "m",
        effort: "low",
        lifecycle: "producing",
      }),
    ).toThrow(/expected outcome/);
  });

  it("refuses an open definition that declares one", () => {
    expect(() =>
      store.define({
        name: "broken",
        instruction: "x",
        model: "m",
        effort: "low",
        lifecycle: "open",
        outcome: { name: "x", kind: "note", conditions: [] },
      }),
    ).toThrow(/no declared outcome/);
  });

  it("declares world conditions as part of the outcome", () => {
    const definition = store.definition(producing().id);

    expect(definition.outcome?.conditions[0]?.predicate).toBe("checks_green");
  });
});

describe("command nodes: a definition plus its wiring (§3.5)", () => {
  it("wires the dropped target as context in one gesture", () => {
    const ticket = objects.write({
      kind: "ticket",
      title: "OXY-2982",
      renderings: makeRenderings(),
      workstreamId,
    });
    const ticketNode = graph.place({
      role: "content",
      refId: ticket.objectId,
      workstreamId,
    });

    const instance = store.instantiate({
      definitionId: producing().id,
      workstreamId,
      author: humanAuthor,
      context: [ticketNode.id],
    });

    const inputs = graph.contextInputs(instance.node.id);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.fromNode).toBe(ticketNode.id);
    expect(inputs[0]?.authorKind).toBe("human");
  });

  it("is usable in one gesture when it has no parameters", () => {
    const instance = store.instantiate({
      definitionId: producing().id,
      workstreamId,
      author: humanAuthor,
    });

    expect(store.parameters(instance.command.id)).toEqual({
      ready: true,
      values: {},
    });
  });

  it("gives open work no output placeholder", () => {
    const instance = store.instantiate({
      definitionId: openWork().id,
      workstreamId,
      author: humanAuthor,
    });

    expect(instance.outputs).toEqual([]);
  });
});

describe("parameters: a derived default is confirmed, never applied (§3.5)", () => {
  function withParameter() {
    const definition = producing({
      parameters: [
        { name: "repo", label: "Repository", type: "text", required: true },
      ],
    });

    return store.instantiate({
      definitionId: definition.id,
      workstreamId,
      author: humanAuthor,
    }).command.id;
  }

  it("keeps a proposal out of the resolved values", () => {
    const commandId = withParameter();
    store.proposeDefault(
      commandId,
      "repo",
      "plotroom",
      "the workstream subject",
    );

    const resolution = store.parameters(commandId);

    expect(resolution.ready).toBe(false);
    if (resolution.ready) return;
    expect(resolution.unconfirmed).toEqual(["repo"]);
  });

  it("stores the proposal with no confirmation timestamp", () => {
    const commandId = withParameter();
    store.proposeDefault(
      commandId,
      "repo",
      "plotroom",
      "the workstream subject",
    );

    const row = state.sqlite
      .prepare<[string], { state: string; confirmed_at: number | null }>(
        "SELECT state, confirmed_at FROM command_parameter_bindings WHERE command_id = ?",
      )
      .get(commandId);

    expect(row).toEqual({ state: "proposed", confirmed_at: null });
  });

  it("cannot represent a confirmed binding with no confirmation", () => {
    const commandId = withParameter();

    expect(() =>
      state.sqlite
        .prepare(
          "INSERT INTO command_parameter_bindings (command_id, name, state, value_json) VALUES (?, ?, 'confirmed', '\"x\"')",
        )
        .run(commandId, "repo"),
    ).toThrow(/CHECK constraint/);
  });

  it("resolves once confirmed, and lets the user replace the value", () => {
    const commandId = withParameter();
    store.proposeDefault(
      commandId,
      "repo",
      "plotroom",
      "the workstream subject",
    );
    store.confirmDefault(commandId, "repo", "other-repo");

    expect(store.parameters(commandId)).toEqual({
      ready: true,
      values: { repo: "other-repo" },
    });
  });
});

describe("output pre-wiring (§3.5)", () => {
  function instantiate(ws = workstreamId) {
    return store.instantiate({
      definitionId: producing().id,
      workstreamId: ws,
      author: humanAuthor,
    });
  }

  it("creates a typed placeholder before any run", () => {
    const instance = instantiate();

    expect(instance.outputs).toHaveLength(1);
    expect(instance.outputs[0]?.kind).toBe("pull_request");
    expect(instance.outputs[0]?.boundObjectId).toBeNull();
    expect(store.bindState(instance.outputs[0]!.id)).toBe("pre_bind");
  });

  it("lets the placeholder be wired into another command before any run", () => {
    const upstream = instantiate();
    const downstream = instantiate();
    const placeholderNode = graph.nodeFor("content", upstream.outputs[0]!.id);

    const edge = graph.addContextEdge({
      from: placeholderNode.id,
      to: downstream.node.id,
      author: humanAuthor,
    });

    expect(edge.kind).toBe("context");
  });

  it("refuses a cycle through pre-wired placeholders (§3.7)", () => {
    const a = instantiate();
    const b = instantiate();

    graph.addContextEdge({
      from: graph.nodeFor("content", a.outputs[0]!.id).id,
      to: b.node.id,
      author: humanAuthor,
    });

    expect(() =>
      graph.addContextEdge({
        from: graph.nodeFor("content", b.outputs[0]!.id).id,
        to: a.node.id,
        author: humanAuthor,
      }),
    ).toThrow(ConnectionRefused);
  });
});

describe("publish and promote are two verbs (§3.5, §3.2)", () => {
  function instantiate(ws = workstreamId) {
    return store.instantiate({
      definitionId: producing().id,
      workstreamId: ws,
      author: humanAuthor,
    });
  }

  it("refuses an unpublished placeholder crossing into another workstream", () => {
    const other = workstreams.create({ author: humanAuthor }).id;
    const upstream = instantiate();
    const downstream = instantiate(other);

    expect(() =>
      graph.addContextEdge({
        from: graph.nodeFor("content", upstream.outputs[0]!.id).id,
        to: downstream.node.id,
        author: humanAuthor,
      }),
    ).toThrow(/publish this output first/);
  });

  it("lets a published placeholder cross", () => {
    const other = workstreams.create({ author: humanAuthor }).id;
    const upstream = instantiate();
    const downstream = instantiate(other);
    store.publish(upstream.outputs[0]!.id);

    expect(
      graph.addContextEdge({
        from: graph.nodeFor("content", upstream.outputs[0]!.id).id,
        to: downstream.node.id,
        author: humanAuthor,
      }).kind,
    ).toBe("context");
  });

  it("refuses a bound-but-unpublished placeholder carrying a local object out", () => {
    // Binding is not a licence to cross: without publish the produced object
    // is still local, and a placeholder must not become an alias that takes it
    // somewhere the object itself could not go (§3.3, §3.5).
    const other = workstreams.create({ author: humanAuthor }).id;
    const upstream = instantiate();
    const downstream = instantiate(other);
    const produced = objects.write({
      kind: "pull_request",
      title: "PR",
      renderings: makeRenderings(),
      workstreamId,
    });
    store.bindOutput(upstream.outputs[0]!.id, {
      runId: recordRun(upstream.command.id),
      objectId: produced.objectId,
    });

    expect(objects.get(produced.objectId)?.scope).toBe("local");
    expect(() =>
      graph.addContextEdge({
        from: graph.nodeFor("content", upstream.outputs[0]!.id).id,
        to: downstream.node.id,
        author: humanAuthor,
      }),
    ).toThrow(/promote it to world scope first/);
  });

  it("refuses the placeholder wire exactly as it refuses the object's own", () => {
    // Principle 8: two paths to the same wire must refuse identically. Wiring
    // the local object directly is refused by checkScope; wiring it through
    // its placeholder must not be a way around that.
    const other = workstreams.create({ author: humanAuthor }).id;
    const upstream = instantiate();
    const downstream = instantiate(other);
    const produced = objects.write({
      kind: "pull_request",
      title: "PR",
      renderings: makeRenderings(),
      workstreamId,
    });
    store.bindOutput(upstream.outputs[0]!.id, {
      runId: recordRun(upstream.command.id),
      objectId: produced.objectId,
    });
    const objectNode = graph.place({
      role: "content",
      refId: produced.objectId,
      workstreamId,
    });

    const direct = () =>
      graph.addContextEdge({
        from: objectNode.id,
        to: downstream.node.id,
        author: humanAuthor,
      });
    const viaPlaceholder = () =>
      graph.addContextEdge({
        from: graph.nodeFor("content", upstream.outputs[0]!.id).id,
        to: downstream.node.id,
        author: humanAuthor,
      });

    expect(direct).toThrow(ConnectionRefused);
    expect(viaPlaceholder).toThrow(ConnectionRefused);
  });

  it("lets a bound output cross once its object is promoted", () => {
    const other = workstreams.create({ author: humanAuthor }).id;
    const upstream = instantiate();
    const downstream = instantiate(other);
    // Publishing before the run is what promotes on bind (§3.5).
    store.publish(upstream.outputs[0]!.id);
    const produced = objects.write({
      kind: "pull_request",
      title: "PR",
      renderings: makeRenderings(),
      workstreamId,
    });
    store.bindOutput(upstream.outputs[0]!.id, {
      runId: recordRun(upstream.command.id),
      objectId: produced.objectId,
    });

    expect(objects.get(produced.objectId)?.scope).toBe("world");
    expect(
      graph.addContextEdge({
        from: graph.nodeFor("content", upstream.outputs[0]!.id).id,
        to: downstream.node.id,
        author: humanAuthor,
      }).kind,
    ).toBe("context");
  });

  it("refuses publish once the output has bound, pointing at promote", () => {
    const instance = instantiate();
    const produced = objects.write({
      kind: "pull_request",
      title: "PR",
      renderings: makeRenderings(),
      workstreamId,
    });
    store.bindOutput(instance.outputs[0]!.id, {
      runId: recordRun(instance.command.id),
      objectId: produced.objectId,
    });

    expect(() => store.publish(instance.outputs[0]!.id)).toThrow(
      PublishRefused,
    );
  });

  it("promotes the produced object when a published placeholder binds", () => {
    const instance = instantiate();
    store.publish(instance.outputs[0]!.id);
    const produced = objects.write({
      kind: "pull_request",
      title: "PR",
      renderings: makeRenderings(),
      workstreamId,
    });

    store.bindOutput(instance.outputs[0]!.id, {
      runId: recordRun(instance.command.id),
      objectId: produced.objectId,
    });

    expect(objects.get(produced.objectId)?.scope).toBe("world");
  });
});

describe("the pre-bind/post-bind two-state rule (§3.5)", () => {
  function wired() {
    const upstream = store.instantiate({
      definitionId: producing().id,
      workstreamId,
      author: humanAuthor,
    });
    const downstream = store.instantiate({
      definitionId: producing({ name: "downstream" }).id,
      workstreamId,
      author: humanAuthor,
    });
    const edge = graph.addContextEdge({
      from: graph.nodeFor("content", upstream.outputs[0]!.id).id,
      to: downstream.node.id,
      author: humanAuthor,
    });

    return { upstream, downstream, edge };
  }

  it("leaves a visibly broken placeholder, never a silent unblock", () => {
    const { upstream, downstream, edge } = wired();

    const effects = store.delete(upstream.command.id);

    expect(effects[0]?.effect).toBe("broken_placeholder");
    expect(store.output(upstream.outputs[0]!.id).brokenAt).not.toBeNull();
    // The wire is still there: downstream is blocked and says so.
    expect(
      graph.contextInputs(downstream.node.id).map((each) => each.id),
    ).toEqual([edge.id]);
  });

  it("refuses new wires from a broken placeholder", () => {
    const { upstream } = wired();
    const third = store.instantiate({
      definitionId: producing({ name: "third" }).id,
      workstreamId,
      author: humanAuthor,
    });
    store.delete(upstream.command.id);

    expect(() =>
      graph.addContextEdge({
        from: graph.nodeFor("content", upstream.outputs[0]!.id).id,
        to: third.node.id,
        author: humanAuthor,
      }),
    ).toThrow(/deleted before it produced anything/);
  });

  it("leaves the produced object intact when a post-bind producer is deleted", () => {
    const { upstream } = wired();
    const produced = objects.write({
      kind: "pull_request",
      title: "PR",
      renderings: makeRenderings(),
      workstreamId,
    });
    store.bindOutput(upstream.outputs[0]!.id, {
      runId: recordRun(upstream.command.id),
      objectId: produced.objectId,
    });

    const effects = store.delete(upstream.command.id);

    expect(effects[0]).toEqual({
      effect: "object_intact",
      objectId: produced.objectId,
    });
    expect(objects.get(produced.objectId)).toBeDefined();
    expect(store.output(upstream.outputs[0]!.id).brokenAt).toBeNull();
  });

  it("cannot represent a bound output that is also broken", () => {
    const { upstream } = wired();
    const produced = objects.write({
      kind: "pull_request",
      title: "PR",
      renderings: makeRenderings(),
      workstreamId,
    });
    store.bindOutput(upstream.outputs[0]!.id, {
      runId: recordRun(upstream.command.id),
      objectId: produced.objectId,
    });

    expect(() =>
      state.sqlite
        .prepare("UPDATE command_outputs SET broken_at = 1 WHERE id = ?")
        .run(upstream.outputs[0]!.id),
    ).toThrow(/CHECK constraint/);
  });

  it("restores a soft-deleted command and clears the break (principle 10)", () => {
    const { upstream } = wired();
    store.delete(upstream.command.id);

    store.restore(upstream.command.id);

    expect(store.command(upstream.command.id).deletedAt).toBeNull();
    expect(store.output(upstream.outputs[0]!.id).brokenAt).toBeNull();
  });
});

describe("definitions are content, and deleting one is recoverable (§3.5)", () => {
  it("hides a deleted definition from the list and puts it back", () => {
    const definition = store.define({
      name: "Review the diff",
      instruction: "Review it.",
      model: "fixture-model",
      effort: "low",
      lifecycle: "open",
    });

    store.deleteDefinition(definition.id);

    expect(store.definitions().map((row) => row.id)).not.toContain(
      definition.id,
    );
    expect(store.deletedDefinitions().map((row) => row.id)).toEqual([
      definition.id,
    ]);

    store.restoreDefinition(definition.id);

    expect(store.definitions().map((row) => row.id)).toContain(definition.id);
  });

  it("leaves command nodes already instantiated from it alone", () => {
    const definition = store.define({
      name: "Implement it",
      instruction: "Implement it.",
      model: "fixture-model",
      effort: "medium",
      lifecycle: "open",
    });
    const instance = store.instantiate({
      definitionId: definition.id,
      workstreamId,
      author: humanAuthor,
    });

    store.deleteDefinition(definition.id);

    expect(store.command(instance.command.id).deletedAt).toBeNull();
  });

  it("refuses to delete a definition that does not exist", () => {
    expect(() => store.deleteDefinition("cmddef_nope")).toThrow(
      /unknown command definition/,
    );
  });
});

describe("instantiation is one gesture, or none of it (principle 9)", () => {
  it("leaves no command node behind when the wiring is refused", () => {
    const definition = store.define({
      name: "Implement it",
      instruction: "Implement it.",
      model: "fixture-model",
      effort: "medium",
      lifecycle: "open",
    });
    const otherCommand = store.instantiate({
      definitionId: definition.id,
      workstreamId,
      author: humanAuthor,
    });
    const commandsBefore = state.sqlite
      .prepare("SELECT COUNT(*) AS n FROM commands")
      .get() as { n: number };

    expect(() =>
      store.instantiate({
        definitionId: definition.id,
        workstreamId,
        author: humanAuthor,
        // A command is not content: §3.7 refuses this connection.
        context: [store.commandNode(otherCommand.command.id).id],
      }),
    ).toThrow(ConnectionRefused);

    expect(
      state.sqlite.prepare("SELECT COUNT(*) AS n FROM commands").get(),
    ).toEqual(commandsBefore);
  });
});
