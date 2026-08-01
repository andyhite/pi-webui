import type { Author } from "../author.js";
import type { SessionId } from "../ids.js";
import { checkAuthoring, type LineageIndex } from "../lineage.js";
import type { StopCandidate } from "./stop.js";

/**
 * Batch gestures (§4.2).
 *
 * "A multi-selection of sessions supports one prompt to many, stop, close, and
 * archive — with configurable preset prompts for the recurring ones."
 *
 * Every batch is a composition of gestures that already exist — this module adds
 * no fifth verb. What it adds is the **envelope**, because principle 9 is what
 * makes a batch usable: "one gesture creates one thing, and repeating a gesture
 * that failed halfway does not create a second." A batch carries one
 * client-supplied key, and every member's own idempotency key is *derived* from
 * it, so a retried batch of twelve writes the same twelve rows rather than
 * twenty-four — and a batch that failed at member seven can be replayed whole.
 *
 * A batch is also **partial by design**: a member that cannot take the gesture is
 * skipped with a reason rather than failing the batch. Twelve sessions where one
 * already ended is the normal case, not an error, and refusing the whole gesture
 * would teach the operator to select more carefully instead of telling them what
 * happened.
 */

export const BATCH_GESTURE_KINDS = [
  /** One prompt to many: an injection per member (§6.5). */
  "inject",
  /** Stop each running member (§6.7). */
  "stop",
  /** End each open member — how open work finishes (§3.5). */
  "close",
  /** Archive each ended member (§6.8). */
  "archive",
] as const;

export type BatchGestureKind = (typeof BATCH_GESTURE_KINDS)[number];

export const BATCH_SKIP_REASONS = [
  /** Not in the world the caller supplied: deleted, or never existed. */
  "not_found",
  /** The gesture needs a live session and this one has ended. */
  "not_running",
  /** Archiving needs an ended session; this one is still running (§6.8). */
  "still_running",
  /** Principle 1: this member is in the calling session's own chain. */
  "own_chain",
  /** The same session named twice in one selection. */
  "duplicate",
] as const;

export type BatchSkipReason = (typeof BATCH_SKIP_REASONS)[number];

export interface BatchSkip {
  readonly sessionId: SessionId;
  readonly reason: BatchSkipReason;
  readonly message: string;
}

export interface BatchMember {
  readonly sessionId: SessionId;
  /**
   * This member's idempotency key, derived from the batch key. The derivation is
   * stated here rather than left to each caller so the server, the canvas, and
   * an agent replaying a batch all produce the same keys (principle 9).
   */
  readonly memberKey: string;
}

export interface BatchPlan {
  readonly batchKey: string;
  readonly kind: BatchGestureKind;
  readonly requestedBy: Author;
  readonly members: readonly BatchMember[];
  readonly skipped: readonly BatchSkip[];
  /** The prompt, for `inject` batches; null for the rest. */
  readonly prompt: string | null;
  readonly at: number;
}

export function batchMemberKey(batchKey: string, sessionId: SessionId): string {
  return `${batchKey}:${sessionId}`;
}

export interface BatchRequest {
  /** The caller's own name for this gesture — one gesture, one batch. */
  readonly batchKey: string;
  readonly kind: BatchGestureKind;
  readonly requestedBy: Author;
  /** The multi-selection, in the order the operator made it. */
  readonly sessionIds: readonly SessionId[];
  /** Required for `inject`; ignored otherwise. */
  readonly prompt?: string;
  readonly at: number;
}

export interface BatchContext {
  /** Every session the batch could touch, with whether it is running. */
  readonly candidates: readonly StopCandidate[];
  /** Only consulted when the requester is a session (principle 1). */
  readonly lineage: LineageIndex;
}

export const BATCH_REFUSAL_REASONS = [
  /** An `inject` batch with nothing to say. */
  "prompt_required",
  /** Every member was skipped, so the gesture would do nothing at all. */
  "nothing_to_do",
] as const;

export type BatchRefusalReason = (typeof BATCH_REFUSAL_REASONS)[number];

export interface BatchRefusal {
  readonly reason: BatchRefusalReason;
  readonly message: string;
  /** Why each member dropped out, when that is what emptied the batch. */
  readonly skipped: readonly BatchSkip[];
}

export type BatchResult =
  | { readonly ok: true; readonly plan: BatchPlan }
  | { readonly ok: false; readonly refusal: BatchRefusal };

function needsRunning(kind: BatchGestureKind): boolean {
  return kind !== "archive";
}

export function planBatch(
  context: BatchContext,
  request: BatchRequest,
): BatchResult {
  if (request.kind === "inject" && (request.prompt ?? "").trim().length === 0) {
    return {
      ok: false,
      refusal: {
        reason: "prompt_required",
        message: "one prompt to many needs the prompt (§4.2)",
        skipped: [],
      },
    };
  }

  const byId = new Map(
    context.candidates.map((candidate) => [candidate.sessionId, candidate]),
  );
  const members: BatchMember[] = [];
  const skipped: BatchSkip[] = [];
  const seen = new Set<SessionId>();

  for (const sessionId of request.sessionIds) {
    if (seen.has(sessionId)) {
      skipped.push({
        sessionId,
        reason: "duplicate",
        message: "named twice in one selection; one gesture, one member",
      });
      continue;
    }
    seen.add(sessionId);

    const candidate = byId.get(sessionId);
    if (candidate === undefined) {
      skipped.push({
        sessionId,
        reason: "not_found",
        message: "not a session this batch can reach",
      });
      continue;
    }

    if (needsRunning(request.kind) && !candidate.running) {
      skipped.push({
        sessionId,
        reason: "not_running",
        message: `${request.kind} needs a live session; this one has ended`,
      });
      continue;
    }
    if (request.kind === "archive" && candidate.running) {
      skipped.push({
        sessionId,
        reason: "still_running",
        message: "a running session is not archivable; stop it first (§6.8)",
      });
      continue;
    }

    // The lineage rule applies member by member, exactly as it does to the
    // single gesture: a session batching a prompt to twelve peers may not slip
    // its own chain in among them (principle 1). A human is unconstrained, and
    // `checkAuthoring` already answers that way.
    const authoring = checkAuthoring(
      context.lineage,
      request.requestedBy,
      sessionId,
    );
    if (!authoring.allowed) {
      skipped.push({
        sessionId,
        reason: "own_chain",
        message: authoring.refusal.message,
      });
      continue;
    }

    members.push({
      sessionId,
      memberKey: batchMemberKey(request.batchKey, sessionId),
    });
  }

  if (members.length === 0) {
    return {
      ok: false,
      refusal: {
        reason: "nothing_to_do",
        message: "every session in this selection was skipped",
        skipped,
      },
    };
  }

  return {
    ok: true,
    plan: {
      batchKey: request.batchKey,
      kind: request.kind,
      requestedBy: request.requestedBy,
      members,
      skipped,
      prompt: request.kind === "inject" ? (request.prompt ?? null) : null,
      at: request.at,
    },
  };
}

/**
 * "Configurable preset prompts for the recurring ones" (§4.2). The preset is
 * *content the operator configured*, so it is a record with an id, not a string
 * baked into a menu: a batch records which preset it used, and editing a preset
 * does not rewrite what past batches said.
 */
export interface BatchPromptPreset {
  readonly id: string;
  readonly label: string;
  readonly text: string;
}

export function presetPrompt(
  presets: readonly BatchPromptPreset[],
  id: string,
): BatchPromptPreset | null {
  return presets.find((preset) => preset.id === id) ?? null;
}
