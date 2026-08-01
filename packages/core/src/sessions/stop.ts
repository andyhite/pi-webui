import type { SessionId, WorkstreamId } from "../ids.js";

/**
 * Stopping, at three scopes (§6.7).
 *
 * "Stop at three scopes — one session, every session in a workstream,
 * everything running. A stop names how many it will affect, is disabled when
 * nothing is running, and confirms at the widest scope."
 *
 * All four of those clauses are this one function's output, so the button, the
 * keyboard shortcut, and the agent tool cannot disagree about what a stop is
 * about to do. Nothing here stops anything: it resolves the scope and reports
 * what a stop would reach.
 */

export const STOP_SCOPE_KINDS = [
  "session",
  "workstream",
  "everything",
] as const;

export type StopScopeKind = (typeof STOP_SCOPE_KINDS)[number];

export type StopScope =
  | { readonly kind: "session"; readonly sessionId: SessionId }
  | { readonly kind: "workstream"; readonly workstreamId: WorkstreamId }
  | { readonly kind: "everything" };

/**
 * The minimum a stop needs to know about a session. `BroadcastMember` is
 * assignable to this, so one view of the running fleet feeds both surfaces.
 */
export interface StopCandidate {
  readonly sessionId: SessionId;
  readonly workstreamId: WorkstreamId;
  readonly running: boolean;
}

export interface StopPlan {
  readonly scope: StopScope;
  /** Exactly what would be stopped, running only. */
  readonly sessionIds: readonly SessionId[];
  readonly workstreamIds: readonly WorkstreamId[];
  /** The number the gesture names before it is made (§6.7). */
  readonly count: number;
  /** False when nothing is running in scope — the gesture is disabled, not silent. */
  readonly enabled: boolean;
  /** True at the widest scope only: "confirms at the widest scope" (§6.7). */
  readonly requiresConfirmation: boolean;
  /** The sentence the surface shows, so every surface shows the same one. */
  readonly description: string;
}

export function resolveStop(
  candidates: readonly StopCandidate[],
  scope: StopScope,
): StopPlan {
  const inScope = candidates.filter((candidate) => {
    if (!candidate.running) return false;
    switch (scope.kind) {
      case "session":
        return candidate.sessionId === scope.sessionId;
      case "workstream":
        return candidate.workstreamId === scope.workstreamId;
      case "everything":
        return true;
    }
  });

  const sessionIds = inScope.map((candidate) => candidate.sessionId);
  const workstreamIds = [
    ...new Set(inScope.map((candidate) => candidate.workstreamId)),
  ];

  return {
    scope,
    sessionIds,
    workstreamIds,
    count: sessionIds.length,
    enabled: sessionIds.length > 0,
    // Only "everything" confirms. A workstream stop is a bounded, visible
    // gesture; making it confirm too would train the operator to dismiss the
    // confirmation that matters.
    requiresConfirmation: scope.kind === "everything",
    description: describeStop(scope, sessionIds.length, workstreamIds.length),
  };
}

function describeStop(
  scope: StopScope,
  sessions: number,
  workstreams: number,
): string {
  if (sessions === 0) return "nothing is running";
  const plural = sessions === 1 ? "session" : "sessions";
  switch (scope.kind) {
    case "session":
      return `stop this session`;
    case "workstream":
      return `stop ${sessions} ${plural} in this workstream`;
    case "everything":
      return `stop ${sessions} ${plural} across ${workstreams} ${
        workstreams === 1 ? "workstream" : "workstreams"
      }`;
  }
}
