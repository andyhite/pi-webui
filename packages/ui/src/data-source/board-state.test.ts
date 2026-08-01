import { describe, expect, it } from "vitest";
import { humanAuthor } from "@plotroom/core";
import type { DomainEvent, PlacedNode, Workstream } from "@plotroom/core";

import {
  applyEvent,
  emptyBoardState,
  stateFromSnapshot,
} from "./board-state.js";
import type { RawSnapshot } from "./board-state.js";

const workstream: Workstream = {
  id: "ws_1" as Workstream["id"],
  subjectId: null,
  status: "active",
  archivedAt: null,
  createdAt: 0,
};

const node: PlacedNode = {
  id: "node_1" as PlacedNode["id"],
  role: "content",
  refId: "obj_1",
  workstreamId: null,
  createdAt: 0,
  deletedAt: null,
};

function rawSnapshot(overrides: Partial<RawSnapshot> = {}): RawSnapshot {
  return {
    seq: 0,
    workstreams: [],
    nodes: [],
    edges: [],
    objects: [],
    commandDefinitions: [],
    commands: [],
    outputs: [],
    ...overrides,
  };
}

/** The envelope fields every event carries, so a literal only states its body. */
function envelope(seq: number) {
  return {
    id: `evt_${seq}` as DomainEvent["id"],
    occurredAt: 0,
    author: humanAuthor,
    seq,
  };
}

describe("emptyBoardState", () => {
  it("starts at seq 0 with every map empty", () => {
    const state = emptyBoardState();
    expect(state.seq).toBe(0);
    expect(state.nodes.size).toBe(0);
    expect(state.workstreams.size).toBe(0);
  });
});

describe("stateFromSnapshot", () => {
  it("indexes every row by id", () => {
    const state = stateFromSnapshot(
      rawSnapshot({ seq: 5, workstreams: [workstream], nodes: [node] }),
    );
    expect(state.seq).toBe(5);
    expect(state.workstreams.get(workstream.id)).toEqual(workstream);
    expect(state.nodes.get(node.id)).toEqual(node);
  });
});

describe("applyEvent", () => {
  it("created/updated overwrite the row in full and advance seq", () => {
    const state = emptyBoardState();
    const created: DomainEvent = {
      ...envelope(1),
      entity: "workstream",
      verb: "created",
      workstream,
    };
    const next = applyEvent(state, created);
    expect(next.seq).toBe(1);
    expect(next.workstreams.get(workstream.id)).toEqual(workstream);

    const updatedWorkstream: Workstream = { ...workstream, status: "done" };
    const updated: DomainEvent = {
      ...envelope(2),
      entity: "workstream",
      verb: "updated",
      workstream: updatedWorkstream,
    };
    const afterUpdate = applyEvent(next, updated);
    expect(afterUpdate.workstreams.get(workstream.id)).toEqual(
      updatedWorkstream,
    );
  });

  it("deleted drops the row off the board entirely", () => {
    const state = stateFromSnapshot(rawSnapshot({ nodes: [node] }));
    const deleted: DomainEvent = {
      ...envelope(1),
      entity: "node",
      verb: "deleted",
      nodeId: node.id,
    };
    const next = applyEvent(state, deleted);
    expect(next.nodes.has(node.id)).toBe(false);
  });

  it("re-applying an already-reflected event is a no-op overwrite (idempotent)", () => {
    const state = stateFromSnapshot(
      rawSnapshot({ seq: 3, workstreams: [workstream] }),
    );
    const stale: DomainEvent = {
      ...envelope(1),
      entity: "workstream",
      verb: "created",
      workstream,
    };
    const applyAgain = applyEvent(state, stale);
    expect(applyAgain.workstreams.get(workstream.id)).toEqual(workstream);
  });

  it("does not mutate the previous state's maps", () => {
    const state = stateFromSnapshot(rawSnapshot({ nodes: [node] }));
    const deleted: DomainEvent = {
      ...envelope(1),
      entity: "node",
      verb: "deleted",
      nodeId: node.id,
    };
    applyEvent(state, deleted);
    expect(state.nodes.has(node.id)).toBe(true);
  });

  it("advances seq without touching state for entities the canvas doesn't render yet", () => {
    const state = emptyBoardState();
    const deleted: DomainEvent = {
      ...envelope(9),
      entity: "session",
      verb: "deleted",
      sessionId: "s1" as never,
    };
    const next = applyEvent(state, deleted);
    expect(next.seq).toBe(9);
  });
});
