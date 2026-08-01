import { formatMicros } from "../runs.js";
import { healthItemId } from "./ids.js";
import type { AttentionTarget, HealthAlertKind } from "./types.js";

/**
 * Health alerts (§7.2), **derived from observation, never reported by the agent**.
 *
 * Every input below is something PlotRoom already recorded — the observation log,
 * the path-write ledger, the claim waitlist, the question and approval records —
 * folded into one shape by the caller so this module can be a pure function over
 * facts (principle 7, principle 8). Nothing here starts, schedules, or asks for
 * anything: it returns what is true right now, and a caller decides what to do
 * with it (principle 2).
 *
 * Thresholds are configurable because the honest answer to "how long is too long"
 * depends on the work; the defaults below are stated where they can be read and
 * changed rather than buried at a call site.
 */
export interface HealthThresholds {
  /** No output at all for this long, while the session is live: `idle`. */
  readonly idleSeconds: number;
  /** Nothing has changed in the workspace for this long: half of `spinning`. */
  readonly spinningSeconds: number;
  /** ...and this much money went out meanwhile: the other half. */
  readonly spinningCostMicros: number;
  /** A question or approval this old that nobody answered: `unanswered`. */
  readonly unansweredSeconds: number;
  /** A session waiting on a human this long: `blocked-on-you`. */
  readonly blockedOnHumanSeconds: number;
  /**
   * A claim wait this long: `blocked-on-you` on its own (§7.2 says so
   * explicitly), tracked with its own threshold because a queue behind another
   * session is a different wait from one behind the operator.
   */
  readonly claimWaitSeconds: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  idleSeconds: 10 * 60,
  spinningSeconds: 5 * 60,
  // $0.05: enough that a single cheap turn between two writes is not "spinning",
  // small enough that a loop burning money is caught while it is still cents.
  spinningCostMicros: 50_000,
  unansweredSeconds: 5 * 60,
  blockedOnHumanSeconds: 5 * 60,
  claimWaitSeconds: 5 * 60,
};

/** One live session, as the observation log and the write ledger describe it. */
export interface HealthSessionObservation {
  readonly sessionId: string;
  readonly workstreamId: string | null;
  readonly nodeId: string;
  /** False once the session ended: a finished session is not idle, it is done. */
  readonly live: boolean;
  readonly startedAt: number;
  /** The last observation that produced output — deltas and finished turns. */
  readonly lastOutputAt: number;
  /**
   * The last time this session wrote a path (`path_writes`). Null means it has
   * never written one, in which case the workspace has been unchanged since it
   * started — which is exactly what "nothing in the workspace changes" means for
   * a session that has done nothing but talk.
   */
  readonly lastWorkspaceChangeAt: number | null;
  /** What it has spent since that change. Folded from the log, not estimated. */
  readonly costSinceWorkspaceChangeMicros: number;
  /**
   * When the session started waiting on a human — a raised question, a pending
   * approval, a claim grant outside policy. Null when it is not waiting, which is
   * how "time spent waiting is tracked separately from time spent working" is
   * expressed: this clock only runs while the operator is the bottleneck.
   */
  readonly blockedOnHumanSince: number | null;
  /** Why it is waiting, for the row's own sentence. */
  readonly blockedOnHumanReason: string | null;
}

/** A question or approval nobody has answered yet. */
export interface PendingAsk {
  readonly kind: "question" | "approval";
  readonly id: string;
  readonly target: AttentionTarget;
  readonly raisedAt: number;
  readonly summary: string;
}

/** One session's place on a waitlist (§3.4), for both alerts that read it. */
export interface ClaimWaitObservation {
  readonly waitId: string;
  readonly sessionId: string;
  readonly workstreamId: string;
  readonly nodeId: string;
  readonly path: string;
  readonly since: number;
  /** True when nothing but the operator can clear it (§3.4's `approval` reason). */
  readonly blockedOnHuman: boolean;
}

/**
 * What one workstream has been writing, and where. `repositoryId` is the
 * configured source a workspace was provisioned from (`sessions/world.ts`), so a
 * worktree and the checkout it branched from are one repository — which is what
 * makes "the same paths in the same repository" answerable at all.
 */
export interface WorkstreamPathActivity {
  readonly workstreamId: string;
  readonly nodeId: string;
  readonly repositoryId: string | null;
  /** False for a workstream with nothing running: a settled branch is not a conflict. */
  readonly active: boolean;
  readonly writtenPaths: readonly string[];
}

