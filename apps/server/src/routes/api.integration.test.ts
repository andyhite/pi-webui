import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, afterEach, beforeEach, describe, it } from "bun:test";
import { GraphStore } from "@plotroom/db";
import type { DomainEvent } from "@plotroom/core";

import { openWebSocket } from "../test-support/bun-websocket.js";
import { loadServerConfig } from "../config.js";
import { startServer } from "../index.js";

type Handle = ReturnType<typeof startServer>;

let handle: Handle;
let base: string;
let origin: string;
/** The port the socket actually bound, read back per test; the WS helpers use it. */
let port: number;

beforeEach(async () => {
  // Port 0, and the bound one comes back from the socket. A static band collides
  // with a leaked server or another suite, and probing for a free port then
  // binding it leaves a window in which something else can take it — the failure
  // can be requests landing on that other server.
  const stateDir = mkdtempSync(join(tmpdir(), "plotroom-api-test-"));
  handle = startServer(
    loadServerConfig(
      {},
      {
        host: "127.0.0.1",
        port: 0,
        stateDir,
        credential: null,
        allowNonLoopbackBind: false,
        trustedOrigins: [],
        staticDir: join(tmpdir(), "plotroom-no-such-renderer-dir"),
        logLevel: "error",
        // No plugin workers: this suite is about the graph's own mutations and the
        // events they publish, and a plugin reporting its health on the same stream
        // is noise here. `plugins/plugins.integration.test.ts` mounts them.
        pluginsInBox: [],
      },
    ),
  );
  // Before anything calls the API: a bind failure is this line's error rather
  // than an unhandled `error` event surfacing as whatever times out next.
  ({ port } = await handle.listening);
  base = `http://127.0.0.1:${port}/api`;
  origin = `http://localhost:${port}`;
});

afterEach(async () => {
  const stateDir = handle.db.layout.dir;
  await handle.close();
  rmSync(stateDir, { recursive: true, force: true });
});

interface CallOptions {
  readonly method?: string;
  readonly body?: unknown;
  /** The attribution header: "human", "session:<id>", or something invalid. */
  readonly actor?: string;
}

async function call(
  path: string,
  options: CallOptions = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers: {
      origin,
      "content-type": "application/json",
      ...(options.actor ? { "x-plotroom-actor": options.actor } : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });

  return { status: res.status, body: await res.json() };
}

