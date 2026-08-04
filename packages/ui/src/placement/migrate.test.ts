import { describe, expect, it } from "vitest";

import { localPlacementsToMigrate } from "./migrate.js";

describe("localPlacementsToMigrate", () => {
  it("returns the local placements when the server has authored none", () => {
    const local = { a: { x: 1, y: 2 } };
    expect(localPlacementsToMigrate(local, 0)).toEqual(local);
  });

  it("returns null when the server already has at least one authored position", () => {
    const local = { a: { x: 1, y: 2 } };
    expect(localPlacementsToMigrate(local, 1)).toBeNull();
  });

  it("returns null when there is nothing local to migrate, even on a bare server", () => {
    expect(localPlacementsToMigrate({}, 0)).toBeNull();
  });

  it("never pushes over a board someone has already arranged by hand", () => {
    const local = { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } };
    expect(localPlacementsToMigrate(local, 5)).toBeNull();
  });
});
