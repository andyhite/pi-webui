/**
 * Fixtures for the sessions subtree, in the shape `@plotroom/core/testing`
 * established: every factory returns a complete, valid value and accepts
 * overrides. Kept beside the code it builds values for and imported directly by
 * this subtree's tests, so the factories stay out of the package's API surface.
 */
import { humanAuthor } from "../author.js";
import {
  newObjectId,
  newSessionId,
  newVersionId,
  newWorkstreamId,
  type ObjectId,
  type VersionId,
} from "../ids.js";
import type { Session } from "./session.js";
import { startSession } from "./session.js";
import type { SessionLaunchChoices } from "./runtime.js";
import { INHERIT_APP_TOOLS } from "./runtime.js";
import type { Transcript, TranscriptTurn } from "./transcript.js";

export const TEST_EPOCH_MS = 1_700_000_000_000;

export function makeLaunchChoices(
  overrides: Partial<SessionLaunchChoices> = {},
): SessionLaunchChoices {
  return {
    model: "anthropic/claude-sonnet-4",
    effort: "medium",
    toolPermissions: INHERIT_APP_TOOLS,
    ...overrides,
  };
}

export function makeSession(overrides: Partial<Session> = {}): Session {
  const session = startSession(
    {
      id: newSessionId(),
      workstreamId: newWorkstreamId(),
      commandId: null,
      mode: "open",
      launch: makeLaunchChoices(),
      initiatedBy: humanAuthor,
      runtime: { adapterId: "omp-session-host", ref: "session-1" },
    },
    1_000_000,
  );
  return { ...session, ...overrides };
}

export function makeTurn(
  overrides: Partial<TranscriptTurn> = {},
): TranscriptTurn {
  return {
    ordinal: 1,
    startedAt: 1_000_000,
    entries: [{ kind: "output", text: "a fixture turn" }],
    ...overrides,
  };
}

export function makeTranscript(
  overrides: Partial<Transcript> = {},
): Transcript {
  return {
    sessionId: newSessionId(),
    turns: [makeTurn()],
    ...overrides,
  };
}

/** Stable ids for graph fixtures, so drift assertions read as sentences. */
export function objectIds<T extends string>(
  ...names: T[]
): Record<T, ObjectId> {
  return Object.fromEntries(
    names.map((name) => [name, newObjectId()]),
  ) as Record<T, ObjectId>;
}

export function versionIds<T extends string>(
  ...names: T[]
): Record<T, VersionId> {
  return Object.fromEntries(
    names.map((name) => [name, newVersionId()]),
  ) as Record<T, VersionId>;
}
