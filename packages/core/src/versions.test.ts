import { describe, expect, it } from "vitest";
import { isCompactable, type ObjectVersion } from "./versions.js";
import type { ObjectId, VersionId } from "./ids.js";

const NOW = 1_000_000;
const WINDOW = 30 * 24 * 60 * 60;

function version(overrides: Partial<ObjectVersion> = {}): ObjectVersion {
  return {
    id: "ver_1" as VersionId,
    objectId: "obj_1" as ObjectId,
    ordinal: 1,
    contentHash: "abc",
    summary: "a version",
    runReferenced: false,
    pinned: false,
    createdAt: NOW - WINDOW - 1,
    ...overrides,
  };
}

const context = (isLatest = false) => ({
  isLatest,
  now: NOW,
  policy: { windowSeconds: WINDOW },
});

describe("the compaction rule (spec §15 invariant 3, §3.2)", () => {
  it("compacts an unreferenced intermediate outside the window", () => {
    expect(isCompactable(version(), context())).toBe(true);
  });

  it("never compacts the latest version", () => {
    expect(isCompactable(version(), context(true))).toBe(false);
  });

  it("never compacts a run-referenced version", () => {
    expect(isCompactable(version({ runReferenced: true }), context())).toBe(
      false,
    );
  });

  it("never compacts a pinned version", () => {
    expect(isCompactable(version({ pinned: true }), context())).toBe(false);
  });

  it("keeps anything inside the window", () => {
    expect(isCompactable(version({ createdAt: NOW - 10 }), context())).toBe(
      false,
    );
  });
});
