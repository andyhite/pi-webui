import { describe, expect, it } from "vitest";
import { isCompactable, DEFAULT_COMPACTION_POLICY } from "./versions.js";
import { isRunCompactable, DEFAULT_RUN_RETENTION_POLICY } from "./runs.js";
import {
  makeCommandDefinition,
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
    expect(makeCommandDefinition().id).not.toBe(makeCommandDefinition().id);
  });

  it("builds a run carrying full content and configuration (§15 invariant 1)", () => {
    const run = makeRun();

    expect(run.assembledBlobId).toBeTruthy();
    expect(run.assembledHash).toBeTruthy();
    expect(run.configuration.instruction).toBeTruthy();
    expect(run.configuration.model.model).toBeTruthy();
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

    expect(
      isRunCompactable(
        {
          pinned: makeRun().pinned,
          startedAt: TEST_EPOCH,
          recencyRank: DEFAULT_RUN_RETENTION_POLICY.keepPerDefinition + 1,
          isLatestForCommand: false,
        },
        { now: clock.now(), policy: DEFAULT_RUN_RETENTION_POLICY },
      ),
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