export interface HealthObservations {
  readonly now: number;
  readonly sessions: readonly HealthSessionObservation[];
  readonly pendingAsks: readonly PendingAsk[];
  readonly claimWaits: readonly ClaimWaitObservation[];
  readonly workstreams: readonly WorkstreamPathActivity[];
  readonly thresholds?: HealthThresholds;
}

export interface HealthAlert {
  readonly alert: HealthAlertKind;
  /** The item id, derived from the subject so it survives a re-derivation. */
  readonly id: string;
  readonly target: AttentionTarget;
  readonly summary: string;
  /** When the condition began, which is what the row reports as `raisedAt`. */
  readonly since: number;
}

/**
 * Do two declared paths collide? Same path, or one inside the other.
 *
 * The same vocabulary claims use (§3.4), so "overlapping paths" means one thing
 * across the product rather than one thing per surface.
 */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function deriveHealthAlerts(
  observations: HealthObservations,
): readonly HealthAlert[] {
  const thresholds = observations.thresholds ?? DEFAULT_HEALTH_THRESHOLDS;
  const now = observations.now;

  return [
    ...idleAlerts(observations, thresholds, now),
    ...spinningAlerts(observations, thresholds, now),
    ...conflictAlerts(observations, thresholds, now),
    ...unansweredAlerts(observations, thresholds, now),
    ...blockedOnYouAlerts(observations, thresholds, now),
  ];
}

function idleAlerts(
  observations: HealthObservations,
  thresholds: HealthThresholds,
  now: number,
): readonly HealthAlert[] {
  return observations.sessions
    .filter(
      (session) =>
        session.live && now - session.lastOutputAt >= thresholds.idleSeconds,
    )
    .map((session) => ({
      alert: "idle" as const,
      id: healthItemId("idle", session.sessionId),
      target: targetOf(session),
      summary: `${session.sessionId} has produced no output for ${minutes(now - session.lastOutputAt)}`,
      since: session.lastOutputAt + thresholds.idleSeconds,
    }));
}

/**
 * Spinning: "cost climbing while nothing in the workspace changes."
 *
 * Both halves are required, and neither is a proxy for the other. Money moving
 * on its own is a session thinking; a quiet workspace on its own is a session
 * reading. Together they are the loop worth interrupting.
 */
function spinningAlerts(
  observations: HealthObservations,
  thresholds: HealthThresholds,
  now: number,
): readonly HealthAlert[] {
  const alerts: HealthAlert[] = [];
  for (const session of observations.sessions) {
    if (!session.live) continue;
    const unchangedSince = session.lastWorkspaceChangeAt ?? session.startedAt;
    if (now - unchangedSince < thresholds.spinningSeconds) continue;
    if (
      session.costSinceWorkspaceChangeMicros < thresholds.spinningCostMicros
    ) {
      continue;
    }
    alerts.push({
      alert: "spinning",
      id: healthItemId("spinning", session.sessionId),
      target: targetOf(session),
      summary: `${session.sessionId} has spent ${formatMicros(session.costSinceWorkspaceChangeMicros)} in ${minutes(now - unchangedSince)} without changing anything in the workspace`,
      since: unchangedSince + thresholds.spinningSeconds,
    });
  }
  return alerts;
}

/**
 * Conflict predicted, in both of §7.2's forms — "same path vocabulary, both
 * directions":
 *
 * - **across workstreams**, two active ones writing the same paths in the same
 *   repository (the merge conflict you will hit later);
 * - **inside one workstream**, waitlisted claims that overlap (the contention you
 *   are hitting now).
 */