/** Asserts a 2xx and hands back the body, so a failing setup fails loudly. */
async function ok(path: string, options: CallOptions = {}): Promise<unknown> {
  const res = await call(path, options);
  if (res.status >= 300) {
    throw new Error(
      `${path} failed: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return res.body;
}

function at(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (current, key) => (current as Record<string, unknown>)?.[key],
      value,
    );
}

function str(value: unknown, path: string): string {
  const found = at(value, path);
  if (typeof found !== "string") {
    throw new Error(
      `expected a string at ${path}, got ${JSON.stringify(found)}`,
    );
  }
  return found;
}

function list(value: unknown, path: string): unknown[] {
  const found = at(value, path);
  if (!Array.isArray(found)) {
    throw new Error(
      `expected an array at ${path}, got ${JSON.stringify(found)}`,
    );
  }
  return found;
}

/** A workstream, a note, and the note's placement on the board. */
async function board() {
  const workstream = str(
    await ok("/workstreams", { method: "POST", body: {} }),
    "workstream.id",
  );
  const note = await ok("/notes", {
    method: "POST",
    body: { title: "context", body: "some content", workstreamId: workstream },
  });
  const noteId = str(note, "object.id");
  const noteNode = await ok("/nodes", {
    method: "POST",
    body: { role: "content", refId: noteId, workstreamId: workstream },
  });

  return { workstream, noteId, noteNode: str(noteNode, "node.id") };
}

/** A producing command node, with the typed placeholder it declared (§3.5). */
async function producingCommand(workstream: string, name: string) {
  const definition = await ok("/command-definitions", {
    method: "POST",
    body: {
      name,
      instruction: "Do the thing.",
      model: "fixture-model",
      effort: "medium",
      lifecycle: "producing",
      outcome: { name: "result", kind: "document", conditions: [] },
    },
  });
  const definitionId = str(definition, "definition.id");

  const command = await ok("/commands", {
    method: "POST",
    body: { definitionId, workstreamId: workstream },
  });
  const outputId = str(list(command, "outputs")[0], "id");
  const output = await ok(`/outputs/${outputId}`);

  return {
    definitionId,
    commandId: str(command, "command.id"),
    node: str(command, "node.id"),
    outputId,
    outputNode: str(output, "node.id"),
  };
}

/** Collects events off the live stream while `run` mutates (Epic 2.1 seam). */
async function eventsDuring(run: () => Promise<void>): Promise<DomainEvent[]> {
  const ws = openWebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { origin },
  });
  const events: DomainEvent[] = [];

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("error", reject);
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        event?: DomainEvent;
      };
      if (message.type === "hello") resolve();
      if (message.type === "event" && message.event) events.push(message.event);
    });
  });

  await run();
  // A round trip plus a tick, so anything published during `run` has arrived.
  await ok("/health");
  await new Promise((resolve) => setTimeout(resolve, 25));
  ws.close();

  return events;
}

describe("refusals come from the predicates, not from the route (principle 8)", () => {
  it("refuses content wired into content, with the predicate's reason", async () => {
    const { noteNode } = await board();
    const second = await ok("/notes", {
      method: "POST",
      body: { title: "other", body: "other content" },
    });
    const otherNode = await ok("/nodes", {
      method: "POST",
      body: { role: "content", refId: str(second, "object.id") },
    });

    const res = await call("/edges", {
      method: "POST",
      body: { from: noteNode, to: str(otherNode, "node.id") },
    });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: "refused",
        message: "content cannot be wired into content",
        details: { reason: "illegal_target" },
      },
    });
  });

  it("refuses a command as the source of context", async () => {
    const { workstream, noteNode } = await board();
    const command = await producingCommand(workstream, "Implement");

    const res = await call("/edges", {
      method: "POST",
      body: { from: command.node, to: noteNode },
    });

    expect(res.status).toBe(409);
    expect(at(res.body, "error.details")).toEqual({
      reason: "source_not_content",
    });
  });

  it("refuses context into a session that has ended", async () => {
    const { workstream, noteNode } = await board();
    const session = await ok("/nodes", {
      method: "POST",
      body: {
        role: "session",
        refId: "sess_ended",
        workstreamId: workstream,
        running: false,
      },
    });

    const res = await call("/edges", {
      method: "POST",
      body: { from: noteNode, to: str(session, "node.id") },
    });

    expect(res.status).toBe(409);
    expect(at(res.body, "error.details")).toEqual({
      reason: "session_not_running",
    });
    expect(at(res.body, "error.message")).toMatch(/fork or re-run it instead/);
  });

  it("refuses a command-topology cycle transitively (§3.7)", async () => {
    const { workstream } = await board();
    const first = await producingCommand(workstream, "First");
    const second = await producingCommand(workstream, "Second");

    // first → second is legal; second → first would close the loop.
    await ok("/edges", {
      method: "POST",
      body: { from: first.outputNode, to: second.node },
    });

    const res = await call("/edges", {
      method: "POST",
      body: { from: second.outputNode, to: first.node },
    });

    expect(res.status).toBe(409);
    expect(at(res.body, "error.details")).toEqual({ reason: "would_cycle" });
  });

  it("refuses a session authoring context into itself (principle 1)", async () => {
    const { workstream, noteNode } = await board();
    const session = await ok("/nodes", {
      method: "POST",
      body: {
        role: "session",
        refId: "sess_self",
        workstreamId: workstream,
        running: true,
      },
    });
    const sessionNode = str(session, "node.id");

    const refused = await call("/edges", {
      method: "POST",
      actor: "session:sess_self",
      body: { from: noteNode, to: sessionNode },
    });

    expect(refused.status).toBe(409);
    expect(at(refused.body, "error.details")).toEqual({ reason: "own_chain" });

    // The human is unconstrained: the same wire, the same target, allowed.
    const allowed = await call("/edges", {
      method: "POST",
      body: { from: noteNode, to: sessionNode },
    });
    expect(allowed.status).toBe(201);
  });

  it("refuses a session authoring into a descendant it started", async () => {
    const { workstream, noteNode } = await board();
    // The chain terminates at a human gesture, so the parent is recorded
    // first with no initiator of its own (principle 1).
    const graph = new GraphStore(handle.db);
    graph.recordLineage("sess_parent", null);
    graph.recordLineage("sess_child", "sess_parent");
    const child = await ok("/nodes", {
      method: "POST",
      body: {
        role: "session",
        refId: "sess_child",
        workstreamId: workstream,
        running: true,
      },
    });

    const res = await call("/edges", {
      method: "POST",
      actor: "session:sess_parent",
      body: { from: noteNode, to: str(child, "node.id") },
    });

    expect(res.status).toBe(409);
    expect(at(res.body, "error.details")).toEqual({ reason: "own_chain" });
  });

  it("refuses a duplicate wire rather than silently ignoring it", async () => {
    const { workstream, noteNode } = await board();
    const command = await producingCommand(workstream, "Implement");

    await ok("/edges", {
      method: "POST",
      body: { from: noteNode, to: command.node },
    });
    const res = await call("/edges", {
      method: "POST",
      body: { from: noteNode, to: command.node },
    });

    expect(res.status).toBe(409);
    expect(at(res.body, "error.details")).toEqual({ reason: "duplicate" });
  });

  it("refuses a session setting workstream lifecycle (§3.3)", async () => {
    const { workstream } = await board();

    const res = await call(`/workstreams/${workstream}`, {
      method: "PATCH",
      actor: "session:sess_agent",
      body: { status: "done" },
    });

    expect(res.status).toBe(409);
    expect(at(res.body, "error.details")).toEqual({
      reason: "session_sets_lifecycle",
    });

    // …and the human's identical call is accepted.
    const human = await call(`/workstreams/${workstream}`, {
      method: "PATCH",
      body: { status: "done" },
    });
    expect(human.status).toBe(200);
    expect(at(human.body, "workstream.status")).toBe("done");
  });

  it("refuses publishing an output that already bound (§3.5)", async () => {
    const { workstream } = await board();
    const command = await producingCommand(workstream, "Implement");
    const produced = await ok("/objects", {
      method: "POST",
      body: {
        kind: "document",
        title: "the result",
        renderings: { card: {}, summary: "result", agentContent: "done" },
        workstreamId: workstream,
      },
    });

    // Binding is what a completed run does; forced here so the route's
    // refusal is what is under test rather than the run machinery.
    handle.db.sqlite
      .prepare(
        "UPDATE command_outputs SET bound_object_id = ?, bound_at = 1 WHERE id = ?",
      )
      .run(str(produced, "object.id"), command.outputId);

    const res = await call(`/outputs/${command.outputId}/publish`, {
      method: "POST",
    });

    expect(res.status).toBe(409);
    expect(at(res.body, "error.details")).toEqual({ reason: "already_bound" });
  });

  it("answers 404, never 500, for an id that names nothing", async () => {
    const res = await call("/nodes/node_nope");

    expect(res.status).toBe(404);
    expect(at(res.body, "error.code")).toBe("not_found");
  });

  it("answers 400 with the validation issues for a malformed body", async () => {
    const res = await call("/edges", { method: "POST", body: { from: "" } });

    expect(res.status).toBe(400);
    expect(at(res.body, "error.code")).toBe("bad_request");
    expect(Array.isArray(at(res.body, "error.details"))).toBe(true);
  });
});

describe("attribution on every mutating call (§15 invariant 2)", () => {
  it("defaults to the human operator", async () => {
    const { workstream, noteNode } = await board();
    const command = await producingCommand(workstream, "Implement");

    const created = await ok("/edges", {
      method: "POST",
      body: { from: noteNode, to: command.node },
    });

    expect(at(created, "edge.author")).toEqual({ kind: "human" });
  });

  it("records the session that authored the edge", async () => {
    const { workstream, noteNode } = await board();
    const command = await producingCommand(workstream, "Implement");

    const created = await ok("/edges", {
      method: "POST",
      actor: "session:sess_peer",
      body: { from: noteNode, to: command.node },
    });

    expect(at(created, "edge.author")).toEqual({
      kind: "session",
      sessionId: "sess_peer",
    });

    const inputs = await ok(`/nodes/${command.node}/context`);
    expect(at(list(inputs, "inputs")[0], "author")).toEqual({
      kind: "session",
      sessionId: "sess_peer",
    });
  });

  it("attributes workstream gestures in the stored trail", async () => {
    const { workstream, noteId } = await board();

    await ok(`/workstreams/${workstream}`, {
      method: "PATCH",
      actor: "session:sess_agent",
      body: { subjectId: noteId },
    });

    const read = await ok(`/workstreams/${workstream}`);
    const subjectSet = list(read, "events").find(
      (event) => at(event, "kind") === "subject_set",
    );

    expect(at(subjectSet, "authorKind")).toBe("session");
    expect(at(subjectSet, "authorSession")).toBe("sess_agent");
  });

  it("refuses an actor it cannot parse rather than guessing one", async () => {
    const res = await call("/workstreams", {
      method: "POST",
      actor: "robot",
      body: {},
    });

    expect(res.status).toBe(400);
    expect(at(res.body, "error.message")).toMatch(/session:<sessionId>/);
  });
});

describe("undo and restore for destructive operations (principle 10)", () => {
  it("restores a removed edge", async () => {
    const { workstream, noteNode } = await board();
    const command = await producingCommand(workstream, "Implement");
    const edgeId = str(
      await ok("/edges", {
        method: "POST",
        body: { from: noteNode, to: command.node },
      }),
      "edge.id",
    );

    await ok(`/edges/${edgeId}`, { method: "DELETE" });
    expect(
      list(await ok(`/nodes/${command.node}/context`), "inputs"),
    ).toHaveLength(0);
    expect(list(await ok("/restorable"), "edges")).toHaveLength(1);

    await ok(`/edges/${edgeId}/restore`, { method: "POST" });
    expect(
      list(await ok(`/nodes/${command.node}/context`), "inputs"),
    ).toHaveLength(1);
  });

  it("restores a removed node with the wires it took down", async () => {
    const { workstream, noteNode } = await board();
    const command = await producingCommand(workstream, "Implement");
    await ok("/edges", {
      method: "POST",
      body: { from: noteNode, to: command.node },
    });

    await ok(`/nodes/${noteNode}`, { method: "DELETE" });
    expect(
      list(await ok(`/nodes/${command.node}/context`), "inputs"),
    ).toHaveLength(0);

    await ok(`/nodes/${noteNode}/restore`, { method: "POST" });
    expect(
      list(await ok(`/nodes/${command.node}/context`), "inputs"),
    ).toHaveLength(1);
  });

  it("restores a deleted workstream", async () => {
    const { workstream } = await board();

    // The operator's own gesture. An **agent's** delete no longer reaches the
    // store at all: §6.6 routes a session's destruction through an approval
    // (`approvals/guard.ts`), which `approvals.integration.test.ts` covers end to
    // end — including that the soft delete, once approved, is still recoverable
    // and still attributed to the session that asked (principle 10).
    await ok(`/workstreams/${workstream}`, { method: "DELETE" });
    expect(list(await ok("/workstreams"), "workstreams")).toHaveLength(0);
    expect(at(list(await ok("/restorable"), "workstreams")[0], "id")).toBe(
      workstream,
    );

    await ok(`/workstreams/${workstream}/restore`, { method: "POST" });
    expect(list(await ok("/workstreams"), "workstreams")).toHaveLength(1);
  });

  it("restores a deleted command and clears the broken placeholder", async () => {
    const { workstream } = await board();
    const command = await producingCommand(workstream, "Implement");

    const deleted = await ok(`/commands/${command.commandId}`, {
      method: "DELETE",
    });
    expect(at(deleted, "restorable")).toBe(true);
    expect(
      at(await ok(`/outputs/${command.outputId}`), "output.brokenAt"),
    ).not.toBeNull();

    await ok(`/commands/${command.commandId}/restore`, { method: "POST" });

    expect(
      at(await ok(`/outputs/${command.outputId}`), "output.brokenAt"),
    ).toBeNull();
  });

  it("restores a deleted object together with its placement", async () => {
    const { noteId, noteNode } = await board();

    await ok(`/objects/${noteId}`, { method: "DELETE" });
    expect(at(await ok(`/nodes/${noteNode}`), "node.deletedAt")).not.toBeNull();
    expect(list(await ok("/restorable"), "objects")).toHaveLength(1);

    await ok(`/objects/${noteId}/restore`, { method: "POST" });
    expect(at(await ok(`/nodes/${noteNode}`), "node.deletedAt")).toBeNull();
  });

  it("restores a deleted command definition", async () => {
    const { workstream } = await board();
    const command = await producingCommand(workstream, "Implement");

    await ok(`/command-definitions/${command.definitionId}`, {
      method: "DELETE",
    });
    expect(list(await ok("/command-definitions"), "definitions")).toHaveLength(
      0,
    );

    await ok(`/command-definitions/${command.definitionId}/restore`, {
      method: "POST",
    });
    expect(list(await ok("/command-definitions"), "definitions")).toHaveLength(
      1,
    );
  });
});

describe("every successful mutation announces itself (Epic 2.1 seam)", () => {
  it("publishes what a composing gesture produced, with its author", async () => {
    const events = await eventsDuring(async () => {
      const { workstream, noteNode } = await board();
      const command = await producingCommand(workstream, "Implement");
      await ok("/edges", {
        method: "POST",
        actor: "session:sess_peer",
        body: { from: noteNode, to: command.node },
      });
    });

    const seen = events.map((event) => `${event.entity}.${event.verb}`);
    expect(seen).toContain("workstream.created");
    expect(seen).toContain("object.created");
    expect(seen).toContain("version.created");
    expect(seen).toContain("node.created");
    expect(seen).toContain("command_definition.created");
    expect(seen).toContain("command.created");
    expect(seen).toContain("command_output.created");
    expect(seen).toContain("edge.created");

    const edgeEvent = events.find((event) => event.entity === "edge");
    expect(edgeEvent?.author as unknown).toEqual({
      kind: "session",
      sessionId: "sess_peer",
    });
  });

  it("publishes deletions and restorations", async () => {
    const { workstream } = await board();

    const events = await eventsDuring(async () => {
      await ok(`/workstreams/${workstream}`, { method: "DELETE" });
      await ok(`/workstreams/${workstream}/restore`, { method: "POST" });
    });

    expect(events.map((event) => `${event.entity}.${event.verb}`)).toEqual([
      "workstream.deleted",
      "workstream.created",
    ]);
  });

  it("publishes nothing when the mutation was refused", async () => {
    const { workstream, noteNode } = await board();
    const command = await producingCommand(workstream, "Implement");
    await ok("/edges", {
      method: "POST",
      body: { from: noteNode, to: command.node },
    });

    const events = await eventsDuring(async () => {
      const res = await call("/edges", {
        method: "POST",
        body: { from: noteNode, to: command.node },
      });
      expect(res.status).toBe(409);
    });

    expect(events).toEqual([]);
  });
});

describe("content, notes, and assembly order (spec §3.2, §3.5, §3.8)", () => {
  it("makes each note edit a new version of the same object", async () => {
    const { noteId } = await board();

    const edited = await ok(`/notes/${noteId}`, {
      method: "PATCH",
      body: { body: "a sharper thought" },
    });

    expect(at(edited, "object.id")).toBe(noteId);
    expect(at(edited, "ordinal")).toBe(2);
    expect(
      list(await ok(`/objects/${noteId}/versions`), "versions"),
    ).toHaveLength(2);
    expect(
      at(await ok(`/objects/${noteId}`), "content.renderings.agentContent"),
    ).toBe("a sharper thought");
  });

  it("promotes a local object to world scope in one gesture", async () => {
    const { noteId } = await board();

    const promoted = await ok(`/objects/${noteId}/promote`, { method: "POST" });

    expect(at(promoted, "object.scope")).toBe("world");
    expect(at(promoted, "object.workstreamId")).toBeNull();
  });

  it("reorders context inputs, and refuses a partial reorder", async () => {
    const { workstream, noteNode } = await board();
    const command = await producingCommand(workstream, "Implement");
    const second = await ok("/notes", {
      method: "POST",
      body: { title: "second", body: "more", workstreamId: workstream },
    });
    const secondNode = str(
      await ok("/nodes", {
        method: "POST",
        body: {
          role: "content",
          refId: str(second, "object.id"),
          workstreamId: workstream,
        },
      }),
      "node.id",
    );

    const first = str(
      await ok("/edges", {
        method: "POST",
        body: { from: noteNode, to: command.node },
      }),
      "edge.id",
    );
    const later = str(
      await ok("/edges", {
        method: "POST",
        body: { from: secondNode, to: command.node },
      }),
      "edge.id",
    );

    const reordered = await ok(`/nodes/${command.node}/context/order`, {
      method: "POST",
      body: { edgeIds: [later, first] },
    });

    expect(list(reordered, "inputs").map((edge) => at(edge, "id"))).toEqual([
      later,
      first,
    ]);

    const partial = await call(`/nodes/${command.node}/context/order`, {
      method: "POST",
      body: { edgeIds: [first] },
    });
    expect(partial.status).toBe(400);
  });
});

describe("placing is idempotent (principle 9)", () => {
  it("returns the same node for the same subject, announcing it once", async () => {
    const { noteId, noteNode } = await board();

    const events = await eventsDuring(async () => {
      const again = await call("/nodes", {
        method: "POST",
        body: { role: "content", refId: noteId },
      });

      expect(again.status).toBe(200);
      expect(at(again.body, "node.id")).toBe(noteNode);
    });

    expect(events).toEqual([]);
  });
});

describe("a removed node is off the board until it is restored", () => {
  it("refuses to place it again, naming the verb that puts it back", async () => {
    const { noteId, noteNode } = await board();
    await ok(`/nodes/${noteNode}`, { method: "DELETE" });

    const res = await call("/nodes", {
      method: "POST",
      body: { role: "content", refId: noteId },
    });

    expect(res.status).toBe(409);
    expect(at(res.body, "error.details")).toEqual({ reason: "node_deleted" });
    expect(at(res.body, "error.message")).toMatch(/restore it/);

    await ok(`/nodes/${noteNode}/restore`, { method: "POST" });
    const again = await call("/nodes", {
      method: "POST",
      body: { role: "content", refId: noteId },
    });
    expect(again.status).toBe(200);
  });

  it("refuses to wire it, at either end", async () => {
    const { workstream, noteNode } = await board();
    const command = await producingCommand(workstream, "Implement");
    await ok(`/nodes/${noteNode}`, { method: "DELETE" });

    const res = await call("/edges", {
      method: "POST",
      body: { from: noteNode, to: command.node },
    });

    expect(res.status).toBe(409);
    expect(at(res.body, "error.details")).toEqual({ reason: "node_deleted" });
  });
});

describe("provenance is recorded, never authored (§3.7)", () => {
  it("refuses to unwire a provenance edge", async () => {
    const { workstream } = await board();
    await producingCommand(workstream, "Implement");
    const provenance = handle.db.sqlite
      .prepare("SELECT id FROM edges WHERE kind = 'provenance' LIMIT 1")
      .get() as { id: string };

    const res = await call(`/edges/${provenance.id}`, { method: "DELETE" });

    expect(res.status).toBe(409);
    expect(at(res.body, "error.details")).toEqual({
      reason: "provenance_not_authored",
    });
  });
});

describe("the stream carries the whole change, not part of it", () => {
  it("announces the wires a removed node took down, and their return", async () => {
    const { workstream, noteNode } = await board();
    const command = await producingCommand(workstream, "Implement");
    await ok("/edges", {
      method: "POST",
      body: { from: noteNode, to: command.node },
    });

    const removal = await eventsDuring(async () => {
      await ok(`/nodes/${noteNode}`, { method: "DELETE" });
    });

    // Leaves first: nothing is left drawing an edge to a node that is gone.
    expect(removal.map((event) => `${event.entity}.${event.verb}`)).toEqual([
      "edge.deleted",
      "node.deleted",
    ]);

    const restoration = await eventsDuring(async () => {
      await ok(`/nodes/${noteNode}/restore`, { method: "POST" });
    });

    expect(restoration.map((event) => `${event.entity}.${event.verb}`)).toEqual(
      ["node.created", "edge.created"],
    );
  });

  it("announces the cascade when an object is deleted and restored", async () => {
    const { workstream, noteId, noteNode } = await board();
    const command = await producingCommand(workstream, "Implement");
    await ok("/edges", {
      method: "POST",
      body: { from: noteNode, to: command.node },
    });

    const removal = await eventsDuring(async () => {
      await ok(`/objects/${noteId}`, { method: "DELETE" });
    });

    expect(removal.map((event) => `${event.entity}.${event.verb}`)).toEqual([
      "edge.deleted",
      "node.deleted",
      "object.deleted",
    ]);

    const restoration = await eventsDuring(async () => {
      await ok(`/objects/${noteId}/restore`, { method: "POST" });
    });

    // Roots first: the object exists again before anything referring to it.
    expect(restoration.map((event) => `${event.entity}.${event.verb}`)).toEqual(
      ["object.created", "node.created", "edge.created"],
    );
  });

  it("announces the context an instantiation wired in the same gesture", async () => {
    const { workstream, noteNode } = await board();
    const definition = await ok("/command-definitions", {
      method: "POST",
      body: {
        name: "Implement",
        instruction: "Implement it.",
        model: "fixture-model",
        effort: "medium",
        lifecycle: "open",
      },
    });

    const events = await eventsDuring(async () => {
      await ok("/commands", {
        method: "POST",
        body: {
          definitionId: str(definition, "definition.id"),
          workstreamId: workstream,
          context: [noteNode],
        },
      });
    });

    const edgeEvents = events.filter((event) => event.entity === "edge");
    expect(edgeEvents).toHaveLength(1);
    expect(edgeEvents[0]?.verb).toBe("created");
    expect(edgeEvents[0]?.author).toEqual({ kind: "human" });
  });

  it("announces nothing when a delete or restore changed nothing", async () => {
    const { workstream, noteId, noteNode } = await board();
    const command = await producingCommand(workstream, "Implement");
    const edgeId = str(
      await ok("/edges", {
        method: "POST",
        body: { from: noteNode, to: command.node },
      }),
      "edge.id",
    );

    await ok(`/edges/${edgeId}`, { method: "DELETE" });
    await ok(`/workstreams/${workstream}`, { method: "DELETE" });
    await ok(`/objects/${noteId}`, { method: "DELETE" });
    await ok(`/commands/${command.commandId}`, { method: "DELETE" });
    await ok(`/command-definitions/${command.definitionId}`, {
      method: "DELETE",
    });

    const events = await eventsDuring(async () => {
      await ok(`/edges/${edgeId}`, { method: "DELETE" });
      await ok(`/workstreams/${workstream}`, { method: "DELETE" });
      await ok(`/objects/${noteId}`, { method: "DELETE" });
      await ok(`/commands/${command.commandId}`, { method: "DELETE" });
      await ok(`/command-definitions/${command.definitionId}`, {
        method: "DELETE",
      });
    });

    expect(events).toEqual([]);
  });
});

describe("the board snapshot (Epic 2.2's deferred item, landed)", () => {
  it("reflects every collection the canvas needs, in the shared vocabulary", async () => {
    const { workstream, noteId, noteNode } = await board();
    const command = await producingCommand(workstream, "Implement");
    const edge = await ok("/edges", {
      method: "POST",
      body: { from: noteNode, to: command.node },
    });

    const snapshot = await ok("/snapshot");

    expect(list(snapshot, "workstreams").map((row) => at(row, "id"))).toContain(
      workstream,
    );
    expect(list(snapshot, "nodes").map((row) => at(row, "id"))).toEqual(
      expect.arrayContaining([noteNode, command.node, command.outputNode]),
    );
    expect(list(snapshot, "edges").map((row) => at(row, "id"))).toContain(
      str(edge, "edge.id"),
    );
    expect(list(snapshot, "objects").map((row) => at(row, "id"))).toContain(
      noteId,
    );
    expect(
      list(snapshot, "commandDefinitions").map((row) => at(row, "id")),
    ).toContain(command.definitionId);
    expect(list(snapshot, "commands").map((row) => at(row, "id"))).toContain(
      command.commandId,
    );
    expect(list(snapshot, "outputs").map((row) => at(row, "id"))).toContain(
      command.outputId,
    );

    // Objects carry the same card-level shape and current version id the
    // per-entity GET does (`toPlotObject`), not a snapshot-only cutdown.
    const object = list(snapshot, "objects").find(
      (row) => at(row, "id") === noteId,
    );
    expect(at(object, "latestVersionId")).toEqual(expect.any(String));

    // Output placeholders carry publish/bind state (§3.5).
    const output = list(snapshot, "outputs").find(
      (row) => at(row, "id") === command.outputId,
    );
    expect(at(output, "publishedAt")).toBeNull();
    expect(at(output, "boundObjectId")).toBeNull();

    expect(typeof at(snapshot, "seq")).toBe("number");
    expect(at(snapshot, "seq")).toBeGreaterThan(0);
  });

  it("omits every kind of deleted or removed entity", async () => {
    const { workstream, noteId, noteNode } = await board();
    const command = await producingCommand(workstream, "Implement");
    const edgeId = str(
      await ok("/edges", {
        method: "POST",
        body: { from: noteNode, to: command.node },
      }),
      "edge.id",
    );
    const otherDefinition = str(
      await ok("/command-definitions", {
        method: "POST",
        body: {
          name: "Scratch",
          instruction: "Do a thing.",
          model: "fixture-model",
          effort: "low",
          lifecycle: "open",
        },
      }),
      "definition.id",
    );

    await ok(`/edges/${edgeId}`, { method: "DELETE" });
    await ok(`/command-definitions/${otherDefinition}`, { method: "DELETE" });

    const afterEdgeAndDefinition = await ok("/snapshot");
    expect(
      list(afterEdgeAndDefinition, "edges").map((row) => at(row, "id")),
    ).not.toContain(edgeId);
    expect(
      list(afterEdgeAndDefinition, "commandDefinitions").map((row) =>
        at(row, "id"),
      ),
    ).not.toContain(otherDefinition);

    // An object's deletion takes its node and wires down with it, and a
    // deleted workstream stops appearing too — the snapshot matches what
    // the WS stream already announced for each (Epic 2.1).
    await ok(`/objects/${noteId}`, { method: "DELETE" });
    await ok(`/workstreams/${workstream}`, { method: "DELETE" });

    const after = await ok("/snapshot");
    expect(list(after, "objects").map((row) => at(row, "id"))).not.toContain(
      noteId,
    );
    expect(list(after, "nodes").map((row) => at(row, "id"))).not.toContain(
      noteNode,
    );
    expect(
      list(after, "workstreams").map((row) => at(row, "id")),
    ).not.toContain(workstream);

    // A deleted command's own row drops out of `commands`, even though its
    // wires (and its placeholder's content node) stay on the board — the
    // two-state rule leaves nothing silently unblocked (§3.5).
    await ok(`/commands/${command.commandId}`, { method: "DELETE" });
    const afterCommand = await ok("/snapshot");
    expect(
      list(afterCommand, "commands").map((row) => at(row, "id")),
    ).not.toContain(command.commandId);
    expect(list(afterCommand, "outputs").map((row) => at(row, "id"))).toContain(
      command.outputId,
    );
  });

  it("preserves assembly order for a target's context edges (§3.5)", async () => {
    const { workstream, noteNode } = await board();
    const command = await producingCommand(workstream, "Implement");
    const second = await ok("/notes", {
      method: "POST",
      body: { title: "second", body: "more", workstreamId: workstream },
    });
    const secondNode = str(
      await ok("/nodes", {
        method: "POST",
        body: {
          role: "content",
          refId: str(second, "object.id"),
          workstreamId: workstream,
        },
      }),
      "node.id",
    );

    const first = str(
      await ok("/edges", {
        method: "POST",
        body: { from: noteNode, to: command.node },
      }),
      "edge.id",
    );
    const later = str(
      await ok("/edges", {
        method: "POST",
        body: { from: secondNode, to: command.node },
      }),
      "edge.id",
    );

    await ok(`/nodes/${command.node}/context/order`, {
      method: "POST",
      body: { edgeIds: [later, first] },
    });

    const snapshot = await ok("/snapshot");
    const targetEdges = list(snapshot, "edges").filter(
      (row) => at(row, "to") === command.node,
    );

    expect(targetEdges.map((row) => at(row, "id"))).toEqual([later, first]);
    expect(targetEdges.map((row) => at(row, "ordinal"))).toEqual([1, 2]);
  });

  it("stays consistent with the WS stream across a mutation race", async () => {
    const { workstream, noteNode } = await board();
    const command = await producingCommand(workstream, "Implement");

    // Connect first and buffer, exactly the pattern documented next to the
    // route: a client that fetched the snapshot before connecting could
    // miss an event published in the gap.
    const ws = openWebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin },
    });
    const buffered: DomainEvent[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("error", reject);
      ws.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          event?: DomainEvent;
        };
        if (message.type === "hello") resolve();
        if (message.type === "event" && message.event) {
          buffered.push(message.event);
        }
      });
    });

    // The mutation and the snapshot fetch race each other; the invariant
    // under test has to hold whichever one the server happens to serialize
    // first.
    const [, snapshot] = await Promise.all([
      ok("/edges", {
        method: "POST",
        body: { from: noteNode, to: command.node },
      }),
      ok("/snapshot"),
    ]);

    // A round trip plus a tick, so the buffered ws has whatever it is going
    // to get for this mutation.
    await ok("/health");
    await new Promise((resolve) => setTimeout(resolve, 25));
    ws.close();

    const seq = at(snapshot, "seq") as number;
    const edgesById = new Map<string, unknown>(
      list(snapshot, "edges").map((row) => [at(row, "id") as string, row]),
    );

    // Drop anything the snapshot already reflects; apply the rest, in order
    // — exactly the resync recipe documented next to the route.
    for (const event of buffered) {
      if (event.seq <= seq) continue;
      if (event.entity !== "edge") continue;
      if (event.verb === "created") edgesById.set(event.edge.id, event.edge);
      if (event.verb === "deleted") edgesById.delete(event.edgeId);
    }

    // Scoped to what `/context` itself answers — context edges into this
    // one target — since the snapshot's `edges` collection (like the WS
    // stream) also carries provenance edges the endpoint under test does not.
    const reconstructed = new Set(
      [...edgesById.values()]
        .filter(
          (row) =>
            at(row, "kind") === "context" && at(row, "to") === command.node,
        )
        .map((row) => at(row, "id") as string),
    );
    const actual = new Set(
      list(await ok(`/nodes/${command.node}/context`), "inputs").map(
        (row) => at(row, "id") as string,
      ),
    );

    expect(reconstructed).toEqual(actual);
  });
});
