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
  newCommandDefinitionId,
  newCommandId,
  newObjectId,
  newOutputId,
  newRunId,
  newVersionId,
  newWorkstreamId,
} from "./ids.js";
import {
  DEFAULT_CONTENT_BUDGET,
  type CommandDefinition,
  type CommandNode,
  type CommandOutput,
} from "./commands.js";
import type { PlotObject } from "./objects.js";
import type { Renderings } from "./renderings.js";
import { ZERO_COST, type Run, type RunConfiguration } from "./runs.js";
import type { ObjectVersion } from "./versions.js";
import type { Workstream } from "./workstreams.js";

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

export function makeWorkstream(
  overrides: Partial<Workstream> = {},
): Workstream {
  return {
    id: newWorkstreamId(),
    subjectId: null,
    status: "active",
    archivedAt: null,
    createdAt: TEST_EPOCH,
    ...overrides,
  };
}

export function makeCommandDefinition(
  overrides: Partial<CommandDefinition> = {},
): CommandDefinition {
  return {
    id: newCommandDefinitionId(),
    name: "Implement the ticket",
    instruction: "Read the ticket, implement it, and open a pull request.",
    model: { model: "fixture-model", effort: "medium" },
    permissions: { allowed: ["read", "write"], denied: [] },
    askPoints: [],
    lifecycle: "producing",
    outcome: { name: "pull_request", kind: "pull_request", conditions: [] },
    parameters: [],
    budget: DEFAULT_CONTENT_BUDGET,
    source: "user",
    folder: null,
    duplicatedFrom: null,
    createdAt: TEST_EPOCH,
    updatedAt: TEST_EPOCH,
    ...overrides,
  };
}

export function makeCommandNode(
  overrides: Partial<CommandNode> = {},
): CommandNode {
  return {
    id: newCommandId(),
    definitionId: newCommandDefinitionId(),
    workstreamId: newWorkstreamId(),
    createdAt: TEST_EPOCH,
    deletedAt: null,
    ...overrides,
  };
}

export function makeCommandOutput(
  overrides: Partial<CommandOutput> = {},
): CommandOutput {
  return {
    id: newOutputId(),
    commandId: newCommandId(),
    name: "pull_request",
    kind: "pull_request",
    publishedAt: null,
    boundObjectId: null,
    boundRunId: null,
    boundAt: null,
    brokenAt: null,
    ...overrides,
  };
}

export function makeRunConfiguration(
  overrides: Partial<RunConfiguration> = {},
): RunConfiguration {
  const definition = makeCommandDefinition();

  return {
    definitionId: definition.id,
    definitionName: definition.name,
    instruction: definition.instruction,
    model: definition.model,
    permissions: definition.permissions,
    askPoints: ["irreversible_write"],
    lifecycle: definition.lifecycle,
    outcome: definition.outcome,
    parameters: {},
    budget: definition.budget,
    ...overrides,
  };
}

/**
 * A run carrying both halves of §15 invariant 1 — the full assembled content
 * and the configuration it ran under — plus the ordinal that is the `n` in
 * `output@n` (§15 invariant 4). There is no way to build a run fixture without
 * them, which is the invariant restated as a type.
 */
export function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: newRunId(),
    commandId: newCommandId(),
    definitionId: newCommandDefinitionId(),
    ordinal: 1,
    status: "completed",
    assembledBlobId: "blob_fixture",
    assembledHash: "fixture-hash",
    assembledBytes: 32,
    configuration: makeRunConfiguration(),
    inputs: [],
    cost: ZERO_COST,
    /** No cap accepted, which is what a run with no preview behind it means. */
    spendCapMicros: null,
    pinned: false,
    startedAt: TEST_EPOCH,
    endedAt: TEST_EPOCH + 60,
    ...overrides,
  };
}
