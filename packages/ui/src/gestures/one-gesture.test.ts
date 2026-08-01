import { humanAuthor } from "@plotroom/core";
import type { NodeId } from "@plotroom/core";
import { describe, expect, it } from "vitest";

import {
  collapseCollection,
  createWorkstreamFromDrop,
  dragOutMember,
  expandCollection,
  pruneMember,
} from "./one-gesture.js";
import type { Collection } from "./one-gesture.js";

describe("createWorkstreamFromDrop", () => {
  it("creates a workstream with the ticket as subject and an authored context edge", () => {
    const ticketId = "ticket-1" as NodeId;
    const commandNodeId = "cmd-1" as NodeId;
    const result = createWorkstreamFromDrop(
      ticketId,
      commandNodeId,
      humanAuthor,
      1000,
    );

    expect(result.subjectId).toBe(ticketId);
    expect(result.commandNodeId).toBe(commandNodeId);
    expect(result.contextEdge).toMatchObject({
      kind: "context",
      from: ticketId,
      to: commandNodeId,
      author: humanAuthor,
      ordinal: 0,
      createdAt: 1000,
    });
    // §15-2: every context edge records its author; never absent.
    expect(result.contextEdge.author).toBeDefined();
  });

  it("mints a fresh workstream id per call", () => {
    const a = createWorkstreamFromDrop(
      "t" as NodeId,
      "c" as NodeId,
      humanAuthor,
      0,
    );
    const b = createWorkstreamFromDrop(
      "t" as NodeId,
      "c" as NodeId,
      humanAuthor,
      0,
    );
    expect(a.workstreamId).not.toBe(b.workstreamId);
  });
});

describe("collection gestures", () => {
  const base: Collection = {
    id: "col-1",
    memberIds: ["a", "b", "c"],
    expanded: false,
  };

  it("expands and collapses", () => {
    expect(expandCollection(base).expanded).toBe(true);
    expect(collapseCollection(expandCollection(base)).expanded).toBe(false);
  });

  it("prunes a member without affecting others", () => {
    const pruned = pruneMember(base, "b");
    expect(pruned.memberIds).toEqual(["a", "c"]);
  });

  it("pruning an unknown member is a no-op", () => {
    expect(pruneMember(base, "z")).toEqual(base);
  });

  it("drags a member out: removed from the collection, returned as its own id", () => {
    const result = dragOutMember(base, "a");
    expect(result.draggedId).toBe("a");
    expect(result.collection.memberIds).toEqual(["b", "c"]);
  });

  it("dragging out an unknown member changes nothing", () => {
    const result = dragOutMember(base, "z");
    expect(result.draggedId).toBeNull();
    expect(result.collection).toEqual(base);
  });
});
