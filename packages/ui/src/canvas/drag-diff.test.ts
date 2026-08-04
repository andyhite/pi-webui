import { describe, expect, it } from "vitest";

import { diffDraggedPositions } from "./drag-diff.js";
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
