import { describe, expect, it } from "vitest";
import { isCompactable, DEFAULT_COMPACTION_POLICY } from "./versions.js";
import {
  makeObject,
  makeRun,
  makeVersion,
  manualClock,
  TEST_EPOCH,
} from "./testing.js";

describe("factories (Epic 1.0)", () => {
  it("makes complete values with distinct ids", () => {
    expect(makeObject().id).not.toBe(makeObject().id);
    expect(makeVersion().id).not.toBe(makeVersion().id);
    expect(makeRun().id).not.toBe(makeRun().id);
  });

  it("applies overrides", () => {
    expect(makeObject({ kind: "note", scope: "local" }).kind).toBe("note");
    expect(makeVersion({ pinned: true }).pinned).toBe(true);
    expect(makeRun({ ordinal: 3 }).ordinal).toBe(3);
  });

  it("produces values the domain predicates accept", () => {
    const clock = manualClock();
    clock.advance(DEFAULT_COMPACTION_POLICY.windowSeconds + 1);

    const version = makeVersion();
    expect(
      isCompactable(version, {
        isLatest: false,
        now: clock.now(),
        policy: DEFAULT_COMPACTION_POLICY,
      }),
    ).toBe(true);
  });
});

describe("manual clock (Epic 1.0)", () => {
  it("stands still until advanced", () => {
    const clock = manualClock();
    expect(clock.now()).toBe(TEST_EPOCH);
    expect(clock.now()).toBe(TEST_EPOCH);

    clock.advance(60);
    expect(clock.now()).toBe(TEST_EPOCH + 60);

    clock.set(42);
    expect(clock.now()).toBe(42);
  });
});
