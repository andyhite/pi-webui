import { describe, expect, it } from "vitest";

import { reconcileAuthoredPlacements } from "./reconcile.js";

describe("reconcileAuthoredPlacements", () => {
  it("adopts a newly authored position", () => {
    const result = reconcileAuthoredPlacements(
      {},
      new Map([["a", { x: 10, y: 20 }]]),
    );
    expect(result.changed).toBe(true);
    expect(result.placements).toEqual({ a: { x: 10, y: 20 } });
  });

  it("reports no change when the authored position already matches", () => {
    const current = { a: { x: 10, y: 20 } };
    const result = reconcileAuthoredPlacements(
      current,
      new Map([["a", { x: 10, y: 20 }]]),
    );
    expect(result.changed).toBe(false);
    // Referentially unchanged, so a caller can skip re-rendering.
    expect(result.placements).toBe(current);
  });

  it("updates when a remote client moved a node this canvas already shows", () => {
    const current = { a: { x: 10, y: 20 } };
    const result = reconcileAuthoredPlacements(
      current,
      new Map([["a", { x: 99, y: 99 }]]),
    );
    expect(result.changed).toBe(true);
    expect(result.placements).toEqual({ a: { x: 99, y: 99 } });
  });

  it("drops a locally-held entry whose authored position is now null (a reset elsewhere)", () => {
    const current = { a: { x: 10, y: 20 } };
    const result = reconcileAuthoredPlacements(current, new Map([["a", null]]));
    expect(result.changed).toBe(true);
    expect(result.placements).toEqual({});
  });

  it("ignores a null authored position for an id with no local entry", () => {
    const current = { b: { x: 1, y: 1 } };
    const result = reconcileAuthoredPlacements(current, new Map([["a", null]]));
    expect(result.changed).toBe(false);
    expect(result.placements).toBe(current);
  });

  it("leaves an untouched id's local entry alone", () => {
    const current = { a: { x: 10, y: 20 }, b: { x: 1, y: 1 } };
    const result = reconcileAuthoredPlacements(
      current,
      new Map([["a", { x: 10, y: 20 }]]),
    );
    expect(result.changed).toBe(false);
    expect(result.placements).toEqual({
      a: { x: 10, y: 20 },
      b: { x: 1, y: 1 },
    });
  });

  it("folds several ids in one pass", () => {
    const result = reconcileAuthoredPlacements(
      { a: { x: 0, y: 0 } },
      new Map([
        ["a", { x: 5, y: 5 }],
        ["b", { x: 6, y: 6 }],
        ["c", null],
      ]),
    );
    expect(result.changed).toBe(true);
    expect(result.placements).toEqual({ a: { x: 5, y: 5 }, b: { x: 6, y: 6 } });
  });
});
