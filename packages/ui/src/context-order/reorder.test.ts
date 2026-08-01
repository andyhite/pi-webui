import { describe, expect, it } from "vitest";

import { reorderContextEdges } from "./reorder.js";

function edges() {
  return [
    { id: "e1", ordinal: 0 },
    { id: "e2", ordinal: 1 },
    { id: "e3", ordinal: 2 },
  ];
}

describe("reorderContextEdges", () => {
  it("moves an edge to a later position", () => {
    const result = reorderContextEdges(edges(), "e1", 2);
    expect(result.map((e) => e.id)).toEqual(["e2", "e3", "e1"]);
    expect(result.map((e) => e.ordinal)).toEqual([0, 1, 2]);
  });

  it("moves an edge to an earlier position", () => {
    const result = reorderContextEdges(edges(), "e3", 0);
    expect(result.map((e) => e.id)).toEqual(["e3", "e1", "e2"]);
  });

  it("clamps an out-of-range target index", () => {
    const result = reorderContextEdges(edges(), "e1", 999);
    expect(result.map((e) => e.id)).toEqual(["e2", "e3", "e1"]);
  });

  it("renumbers ordinals densely even if the input had gaps", () => {
    const gapped = [
      { id: "e1", ordinal: 0 },
      { id: "e2", ordinal: 5 },
    ];
    const result = reorderContextEdges(gapped, "e2", 0);
    expect(result).toEqual([
      { id: "e2", ordinal: 0 },
      { id: "e1", ordinal: 1 },
    ]);
  });

  it("leaves order unchanged for an unknown edge id but still renumbers", () => {
    const result = reorderContextEdges(edges(), "missing", 0);
    expect(result.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
  });
});
