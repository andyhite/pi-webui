import { describe, expect, it } from "vitest";

import { deriveInitialArrangement } from "./derive.js";

describe("deriveInitialArrangement", () => {
  it("places nodes with no edges in one column, ordered by id", () => {
    const placements = deriveInitialArrangement([{ id: "b" }, { id: "a" }], []);
    expect(placements["a"]).toEqual({ x: 0, y: 0 });
    expect(placements["b"]).toEqual({ x: 0, y: 120 });
  });

  it("lays out a chain left to right by topological depth", () => {
    const placements = deriveInitialArrangement(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
    );
    expect(placements["a"]?.x).toBe(0);
    expect(placements["b"]?.x).toBe(220);
    expect(placements["c"]?.x).toBe(440);
  });

  it("places a diamond's join node past its deepest predecessor", () => {
    const placements = deriveInitialArrangement(
      [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
      [
        { source: "a", target: "b" },
        { source: "a", target: "c" },
        { source: "b", target: "d" },
        { source: "c", target: "d" },
      ],
    );
    expect(placements["d"]?.x).toBe(440);
  });

  it("is deterministic regardless of node/edge array order", () => {
    const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const edges = [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ];
    const first = deriveInitialArrangement(nodes, edges);
    const second = deriveInitialArrangement(
      [...nodes].reverse(),
      [...edges].reverse(),
    );
    expect(first).toEqual(second);
  });

  it("terminates and produces a placement for every node even with a cycle", () => {
    const placements = deriveInitialArrangement(
      [{ id: "a" }, { id: "b" }],
      [
        { source: "a", target: "b" },
        { source: "b", target: "a" },
      ],
    );
    expect(Object.keys(placements).sort()).toEqual(["a", "b"]);
  });

  it("positions containers in a column ahead of bare nodes", () => {
    const placements = deriveInitialArrangement(
      [{ id: "bare" }],
      [],
      [{ id: "ws-1" }],
    );
    expect(placements["ws-1"]).toEqual({ x: 0, y: 0 });
    expect(placements["bare"]).toBeDefined();
  });

  it("lays out contained nodes relative to their own container, padded from origin", () => {
    const placements = deriveInitialArrangement(
      [
        { id: "child-a", containerId: "ws-1" },
        { id: "child-b", containerId: "ws-1" },
      ],
      [{ source: "child-a", target: "child-b" }],
      [{ id: "ws-1" }],
    );
    expect(placements["child-a"]).toEqual({ x: 40, y: 60 });
    expect(placements["child-b"]).toEqual({ x: 260, y: 60 });
  });

  it("returns an empty placement set for no nodes or containers", () => {
    expect(deriveInitialArrangement([], [])).toEqual({});
  });
});
