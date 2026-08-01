import { describe, expect, it } from "vitest";

import { clusterOffScreenAttention } from "./off-screen.js";

const viewport = { x: 0, y: 0, width: 100, height: 100 };

describe("clusterOffScreenAttention", () => {
  it("produces no markers for nodes inside the viewport", () => {
    expect(
      clusterOffScreenAttention([{ id: "a", x: 50, y: 50 }], viewport),
    ).toEqual([]);
  });

  it("withdraws a marker once its node re-enters the viewport", () => {
    const outside = [{ id: "a", x: -50, y: 50 }];
    expect(clusterOffScreenAttention(outside, viewport)).toEqual([
      { sector: "w", count: 1, nodeIds: ["a"] },
    ]);

    const backInside = [{ id: "a", x: 50, y: 50 }];
    expect(clusterOffScreenAttention(backInside, viewport)).toEqual([]);
  });

  it("clusters multiple nodes in the same sector with a count", () => {
    const nodes = [
      { id: "a", x: 200, y: 50 },
      { id: "b", x: 300, y: 60 },
    ];
    expect(clusterOffScreenAttention(nodes, viewport)).toEqual([
      { sector: "e", count: 2, nodeIds: ["a", "b"] },
    ]);
  });

  it("assigns diagonal sectors", () => {
    expect(
      clusterOffScreenAttention([{ id: "a", x: -10, y: -10 }], viewport),
    ).toEqual([{ sector: "nw", count: 1, nodeIds: ["a"] }]);
    expect(
      clusterOffScreenAttention([{ id: "a", x: 200, y: 200 }], viewport),
    ).toEqual([{ sector: "se", count: 1, nodeIds: ["a"] }]);
  });

  it("splits nodes across sectors into separate markers", () => {
    const nodes = [
      { id: "a", x: -10, y: 50 },
      { id: "b", x: 200, y: 50 },
    ];
    const result = clusterOffScreenAttention(nodes, viewport);
    expect(result).toHaveLength(2);
    expect(result.find((m) => m.sector === "w")?.nodeIds).toEqual(["a"]);
    expect(result.find((m) => m.sector === "e")?.nodeIds).toEqual(["b"]);
  });
});
