import { describe, expect, it } from "vitest";

import { localPlacementsToMigrate } from "./migrate.js";

describe("localPlacementsToMigrate", () => {
  it("returns the local placements when the server has authored none", () => {
    const local = { a: { x: 1, y: 2 } };
    expect(localPlacementsToMigrate(local, 0, new Set(["a"]))).toEqual(local);
  });

  it("returns null when the server already has at least one authored position", () => {
    const local = { a: { x: 1, y: 2 } };
    expect(localPlacementsToMigrate(local, 1, new Set(["a"]))).toBeNull();
  });

  it("returns null when there is nothing local to migrate, even on a bare server", () => {
    expect(localPlacementsToMigrate({}, 0, new Set())).toBeNull();
  });

  it("never pushes over a board someone has already arranged by hand", () => {
    const local = { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } };
    expect(localPlacementsToMigrate(local, 5, new Set(["a", "b"]))).toBeNull();
  });

  it("drops a stale id the live graph no longer has, rather than refusing the whole batch", () => {
    const local = { a: { x: 1, y: 2 }, deleted: { x: 9, y: 9 } };
    expect(localPlacementsToMigrate(local, 0, new Set(["a"]))).toEqual({
      a: { x: 1, y: 2 },
    });
  });

  it("returns null when every local id is stale, even though the map itself is non-empty", () => {
    const local = { deleted: { x: 9, y: 9 } };
    expect(localPlacementsToMigrate(local, 0, new Set(["a"]))).toBeNull();
  });
});
