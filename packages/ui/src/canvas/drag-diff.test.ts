import { describe, expect, it } from "vitest";

import { diffDraggedPositions, excludeContainers } from "./drag-diff.js";
import type { PositionedNode } from "./arrangement-reset.js";

describe("diffDraggedPositions", () => {
  it("reports the dragged node as changed", () => {
    const before = new Map([["a", { x: 0, y: 0 }]]);
    const after: PositionedNode[] = [{ id: "a", position: { x: 50, y: 0 } }];
    expect(diffDraggedPositions(before, after)).toEqual({
      a: { x: 50, y: 0 },
    });
  });

  it("reports a pushed neighbour alongside the dragged node", () => {
    const before = new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 200, y: 0 }],
    ]);
    const after: PositionedNode[] = [
      { id: "a", position: { x: 210, y: 0 } },
      { id: "b", position: { x: 400, y: 0 } },
    ];
    expect(diffDraggedPositions(before, after)).toEqual({
      a: { x: 210, y: 0 },
      b: { x: 400, y: 0 },
    });
  });

  it("omits a node whose position did not change", () => {
    const before = new Map([
      ["a", { x: 0, y: 0 }],
      ["untouched", { x: 500, y: 500 }],
    ]);
    const after: PositionedNode[] = [
      { id: "a", position: { x: 10, y: 0 } },
      { id: "untouched", position: { x: 500, y: 500 } },
    ];
    expect(diffDraggedPositions(before, after)).toEqual({
      a: { x: 10, y: 0 },
    });
  });

  it("treats a node absent from `before` as changed (never seen at drag-start)", () => {
    const before = new Map<string, { x: number; y: number }>();
    const after: PositionedNode[] = [{ id: "new", position: { x: 1, y: 1 } }];
    expect(diffDraggedPositions(before, after)).toEqual({
      new: { x: 1, y: 1 },
    });
  });

  it("returns an empty object when nothing moved", () => {
    const before = new Map([["a", { x: 0, y: 0 }]]);
    const after: PositionedNode[] = [{ id: "a", position: { x: 0, y: 0 } }];
    expect(diffDraggedPositions(before, after)).toEqual({});
  });

  it("returns an empty object for no nodes", () => {
    expect(diffDraggedPositions(new Map(), [])).toEqual({});
  });
});

describe("excludeContainers", () => {
  it("drops a container's own id from what gets persisted", () => {
    const changed = { ws1: { x: 1, y: 2 }, node1: { x: 3, y: 4 } };
    const nodes = [
      { id: "ws1", type: "container" },
      { id: "node1", type: "box" },
    ];
    expect(excludeContainers(changed, nodes)).toEqual({
      node1: { x: 3, y: 4 },
    });
  });

  it("keeps every box node's own move when no container moved at all", () => {
    const changed = { node1: { x: 3, y: 4 }, node2: { x: 5, y: 6 } };
    const nodes = [
      { id: "node1", type: "box" },
      { id: "node2", type: "box" },
    ];
    const result = excludeContainers(changed, nodes);
    expect(result).toEqual(changed);
    // Referentially unchanged when nothing needed dropping — no reason to
    // allocate a new object for the common case.
    expect(result).toBe(changed);
  });

  it("drops every container even when several moved (a chain pushed two frames)", () => {
    const changed = {
      ws1: { x: 1, y: 1 },
      ws2: { x: 2, y: 2 },
      node1: { x: 3, y: 3 },
    };
    const nodes = [
      { id: "ws1", type: "container" },
      { id: "ws2", type: "container" },
      { id: "node1", type: "box" },
    ];
    expect(excludeContainers(changed, nodes)).toEqual({
      node1: { x: 3, y: 3 },
    });
  });

  it("returns an empty object when only a container moved", () => {
    const changed = { ws1: { x: 1, y: 1 } };
    const nodes = [{ id: "ws1", type: "container" }];
    expect(excludeContainers(changed, nodes)).toEqual({});
  });

  it("is unaffected by a node with no `type` at all (never a container)", () => {
    const changed = { node1: { x: 1, y: 1 } };
    const nodes = [{ id: "node1" }];
    expect(excludeContainers(changed, nodes)).toEqual(changed);
  });
});
