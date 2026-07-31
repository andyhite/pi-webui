import type { Author } from "./author.js";
import type { ObjectId, WorkstreamId } from "./ids.js";
import type { ObjectScope } from "./objects.js";

/**
 * Spec §3.3: the container between "a node" and "the graph". One workstream
 * holds one piece of work — identity, isolation, zoom boundary, attention
 * rollup.
 */
export const WORKSTREAM_STATUSES = ["active", "done", "abandoned"] as const;

export type WorkstreamStatus = (typeof WORKSTREAM_STATUSES)[number];

export interface Workstream {
  readonly id: WorkstreamId;
  /**
   * Authored and optional: dragging a ticket in gives the container its
   * identity, and a subject-less scratch workstream is legal (§3.3).
   */
  readonly subjectId: ObjectId | null;
  /** Authored, never auto-transitioned; the product only suggests (§3.3). */
  readonly status: WorkstreamStatus;
  /**
   * Archive is a gesture, not a lifecycle state: an archived workstream
   * leaves the board, stays searchable reported as archived, and the gesture
   * is recoverable like every operation on authored state (§3.3).
   */
  readonly archivedAt: number | null;
  readonly createdAt: number;
}

/**
 * Spec §3.3: "the human sets them; an agent may propose a lifecycle change".
 * Direct lifecycle mutation — status and the archive gesture — is therefore
 * human-only; a session goes through propose-and-accept (Phase 6 approvals).
 * One predicate so the canvas, the API, and agent tools refuse identically.
 */
export type LifecycleRefusal = {
  readonly reason: "session_sets_lifecycle";
  readonly message: string;
};

export type LifecycleCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: LifecycleRefusal };

export function checkLifecycleAuthoring(author: Author): LifecycleCheck {
  if (author.kind === "human") return { allowed: true };

  return {
    allowed: false,
    refusal: {
      reason: "session_sets_lifecycle",
      message:
        "lifecycle is set by the human; a session may only propose the change",
    },
  };
}

/**
 * The scope rule (§3.3): objects cross workstream boundaries as world
 * objects; commands and sessions never do. Local objects belong to the
 * workstream that produced them until promoted (§3.2).
 */
export interface ScopedEntity {
  readonly kind: "object" | "command" | "session";
  /** Objects only: world objects are free to cross (§3.2). */
  readonly scope?: ObjectScope;
  /** Null when the entity belongs to no workstream (a world object). */
  readonly workstreamId: WorkstreamId | null;
}

export type ScopeRefusal =
  | { readonly reason: "local_object"; readonly message: string }
  | { readonly reason: "command_confined"; readonly message: string }
  | { readonly reason: "session_confined"; readonly message: string };

export type ScopeCheck =
  | { readonly legal: true }
  | { readonly legal: false; readonly refusal: ScopeRefusal };

const SCOPE_LEGAL = { legal: true } as const;

export function checkScope(
  entity: ScopedEntity,
  targetWorkstreamId: WorkstreamId | null,
): ScopeCheck {
  const crosses =
    entity.workstreamId !== null && entity.workstreamId !== targetWorkstreamId;

  if (!crosses) return SCOPE_LEGAL;

  switch (entity.kind) {
    case "object":
      return entity.scope === "world"
        ? SCOPE_LEGAL
        : {
            legal: false,
            refusal: {
              reason: "local_object",
              message:
                "a local object stays in its workstream; promote it to world scope first",
            },
          };
    case "command":
      return {
        legal: false,
        refusal: {
          reason: "command_confined",
          message: "a command never leaves its workstream",
        },
      };
    case "session":
      return {
        legal: false,
        refusal: {
          reason: "session_confined",
          message: "a session never leaves its workstream",
        },
      };
  }
}

/**
 * What the suggestion predicate reads (§3.3). The caller assembles this from
 * whatever exists — commands and drift arrive in later epics, and a summary
 * built before then simply reports zero of each.
 */
export interface WorkstreamActivity {
  readonly producingCommands: number;
  readonly completedProducingCommands: number;
  readonly totalSessions: number;
  readonly runningSessions: number;
  readonly driftedInputs: number;
}

/**
 * Spec §3.3: the product suggests done when every producing command has
 * completed — or, for a workstream of only open work, when every session has
 * ended and nothing is drifted. A suggestion is a proposal the human
 * confirms; nothing calls this to transition automatically, ever.
 */
export function suggestDone(
  status: WorkstreamStatus,
  activity: WorkstreamActivity,
): boolean {
  if (status !== "active") return false;

  if (activity.producingCommands > 0) {
    return activity.completedProducingCommands >= activity.producingCommands;
  }

  return (
    activity.totalSessions > 0 &&
    activity.runningSessions === 0 &&
    activity.driftedInputs === 0
  );
}

/**
 * Attention rollup (§3.3, §7): everything inside a workstream aggregates to
 * one status on the card. The counts follow the queue's feeds — questions,
 * approvals, drift, health alerts, completions (§7.1) — plus running
 * sessions, which make a quiet board legible.
 */
export interface AttentionCounts {
  readonly questions: number;
  readonly approvals: number;
  readonly drift: number;
  readonly healthAlerts: number;
  readonly completions: number;
  readonly runningSessions: number;
}

export const EMPTY_ATTENTION: AttentionCounts = {
  questions: 0,
  approvals: 0,
  drift: 0,
  healthAlerts: 0,
  completions: 0,
  runningSessions: 0,
};

/**
 * One status per card, by severity: a decision someone is waiting on beats a
 * health alert, which beats drift, which beats "still working". Completions
 * are informational and never dominate the rollup.
 */
export type RollupStatus =
  "needs_decision" | "unhealthy" | "drifted" | "working" | "quiet";

export interface AttentionRollup extends AttentionCounts {
  readonly status: RollupStatus;
}

export function rollupAttention(counts: AttentionCounts): AttentionRollup {
  const status: RollupStatus =
    counts.questions + counts.approvals > 0
      ? "needs_decision"
      : counts.healthAlerts > 0
        ? "unhealthy"
        : counts.drift > 0
          ? "drifted"
          : counts.runningSessions > 0
            ? "working"
            : "quiet";

  return { ...counts, status };
}
