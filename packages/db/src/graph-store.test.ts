import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { humanAuthor, sessionAuthor, type SessionId } from "@plotroom/core";
import { makeRenderings } from "@plotroom/core/testing";
import { openDatabase, type PlotroomDatabase } from "./client.js";
import {
  ConnectionRefused,
  GraphStore,
  PlacementRefused,
  ScopeRefused,
} from "./graph-store.js";
import { ObjectStore } from "./object-store.js";

let dir: string;
let state: PlotroomDatabase;
let graph: GraphStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-graph-"));
  state = openDatabase({ stateDir: dir });
  graph = new GraphStore(state, () => 1_000_000);
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

const place = {
  content: (ref: string) => graph.place({ role: "content", refId: ref }),
  command: (ref: string) => graph.place({ role: "command", refId: ref }),
  session: (ref: string, running = true) =>
    graph.place({ role: "session", refId: ref, running }),
};

describe("authorship is recorded on every context edge (§15 invariant 2)", () => {
  it("records a human author", () => {
    const edge = graph.addContextEdge({
      from: place.content("obj_1").id,
      to: place.command("cmd_1").id,
      author: humanAuthor,
    });

    expect(edge.authorKind).toBe("human");
    expect(edge.authorSession).toBeNull();
  });

  it("records the session that authored it", () => {
    const edge = graph.addContextEdge({
      from: place.content("obj_1").id,
      to: place.command("cmd_1").id,
      author: sessionAuthor("sess_peer" as SessionId),
    });

    expect(edge.authorKind).toBe("session");
    expect(edge.authorSession).toBe("sess_peer");
  });

  it("cannot write a context edge with no author", () => {
    const node = place.content("obj_1").id;
    const target = place.command("cmd_1").id;

    expect(() =>
      state.sqlite
        .prepare(
          `INSERT INTO edges (id, kind, from_node, to_node, author_kind, ordinal)
           VALUES ('e1', 'context', ?, ?, NULL, 1)`,
        )
        .run(node, target),
    ).toThrow(/NOT NULL constraint failed/);
  });

  it("cannot disguise a context edge as system-recorded", () => {
    const node = place.content("obj_1").id;
    const target = place.command("cmd_1").id;

    expect(() =>
      state.sqlite
        .prepare(
          `INSERT INTO edges (id, kind, from_node, to_node, author_kind, ordinal)
           VALUES ('e1', 'context', ?, ?, 'system', 1)`,
        )
        .run(node, target),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe("legality is enforced by the store, not by the caller (§3.7)", () => {
  it("refuses content into content", () => {
    expect(() =>
      graph.addContextEdge({
        from: place.content("a").id,
        to: place.content("b").id,
        author: humanAuthor,
      }),
    ).toThrow(ConnectionRefused);
  });

  it("refuses content into an ended session", () => {
    const ended = place.session("sess_done", false).id;

    expect(() =>
      graph.addContextEdge({
        from: place.content("a").id,
        to: ended,
        author: humanAuthor,
      }),
    ).toThrow(/fork or re-run/);
  });

  it("accepts injection into a running session", () => {
    const edge = graph.addContextEdge({
      from: place.content("a").id,
      to: place.session("sess_live").id,
      author: humanAuthor,
    });

    expect(edge.kind).toBe("context");
  });

  it("refuses a duplicate wire", () => {
    const from = place.content("a").id;
    const to = place.command("cmd_1").id;
    graph.addContextEdge({ from, to, author: humanAuthor });

    expect(() =>
      graph.addContextEdge({ from, to, author: humanAuthor }),
    ).toThrow(/already wired/);
  });
});

describe("reflexivity is enforced server-side (principle 1)", () => {
  it("refuses a session wiring context into its own descendant", () => {
    graph.recordLineage("sess_parent", null);
    graph.recordLineage("sess_child", "sess_parent");

    const child = place.session("sess_child").id;

    expect(() =>
      graph.addContextEdge({
        from: place.content("finding").id,
        to: child,
        author: sessionAuthor("sess_parent" as SessionId),
      }),
    ).toThrow(/its ancestors, or its descendants/);
  });

  it("allows a peer session to inject into another chain", () => {
    graph.recordLineage("sess_parent", null);
    graph.recordLineage("sess_child", "sess_parent");
    graph.recordLineage("sess_peer", null);

    const edge = graph.addContextEdge({
      from: place.content("finding").id,
      to: place.session("sess_child").id,
      author: sessionAuthor("sess_peer" as SessionId),
    });

    expect(edge.authorSession).toBe("sess_peer");
  });

  it("allows a human to wire anything", () => {
    graph.recordLineage("sess_a", null);

    expect(
      graph.addContextEdge({
        from: place.content("finding").id,
        to: place.session("sess_a").id,
        author: humanAuthor,
      }).authorKind,
    ).toBe("human");
  });
});

describe("ordered context inputs (§3.5)", () => {
  it("appends in gesture order and rearranges by drag", () => {
    const target = place.command("cmd_1").id;
    const first = graph.addContextEdge({
      from: place.content("a").id,
      to: target,
      author: humanAuthor,
    });
    const second = graph.addContextEdge({
      from: place.content("b").id,
      to: target,
      author: humanAuthor,
    });
    const third = graph.addContextEdge({
      from: place.content("c").id,
      to: target,
      author: humanAuthor,
    });

    expect(graph.contextInputs(target).map((e) => e.ordinal)).toEqual([
      1, 2, 3,
    ]);

    graph.reorderContextInputs(target, [third.id, first.id, second.id]);

    expect(graph.contextInputs(target).map((e) => e.id)).toEqual([
      third.id,
      first.id,
      second.id,
    ]);
  });

  it("refuses a partial reorder", () => {
    const target = place.command("cmd_1").id;
    const only = graph.addContextEdge({
      from: place.content("a").id,
      to: target,
      author: humanAuthor,
    });
    graph.addContextEdge({
      from: place.content("b").id,
      to: target,
      author: humanAuthor,
    });

    expect(() => graph.reorderContextInputs(target, [only.id])).toThrow(
      /every current input/,
    );
  });
});

describe("provenance is recorded, never authored (§3.7)", () => {
  it("carries the system author and a relation", () => {
    const edge = graph.recordProvenance(
      place.command("cmd_1").id,
      place.session("sess_1").id,
      "command_started_session",
    );

    expect(edge.authorKind).toBe("system");
    expect(edge.relation).toBe("command_started_session");
    expect(edge.ordinal).toBeNull();
  });

  it("is exempt from the lineage rule: a delegation's result returns freely", () => {
    graph.recordLineage("sess_parent", null);
    graph.recordLineage("sess_child", "sess_parent");

    const output = place.content("finding").id;
    const parent = place.session("sess_parent").id;

    expect(
      graph.recordProvenance(
        place.session("sess_child").id,
        output,
        "session_created_object",
      ).kind,
    ).toBe("provenance");
    expect(
      graph.recordProvenance(output, parent, "session_delegated").kind,
    ).toBe("provenance");
  });
});

describe("command topology has no cycles (§3.7)", () => {
  /** Wire cmd -> session -> output, the shape a real run produces. */
  function produce(commandRef: string, outputRef: string): string {
    const command = place.command(commandRef).id;
    const session = place.session(`sess_${commandRef}`).id;
    const output = place.content(outputRef).id;

    graph.recordProvenance(command, session, "command_started_session");
    graph.recordProvenance(session, output, "session_created_object");

    return output;
  }

  it("refuses a command consuming its own output", () => {
    const output = produce("cmd_a", "out_a");

    expect(() =>
      graph.addContextEdge({
        from: output,
        to: place.command("cmd_a").id,
        author: humanAuthor,
      }),
    ).toThrow(/its own input/);
  });

  it("refuses a transitive cycle", () => {
    const outA = produce("cmd_a", "out_a");
    const outB = produce("cmd_b", "out_b");

    graph.addContextEdge({
      from: outA,
      to: place.command("cmd_b").id,
      author: humanAuthor,
    });

    expect(() =>
      graph.addContextEdge({
        from: outB,
        to: place.command("cmd_a").id,
        author: humanAuthor,
      }),
    ).toThrow(/its own input/);
  });

  it("allows a chain and a diamond", () => {
    const outA = produce("cmd_a", "out_a");
    produce("cmd_b", "out_b");
    produce("cmd_c", "out_c");

    graph.addContextEdge({
      from: outA,
      to: place.command("cmd_b").id,
      author: humanAuthor,
    });
    graph.addContextEdge({
      from: outA,
      to: place.command("cmd_c").id,
      author: humanAuthor,
    });

    expect(graph.contextInputs(place.command("cmd_b").id)).toHaveLength(1);
    expect(graph.contextInputs(place.command("cmd_c").id)).toHaveLength(1);
  });

  it("does not constrain session-to-session injection", () => {
    graph.recordLineage("sess_x", null);
    graph.recordLineage("sess_y", null);

    const fromX = place.content("finding_x").id;
    const fromY = place.content("finding_y").id;

    graph.addContextEdge({
      from: fromX,
      to: place.session("sess_y").id,
      author: sessionAuthor("sess_x" as SessionId),
    });

    expect(
      graph.addContextEdge({
        from: fromY,
        to: place.session("sess_x").id,
        author: sessionAuthor("sess_y" as SessionId),
      }).kind,
    ).toBe("context");
  });
});

describe("the scope rule is enforced at the boundary (§3.3)", () => {
  let objects: ObjectStore;

  beforeEach(() => {
    objects = new ObjectStore(state, () => 1_000_000);
  });

  function localNote(workstreamId: string): string {
    return objects.write({
      kind: "note",
      title: "local finding",
      workstreamId,
      renderings: makeRenderings(),
    }).objectId;
  }

  it("keeps a local object's wires inside its workstream", () => {
    const noteId = localNote("ws_a");
    const note = graph.place({
      role: "content",
      refId: noteId,
      workstreamId: "ws_a",
    });
    const command = graph.place({
      role: "command",
      refId: "cmd_b",
      workstreamId: "ws_b",
    });

    expect(() =>
      graph.addContextEdge({
        from: note.id,
        to: command.id,
        author: humanAuthor,
      }),
    ).toThrow(/promote/);
  });

  it("allows a local object within its own workstream", () => {
    const noteId = localNote("ws_a");
    const note = graph.place({
      role: "content",
      refId: noteId,
      workstreamId: "ws_a",
    });
    const command = graph.place({
      role: "command",
      refId: "cmd_a",
      workstreamId: "ws_a",
    });

    expect(
      graph.addContextEdge({
        from: note.id,
        to: command.id,
        author: humanAuthor,
      }).kind,
    ).toBe("context");
  });

  it("lets a promoted object cross: world objects are free (§3.2)", () => {
    const noteId = localNote("ws_a");
    const note = graph.place({
      role: "content",
      refId: noteId,
      workstreamId: "ws_a",
    });
    const command = graph.place({
      role: "command",
      refId: "cmd_b",
      workstreamId: "ws_b",
    });

    objects.promote(noteId);

    expect(
      graph.addContextEdge({
        from: note.id,
        to: command.id,
        author: humanAuthor,
      }).kind,
    ).toBe("context");
  });

  it("refuses placing a local object into another workstream", () => {
    const noteId = localNote("ws_a");

    expect(() =>
      graph.place({ role: "content", refId: noteId, workstreamId: "ws_b" }),
    ).toThrow(ScopeRefused);
  });
});

describe("placement and recovery", () => {
  it("places one node per subject, however many gestures (principle 9)", () => {
    expect(place.content("obj_1").id).toBe(place.content("obj_1").id);
  });

  it("soft-deletes and restores an edge (principle 10)", () => {
    const target = place.command("cmd_1").id;
    const edge = graph.addContextEdge({
      from: place.content("a").id,
      to: target,
      author: humanAuthor,
    });

    graph.removeEdge(edge.id);
    expect(graph.contextInputs(target)).toHaveLength(0);

    graph.restoreEdge(edge.id);
    expect(graph.contextInputs(target)).toHaveLength(1);
  });
});

describe("removing a node takes its wires with it (principle 10)", () => {
  it("soft-deletes the node and its context edges as one gesture", () => {
    const target = place.command("cmd_1").id;
    const source = place.content("obj_1").id;
    graph.addContextEdge({ from: source, to: target, author: humanAuthor });

    graph.removeNode(source);

    expect(graph.node(source).deletedAt).toBe(1_000_000);
    expect(graph.contextInputs(target)).toHaveLength(0);
    expect(graph.deletedNodes().map((row) => row.id)).toEqual([source]);
    expect(graph.deletedEdges()).toHaveLength(1);
  });

  it("restores exactly what the removal took down", () => {
    const target = place.command("cmd_1").id;
    const kept = place.content("obj_kept").id;
    const removed = place.content("obj_removed").id;
    const separately = graph.addContextEdge({
      from: kept,
      to: target,
      author: humanAuthor,
    });
    graph.addContextEdge({ from: removed, to: target, author: humanAuthor });

    // An edge removed by its own gesture stays removed when an unrelated
    // node's removal is undone.
    graph.removeEdge(separately.id);
    graph.removeNode(removed);
    graph.restoreNode(removed);

    expect(graph.node(removed).deletedAt).toBeNull();
    expect(graph.contextInputs(target).map((row) => row.fromNode)).toEqual([
      removed,
    ]);
  });

  it("refuses to remove a node that does not exist", () => {
    expect(() => graph.removeNode("node_nope")).toThrow(/unknown node/);
  });

  it("reports the wires it took down, and reports a no-op as one", () => {
    const target = place.command("cmd_1").id;
    const source = place.content("obj_1").id;
    const edge = graph.addContextEdge({
      from: source,
      to: target,
      author: humanAuthor,
    });

    const removal = graph.removeNode(source);
    expect(removal.changed).toBe(true);
    expect(removal.edges.map((row) => row.id)).toEqual([edge.id]);

    // Removing it again changes nothing, and says so — nothing downstream
    // should announce a deletion that did not happen.
    const again = graph.removeNode(source);
    expect(again.changed).toBe(false);
    expect(again.edges).toEqual([]);

    const restoration = graph.restoreNode(source);
    expect(restoration.changed).toBe(true);
    expect(restoration.edges.map((row) => row.id)).toEqual([edge.id]);
    expect(graph.restoreNode(source).changed).toBe(false);
  });
});

describe("a removed node is off the board until it is restored", () => {
  it("refuses to place a subject whose node was removed", () => {
    const node = place.content("obj_1");
    graph.removeNode(node.id);

    expect(() => place.content("obj_1")).toThrow(PlacementRefused);
    try {
      place.content("obj_1");
    } catch (err) {
      expect((err as PlacementRefused).refusal.reason).toBe("node_deleted");
    }

    // The undo verb is the one that puts it back, and then placing works.
    graph.restoreNode(node.id);
    expect(place.content("obj_1").id).toBe(node.id);
  });

  it("refuses to wire a removed node, at either end", () => {
    const source = place.content("obj_1").id;
    const target = place.command("cmd_1").id;
    graph.removeNode(source);

    const wire = () =>
      graph.addContextEdge({ from: source, to: target, author: humanAuthor });

    expect(wire).toThrow(ConnectionRefused);
    try {
      wire();
    } catch (err) {
      expect((err as ConnectionRefused).refusal.reason).toBe("node_deleted");
    }

    graph.restoreNode(source);
    graph.removeNode(target);

    expect(wire).toThrow(/removed from the board/);
  });
});

describe("provenance is recorded, never authored (§3.7)", () => {
  it("refuses to remove a provenance edge", () => {
    const command = place.command("cmd_1").id;
    const output = place.content("out_1").id;
    const edge = graph.recordProvenance(
      command,
      output,
      "command_declares_output",
    );

    expect(() => graph.removeEdge(edge.id)).toThrow(ConnectionRefused);
    try {
      graph.removeEdge(edge.id);
    } catch (err) {
      expect((err as ConnectionRefused).refusal.reason).toBe(
        "provenance_not_authored",
      );
    }
    expect(graph.edge(edge.id).deletedAt).toBeNull();
  });
});
