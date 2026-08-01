import { describe, expect, it } from "vitest";

import {
  addTombstones,
  clearTombstones,
  withoutTombstoned,
} from "./tombstones.js";

describe("addTombstones", () => {
  it("adds ids to an empty set", () => {
    expect(addTombstones(new Set(), ["a", "b"])).toEqual(new Set(["a", "b"]));
  });

  it("unions with an already-tombstoned set", () => {
    expect(addTombstones(new Set(["a"]), ["b"])).toEqual(new Set(["a", "b"]));
  });

  it("returns an equivalent (not necessarily identical) set for an empty id list", () => {
    const tombstones = new Set(["a"]);
    expect(addTombstones(tombstones, [])).toEqual(tombstones);
  });
});

describe("clearTombstones", () => {
  it("removes only the given ids", () => {
    expect(clearTombstones(new Set(["a", "b", "c"]), ["b"])).toEqual(
      new Set(["a", "c"]),
    );
  });

  it("is a no-op when the id was never tombstoned", () => {
    expect(clearTombstones(new Set(["a"]), ["z"])).toEqual(new Set(["a"]));
  });

  it("leaves an empty set empty", () => {
    expect(clearTombstones(new Set(), ["a"])).toEqual(new Set());
  });
});

describe("withoutTombstoned", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("filters out tombstoned items", () => {
    expect(withoutTombstoned(items, new Set(["b"]))).toEqual([
      { id: "a" },
      { id: "c" },
    ]);
  });

  it("returns everything when nothing is tombstoned", () => {
    expect(withoutTombstoned(items, new Set())).toEqual(items);
  });

  it("supports the add-then-delete-then-undo round trip", () => {
    // This is exactly B1's scenario as a pure sequence: delete tombstones an
    // id, so a subsequent additive sync must not re-add it; undo clears the
    // tombstone, so the id is eligible again afterward.
    let tombstones = new Set<string>();
    tombstones = addTombstones(tombstones, ["b"]);
    expect(withoutTombstoned(items, tombstones)).toEqual([
      { id: "a" },
      { id: "c" },
    ]);

    tombstones = clearTombstones(tombstones, ["b"]);
    expect(withoutTombstoned(items, tombstones)).toEqual(items);
  });
});
