import type { Author } from "../author.js";
import type { ObjectId, SessionId, WorkstreamId } from "../ids.js";
import type { WorkspaceId } from "../workspaces/ids.js";
import type {
  WorkspaceKindConfig,
  WorkspaceKindName,
} from "../workspaces/kind.js";
import { isDeleted } from "./deletion.js";
import {
  forkCleanlinessAt,
  type ForkCleanliness,
  type OutsideWorldMarkers,
} from "./outside-world.js";
import type {
  RuntimeCapabilities,
  SessionLaunchChoices,
  TranscriptPoint,
} from "./runtime.js";
import type { Session, SessionMode } from "./session.js";
import type { ReleaseMarker, Transcript } from "./transcript.js";
import { exportTranscript } from "./transcript.js";

/**
 * Fork from any point (§6.3), and what it costs when the runtime cannot.
 *
 * Decision 0001: "fork-from-point is emulated by transcript-prefix seeding when
 * a runtime lacks native fork". PlotRoom owns the bookkeeping either way; the
 * capability flag keeps the difference honest rather than hiding it, because a
 * seeded fork is not bit-identical to a native one (provider caches, tool
 * state).
 */
export type ForkMode = "native" | "seeded";

export interface NativeForkPlan {
  readonly mode: "native";
  readonly point: TranscriptPoint;
}

export interface SeededForkPlan {
  readonly mode: "seeded";
  /** Why the runtime could not do it, in the words the UI can show. */
  readonly reason: "no-native-fork" | "not-a-turn-boundary";
  /** The transcript prefix a fresh native session is started from. */
  readonly seed: string;
  readonly throughTurn: number;
  /**
   * False when released tool output could not be reloaded for the seed. A fork
   * seeded from an incomplete prefix is a truncated context, which the product
   * warns about and never does quietly (principle 12).
   */
  readonly complete: boolean;
  readonly unavailable: readonly string[];
}

export type ForkPlan = NativeForkPlan | SeededForkPlan;

export function transcriptPrefix(
  transcript: Transcript,
  point: TranscriptPoint,
): Transcript {
  return {
    ...transcript,
    turns: transcript.turns.filter((turn) => turn.ordinal <= point.turn),
  };
}

export function isTurnBoundary(
  transcript: Transcript,
  point: TranscriptPoint,
): boolean {
  return transcript.turns.some((turn) => turn.ordinal === point.turn);
}

/**
 * Decide how a fork happens. Native where the adapter can reach the point;
 * seeded otherwise — and the seed is built by exporting the prefix, so released
 * content is reloaded first and the plan reports it if that failed.
 */
export function planFork(
  capabilities: RuntimeCapabilities,
  transcript: Transcript,
  point: TranscriptPoint,
  loadReleased: (marker: ReleaseMarker, callId: string) => string | null = () =>
    null,
): ForkPlan {
  const boundary = isTurnBoundary(transcript, point);

  if (capabilities.fork === "any-point") return { mode: "native", point };
  if (capabilities.fork === "turn-boundary" && boundary) {
    return { mode: "native", point };
  }

  const prefix = transcriptPrefix(transcript, point);
  const exported = exportTranscript(prefix, loadReleased);

  return {
    mode: "seeded",
    reason:
      capabilities.fork === "none" ? "no-native-fork" : "not-a-turn-boundary",
    seed: exported.document,
    throughTurn: prefix.turns.at(-1)?.ordinal ?? 0,
    complete: exported.complete,
    unavailable: exported.unavailable,
  };
}

/* --------------------------------------------------- fork as a graph act */

/**
 * A fork is a **new session with its own workstream and workspace** (§6.3): "a
 * fork from any point inherits the conversation up to that point and gets its own
 * workstream and workspace, so two lines of work can diverge from shared
 * understanding."
 *
 * `planFork` above decides how the *runtime* gets there. This decides what
 * PlotRoom writes: the records, the provenance, and the cleanliness of the point
 * — which comes from reversibility declarations rather than a heuristic (§6.6).
 */
export interface SessionForkIds {
  readonly sessionId: SessionId;
  readonly workstreamId: WorkstreamId;
  readonly workspaceId: WorkspaceId;
}

/** The new workstream a fork gets. Its subject is the source's, when there is one. */
export interface ForkedWorkstream {
  readonly id: WorkstreamId;
  readonly name: string;
  readonly subjectObjectId: ObjectId | null;
}

/** Its own workspace, provisioned like any other — at first run, not now (§3.4). */
export interface ForkedWorkspace {
  readonly id: WorkspaceId;
  readonly workstreamId: WorkstreamId;
  readonly kind: WorkspaceKindName;
  readonly config: WorkspaceKindConfig;
  readonly createdBy: Author;
}

