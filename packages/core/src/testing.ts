/**
 * Test fixtures and factories (Epic 1.0), exported as `@plotroom/core/testing`
 * so tests in any package build domain values the same way without the
 * factories leaking into the production API surface.
 *
 * Every factory returns a complete, valid value and accepts overrides, the
 * pattern the earliest tests established inline.
 */
import type { Clock } from "./clock.js";
import {
  newCommandId,
  newObjectId,
  newRunId,
  newVersionId,
  type CommandId,
  type ObjectId,
  type RunId,
  type VersionId,
} from "./ids.js";
import type { PlotObject } from "./objects.js";
import type { Renderings } from "./renderings.js";
import type { ObjectVersion } from "./versions.js";

/** A fixed, obviously fake instant; far enough from zero to survive windows. */
export const TEST_EPOCH = 1_000_000;

export interface ManualClock {
  readonly now: Clock;
  /** Move time forward; retention and drift tests advance, never sleep. */
  advance(seconds: number): void;
  set(seconds: number): void;
}

/** An injectable clock the test controls (Epic 1.0). */
export function manualClock(start: number = TEST_EPOCH): ManualClock {
  let current = start;
  return {
    now: () => current,
    advance: (seconds) => {
      current += seconds;
    },
    set: (seconds) => {
      current = seconds;
    },
  };
}

export function makeRenderings(
  overrides: Partial<Renderings> = {},
): Renderings {
  return {
    card: { status: "open" },
    summary: "a fixture object",
    agentContent: "fixture content, agent-ready",
    ...overrides,
  };
}

export function makeObject(overrides: Partial<PlotObject> = {}): PlotObject {
  const latestVersionId = overrides.latestVersionId ?? newVersionId();
  return {
    id: newObjectId(),
    kind: "ticket",
    scope: "world",
    workstreamId: null,
    external: null,
    title: "OXY-2982 · Fix drift flags",
    latestVersionId,
    createdAt: TEST_EPOCH,
    promotedAt: null,
    ...overrides,
  };
}

export function makeVersion(
  overrides: Partial<ObjectVersion> = {},
): ObjectVersion {
  return {
    id: newVersionId(),
    objectId: newObjectId(),
    ordinal: 1,
    contentHash: "fixture-hash",
    summary: "a fixture version",
    runReferenced: false,
    pinned: false,
    createdAt: TEST_EPOCH,
    ...overrides,
  };
}

/**
 * A minimal run stand-in until Epic 1.4 lands the real run model. It carries
 * only what retention and addressing fixtures need — which versions the run
 * consumed (§15 invariant 3) and an ordinal for `output@n` (§15 invariant 4).
 * This is deliberately not a schema; the domain Run replaces it.
 */
export interface RunFixture {
  readonly id: RunId;
  readonly commandId: CommandId;
  /** 1-based per command: the `n` in `output@n`. */
  readonly ordinal: number;
  readonly consumedVersionIds: readonly VersionId[];
  readonly pinned: boolean;
  readonly startedAt: number;
}

export function makeRun(overrides: Partial<RunFixture> = {}): RunFixture {
  return {
    id: newRunId(),
    commandId: newCommandId(),
    ordinal: 1,
    consumedVersionIds: [],
    pinned: false,
    startedAt: TEST_EPOCH,
    ...overrides,
  };
}