function conflictAlerts(
  observations: HealthObservations,
  thresholds: HealthThresholds,
  now: number,
): readonly HealthAlert[] {
  const alerts: HealthAlert[] = [];
  const active = observations.workstreams.filter(
    (entry) => entry.active && entry.repositoryId !== null,
  );

  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const one = active[i] as WorkstreamPathActivity;
      const other = active[j] as WorkstreamPathActivity;
      if (one.repositoryId !== other.repositoryId) continue;
      const overlapping = one.writtenPaths.filter((path) =>
        other.writtenPaths.some((candidate) => pathsOverlap(path, candidate)),
      );
      if (overlapping.length === 0) continue;

      // Sorted, so the pair has one id whichever order the workstreams were read
      // in — an id that flipped between reads would be two items for one fact.
      const [first, second] = [one.workstreamId, other.workstreamId].sort();
      alerts.push({
        alert: "conflict-predicted",
        id: healthItemId("conflict-predicted", `${first}:${second}`),
        target: { nodeId: one.nodeId, workstreamId: one.workstreamId },
        summary: `${first} and ${second} are both changing ${overlapping.slice(0, 3).join(", ")} in ${one.repositoryId}`,
        since: now,
      });
    }
  }

  const byWorkstream = new Map<string, ClaimWaitObservation[]>();
  for (const wait of observations.claimWaits) {
    const list = byWorkstream.get(wait.workstreamId);
    if (list) list.push(wait);
    else byWorkstream.set(wait.workstreamId, [wait]);
  }

  for (const [workstreamId, waits] of byWorkstream) {
    for (let i = 0; i < waits.length; i += 1) {
      for (let j = i + 1; j < waits.length; j += 1) {
        const one = waits[i] as ClaimWaitObservation;
        const other = waits[j] as ClaimWaitObservation;
        if (one.sessionId === other.sessionId) continue;
        if (!pathsOverlap(one.path, other.path)) continue;
        const [first, second] = [one.waitId, other.waitId].sort();
        alerts.push({
          alert: "conflict-predicted",
          id: healthItemId(
            "conflict-predicted",
            `${workstreamId}:waitlist:${first}:${second}`,
          ),
          target: { nodeId: one.nodeId, workstreamId },
          summary: `${one.sessionId} and ${other.sessionId} are waiting on overlapping paths (${one.path}, ${other.path}) in ${workstreamId}`,
          since: Math.min(one.since, other.since) + thresholds.claimWaitSeconds,
        });
      }
    }
  }

  return alerts;
}

function unansweredAlerts(
  observations: HealthObservations,
  thresholds: HealthThresholds,
  now: number,
): readonly HealthAlert[] {
  return observations.pendingAsks
    .filter((ask) => now - ask.raisedAt >= thresholds.unansweredSeconds)
    .map((ask) => ({
      alert: "unanswered" as const,
      id: healthItemId("unanswered", `${ask.kind}:${ask.id}`),
      target: ask.target,
      summary: `${ask.kind === "question" ? "a question" : "an approval"} has been waiting ${minutes(now - ask.raisedAt)}: ${ask.summary}`,
      since: ask.raisedAt + thresholds.unansweredSeconds,
    }));
}

/**
 * Blocked on you (§7.2), from two sources kept apart on purpose.
 *
 * A session waiting on the operator is one alert; **a claim wait past a threshold
 * alerts on its own**, with its own clock, because the two are different
 * bottlenecks and reporting them as one number would hide whichever is shorter.
 */
function blockedOnYouAlerts(
  observations: HealthObservations,
  thresholds: HealthThresholds,
  now: number,
): readonly HealthAlert[] {
  const alerts: HealthAlert[] = [];

  for (const session of observations.sessions) {
    const since = session.blockedOnHumanSince;
    if (since === null) continue;
    if (now - since < thresholds.blockedOnHumanSeconds) continue;
    alerts.push({
      alert: "blocked-on-you",
      id: healthItemId("blocked-on-you", session.sessionId),
      target: targetOf(session),
      summary: `${session.sessionId} has been waiting on you for ${minutes(now - since)}${session.blockedOnHumanReason === null ? "" : `: ${session.blockedOnHumanReason}`}`,
      since: since + thresholds.blockedOnHumanSeconds,
    });
  }

  for (const wait of observations.claimWaits) {
    if (now - wait.since < thresholds.claimWaitSeconds) continue;
    alerts.push({
      alert: "blocked-on-you",
      id: healthItemId("blocked-on-you", `claim:${wait.waitId}`),
      target: {
        nodeId: wait.nodeId,
        workstreamId: wait.workstreamId,
        sessionId: wait.sessionId,
      },
      summary: `${wait.sessionId} has been waiting ${minutes(now - wait.since)} for a claim on ${wait.path}${wait.blockedOnHuman ? " that only you can grant" : ""}`,
      since: wait.since + thresholds.claimWaitSeconds,
    });
  }

  return alerts;
}

function targetOf(session: HealthSessionObservation): AttentionTarget {
  return {
    nodeId: session.nodeId,
    workstreamId: session.workstreamId,
    sessionId: session.sessionId,
  };
}

function minutes(seconds: number): string {
  const value = Math.floor(seconds / 60);
  if (value < 1) return `${Math.max(0, Math.floor(seconds))} seconds`;
  if (value === 1) return "1 minute";
  return `${value} minutes`;
}