export interface SessionForkPlan {
  readonly sourceSessionId: SessionId;
  readonly point: TranscriptPoint;
  /** Native or seeded, and which — a seeded fork is not pretended to be native. */
  readonly runtime: ForkPlan;
  readonly session: {
    readonly id: SessionId;
    readonly workstreamId: WorkstreamId;
    readonly mode: SessionMode;
    readonly launch: SessionLaunchChoices;
    readonly initiatedBy: Author;
  };
  readonly workstream: ForkedWorkstream;
  readonly workspace: ForkedWorkspace;
  /** §3.7 already has the relation; this names which one a fork is. */
  readonly provenance: {
    readonly relation: "session_forked_from";
    readonly fromSessionId: SessionId;
    readonly toSessionId: SessionId;
    readonly recordedAt: number;
  };
  /** Fork-before-clean, fork-after-dirty (§6.3), from declarations (§6.6). */
  readonly cleanliness: ForkCleanliness;
  /**
   * False when the seed could not be assembled completely — released tool output
   * that would not reload. Surfaced, never silent (principle 12).
   */
  readonly seedComplete: boolean;
  readonly forkedBy: Author;
  readonly at: number;
}

export const SESSION_FORK_REFUSAL_REASONS = [
  /** The transcript has no such turn, so there is no point to inherit from. */
  "unknown_point",
  /** Forking a deleted record would resurrect it as a side effect. */
  "source_deleted",
] as const;

export type SessionForkRefusalReason =
  (typeof SESSION_FORK_REFUSAL_REASONS)[number];

export interface SessionForkRefusal {
  readonly reason: SessionForkRefusalReason;
  readonly message: string;
}

export type SessionForkResult =
  | { readonly ok: true; readonly plan: SessionForkPlan }
  | { readonly ok: false; readonly refusal: SessionForkRefusal };

export interface SessionForkRequest {
  readonly ids: SessionForkIds;
  readonly point: TranscriptPoint;
  readonly forkedBy: Author;
  /** Where the new workstream's own workspace comes from — the source's kind. */
  readonly workspace: {
    readonly kind: WorkspaceKindName;
    readonly config: WorkspaceKindConfig;
  };
  readonly workstreamName: string;
  readonly subjectObjectId?: ObjectId | null;
  readonly at: number;
}

export interface SessionForkContext {
  readonly source: Session;
  readonly transcript: Transcript;
  readonly capabilities: RuntimeCapabilities;
  /**
   * The markers cleanliness is read from — `deriveOutsideWorldMarkers` over the
   * session's observation log.
   *
   * **Required, deliberately.** It was optional, and omitting it produced a plan
   * claiming `clean` with nothing having been examined: the caller least likely to
   * pass markers is the one that never derived any, and that caller got the most
   * reassuring answer. There is no default that is honest here (§6.3, principle
   * 7). A session with no observations yields `NO_OUTSIDE_WORLD_MARKERS`, which
   * says the same thing on purpose rather than by omission.
   */
  readonly markers: OutsideWorldMarkers;
  readonly loadReleased?: (
    marker: ReleaseMarker,
    callId: string,
  ) => string | null;
}

export function planSessionFork(
  context: SessionForkContext,
  request: SessionForkRequest,
): SessionForkResult {
  if (isDeleted(context.source)) {
    return {
      ok: false,
      refusal: {
        reason: "source_deleted",
        message:
          "this session was deleted; restore it before forking from it (principle 10)",
      },
    };
  }
  if (!isTurnBoundary(context.transcript, request.point)) {
    return {
      ok: false,
      refusal: {
        reason: "unknown_point",
        message: `this session has no turn ${request.point.turn} to fork from`,
      },
    };
  }

  const runtime = planFork(
    context.capabilities,
    context.transcript,
    request.point,
    context.loadReleased,
  );

  return {
    ok: true,
    plan: {
      sourceSessionId: context.source.id,
      point: request.point,
      runtime,
      session: {
        id: request.ids.sessionId,
        workstreamId: request.ids.workstreamId,
        // A fork inherits how the source ends, not just what it said: forking a
        // producing session produces one too, and its outcome is proven the same
        // way (§3.5).
        mode: context.source.mode,
        launch: context.source.launch,
        initiatedBy: request.forkedBy,
      },
      workstream: {
        id: request.ids.workstreamId,
        name: request.workstreamName,
        subjectObjectId: request.subjectObjectId ?? null,
      },
      workspace: {
        id: request.ids.workspaceId,
        workstreamId: request.ids.workstreamId,
        kind: request.workspace.kind,
        config: request.workspace.config,
        createdBy: request.forkedBy,
      },
      provenance: {
        relation: "session_forked_from",
        fromSessionId: context.source.id,
        toSessionId: request.ids.sessionId,
        recordedAt: request.at,
      },
      cleanliness: forkCleanlinessAt(context.markers, request.point.turn),
      seedComplete: runtime.mode === "native" ? true : runtime.complete,
      forkedBy: request.forkedBy,
      at: request.at,
    },
  };
}
