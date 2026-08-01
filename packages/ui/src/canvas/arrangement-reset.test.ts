import { describe, expect, it } from "vitest";

import { applyArrangementReset } from "./arrangement-reset.js";
import type { PositionedNode } from "./arrangement-reset.js";

describe("applyArrangementReset", () => {
  it("moves a node to its placement", () => {
    const nodes: PositionedNode[] = [{ id: "a", position: { x: 0, y: 0 } }];
    const result = applyArrangementReset(nodes, { a: { x: 100, y: 200 } });
    expect(result).toEqual([{ id: "a", position: { x: 100, y: 200 } }]);
  });

  it("resets multiple nodes independently", () => {
    const nodes: PositionedNode[] = [
      { id: "a", position: { x: 0, y: 0 } },
      { id: "b", position: { x: 10, y: 10 } },
    ];
    const result = applyArrangementReset(nodes, {
      a: { x: 100, y: 100 },
      b: { x: 220, y: 0 },
    });
    expect(result).toEqual([
      { id: "a", position: { x: 100, y: 100 } },
      { id: "b", position: { x: 220, y: 0 } },
    ]);
  });

  it("keeps a node's current position when placements has no entry for it", () => {
    const node: PositionedNode = { id: "a", position: { x: 5, y: 5 } };
    const result = applyArrangementReset([node], {});
    expect(result).toEqual([{ id: "a", position: { x: 5, y: 5 } }]);
    // Referentially unchanged, so callers can skip re-rendering it.
    expect(result[0]).toBe(node);
  });

  it("keeps a node referentially identical when its placement already matches", () => {
    const node: PositionedNode = { id: "a", position: { x: 100, y: 200 } };
    const result = applyArrangementReset([node], { a: { x: 100, y: 200 } });
    expect(result[0]).toBe(node);
  });

  it("preserves every other field on the node (container/box node shape)", () => {
    const node = {
      id: "a",
      type: "box" as const,
      position: { x: 0, y: 0 },
      data: { label: "a node" },
    };
    const result = applyArrangementReset([node], { a: { x: 50, y: 50 } });
    expect(result).toEqual([
      {
        id: "a",
        type: "box",
        position: { x: 50, y: 50 },
        data: { label: "a node" },
      },
    ]);
  });

  it("returns an empty array for no nodes", () => {
    expect(applyArrangementReset([], { a: { x: 1, y: 1 } })).toEqual([]);
  });
});
