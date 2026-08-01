import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_RETENTION_POLICY,
  isRunCompactable,
  type RunRetentionFacts,
} from "./runs.js";

const NOW = 1_000_000;
const WINDOW = DEFAULT_RUN_RETENTION_POLICY.windowSeconds;
const KEEP = DEFAULT_RUN_RETENTION_POLICY.keepPerDefinition;

function run(overrides: Partial<RunRetentionFacts> = {}): RunRetentionFacts {
  return {
    pinned: false,
    startedAt: NOW - WINDOW - 1,
    recencyRank: KEEP + 1,
    addressedByLatest: false,
    ...overrides,
  };
}

const context = { now: NOW, policy: DEFAULT_RUN_RETENTION_POLICY };

describe("the run-history retention rule (spec §4.4)", () => {
  it("compacts an old, unpinned run past the last N for its definition", () => {
    expect(isRunCompactable(run(), context)).toBe(true);
  });

  it("keeps the last N runs per definition", () => {
    expect(isRunCompactable(run({ recencyRank: KEEP }), context)).toBe(false);
  });

  it("never compacts a pinned run", () => {
    expect(isRunCompactable(run({ pinned: true }), context)).toBe(false);
  });

  it("never compacts the run `latest` resolves to", () => {
    expect(isRunCompactable(run({ addressedByLatest: true }), context)).toBe(
      false,
    );
  });

  it("keeps everything inside the configurable window", () => {
    expect(isRunCompactable(run({ startedAt: NOW - 10 }), context)).toBe(false);
  });

  it("honours a narrower configured window", () => {
    expect(
      isRunCompactable(run({ startedAt: NOW - 100 }), {
        now: NOW,
        policy: { keepPerDefinition: 1, windowSeconds: 50 },
      }),
    ).toBe(true);
  });
});
