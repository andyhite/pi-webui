import { describe, expect, it } from "vitest";

import type { StorageLike } from "./store.js";
import {
  createMemoryPlacementStore,
  createWebStoragePlacementStore,
  parsePlacements,
} from "./store.js";

function fakeStorage(initial: Record<string, string> = {}): StorageLike & {
  readonly data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? (data[key] as string) : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe("parsePlacements", () => {
  it("returns empty for missing content", () => {
    expect(parsePlacements(null)).toEqual({});
  });

  it("returns empty for corrupt JSON", () => {
    expect(parsePlacements("{not json")).toEqual({});
  });

  it("returns empty for non-object JSON", () => {
    expect(parsePlacements('"hello"')).toEqual({});
    expect(parsePlacements("[1,2]")).toEqual({});
  });

  it("drops entries that are not finite points", () => {
    const raw = JSON.stringify({
      good: { x: 1, y: 2 },
      bad: { x: "1", y: 2 },
      worse: null,
      nan: { x: NaN, y: 0 },
    });
    expect(parsePlacements(raw)).toEqual({ good: { x: 1, y: 2 } });
  });
});

describe("createWebStoragePlacementStore", () => {
  it("round-trips placements through storage", async () => {
    const storage = fakeStorage();
    const store = createWebStoragePlacementStore(storage, "plotroom.test");
    const placements = { a: { x: 10, y: 20 }, b: { x: -5, y: 0 } };

    await store.save(placements);
    await expect(store.load()).resolves.toEqual(placements);
  });

  it("loads empty when nothing was ever saved", async () => {
    const store = createWebStoragePlacementStore(fakeStorage(), "k");
    await expect(store.load()).resolves.toEqual({});
  });

  it("survives corrupt stored state by starting empty", async () => {
    const storage = fakeStorage({ k: "!!" });
    const store = createWebStoragePlacementStore(storage, "k");
    await expect(store.load()).resolves.toEqual({});
  });

  it("keys stores independently", async () => {
    const storage = fakeStorage();
    const one = createWebStoragePlacementStore(storage, "one");
    const two = createWebStoragePlacementStore(storage, "two");

    await one.save({ a: { x: 1, y: 1 } });
    await expect(two.load()).resolves.toEqual({});
  });
});

describe("createMemoryPlacementStore", () => {
  it("round-trips placements", async () => {
    const store = createMemoryPlacementStore();
    await store.save({ a: { x: 3, y: 4 } });
    await expect(store.load()).resolves.toEqual({ a: { x: 3, y: 4 } });
  });

  it("starts from the provided initial placements", async () => {
    const store = createMemoryPlacementStore({ a: { x: 1, y: 2 } });
    await expect(store.load()).resolves.toEqual({ a: { x: 1, y: 2 } });
  });
});
