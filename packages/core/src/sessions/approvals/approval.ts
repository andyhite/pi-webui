import type { Author } from "../../author.js";
import type { SessionId, WorkstreamId } from "../../ids.js";
import type { RequestOutcome, RuntimeRequestId } from "../runtime.js";
import {
  describeAsk,
  isIrreversibleAsk,
  type ApprovalAsk,
  type ApprovalKind,
  type ApprovalTarget,
} from "./ask.js";
import type { ApprovalId } from "./ids.js";
import type { PiercedPreGrant } from "./pre-grants.js";
import type { WriteReversibility } from "../outside-world.js";

/**
 * The approval record (§6.6).
 *
 * Shaped like `SessionQuestion` on purpose, because it is answered on the same
 * surfaces by the same gestures (§7.1) and it has the same lifetime problem: an
 * approval **outlives the call it blocks**. A surface that asked the runtime what
 * it wanted permission for would have nothing to show the moment the call settled,
 * and "answerable without opening the session" needs the ask remembered, not
 * proxied.
 *
 * Two answers only — **approve once** and **deny with a reason**. There is
 * deliberately no "always allow": a durable grant is a `PreGrant`, which is the
 * operator's own gesture with its own record, and folding it into an answer would
 * have created a back door through §6.6's piercing rule — "approve always" on an
 * irreversible merge would be exactly the covering pre-grant the type system
 * refuses to let anyone express.
 */
export interface Approval {
  readonly id: ApprovalId;
  readonly sessionId: SessionId;
  readonly workstreamId: WorkstreamId;
  readonly kind: ApprovalKind;
  readonly ask: ApprovalAsk;
  /**
   * The runtime request this blocks, so answering settles the blocked call rather
   * than a copy of it. Null for an ask that came in over HTTP (a destruction tool
   * call, a claim wait) with no runtime request behind it.
   */
  readonly requestId: RuntimeRequestId | null;
  /** The adapter's call id, which is what `decideToolPermission` matches against. */
  readonly callId: string | null;
  readonly raisedAt: number;
  readonly answer: ApprovalAnswer | null;
  /**
   * The pre-grant that **would** have covered this, when one did and the ask was
   * raised anyway because it is irreversible (§6.6). Recorded on the row because
   * an operator who pre-granted a system and is being asked anyway needs to be
   * told which rule was pierced — otherwise the raise reads as a bug in their own
   * configuration and the next thing they do is widen the rule.
   */
  readonly piercedPreGrant: PiercedPreGrant | null;
}

/**
 * Approve for this call, or deny with a reason.
 *
 * `"approve-once"` is spelled with the "once" in it so no reader has to check
 * whether it might be durable.
 */
export const APPROVAL_DECISIONS = ["approve-once", "deny"] as const;

export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export interface ApprovalAnswer {
  readonly decision: ApprovalDecision;
  /** Required for a deny: the feedback the session receives (§6.6). */
  readonly reason: string | null;
  /** Who answered. `Author` has no system variant, so this is always somebody. */
  readonly by: Author;
  readonly at: number;
}

export const APPROVAL_REFUSAL_REASONS = [
  /** Already answered: one gesture, one answer (principle 9). */
  "already_answered",
  /**
   * A session answering an approval. §6.6's approval is the human's; a session
   * answering its own would be granting itself capability (principle 1) — and a
   * session answering *another* session's is the same act one step removed, which
   * is why this refuses every session author rather than only the asker.
   */
  "human_only",
  /**
   * A deny with no reason. Deny is feedback, not failure (§6.6): a refusal the
   * session cannot act on is indistinguishable from the tool breaking, and the
   * session's next move is to retry the same call.
   */
  "deny_needs_reason",
] as const;

export type ApprovalRefusalReason = (typeof APPROVAL_REFUSAL_REASONS)[number];

export interface ApprovalRefusal {
  readonly reason: ApprovalRefusalReason;
  readonly message: string;
}

export type ApprovalResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: ApprovalRefusal };

export interface RaiseApprovalInput {
  readonly id: ApprovalId;
  readonly sessionId: SessionId;
  readonly workstreamId: WorkstreamId;
  readonly ask: ApprovalAsk;
  readonly requestId?: RuntimeRequestId | null;
  readonly callId?: string | null;
  readonly piercedPreGrant?: PiercedPreGrant | null;
  readonly at: number;
}

/**
 * Raise one. Note what is absent, for the same reason it is absent from a
 * question: there is no field here from which this could resolve without a
 * person — no default, no expiry, no on-timeout. An approval that timed out into
 * "allow" would be the product spending with nobody behind it (principle 2), and
 * one that timed out into "deny" would be a stalled session reported as refused.
 */
export function raiseApproval(input: RaiseApprovalInput): Approval {
  return {
    id: input.id,
    sessionId: input.sessionId,
    workstreamId: input.workstreamId,
    kind: input.ask.kind,
    ask: input.ask,
    requestId: input.requestId ?? null,
    callId: input.callId ?? null,
    raisedAt: input.at,
    answer: null,
    piercedPreGrant: input.piercedPreGrant ?? null,
  };
}

export interface AnswerApprovalInput {
  readonly decision: ApprovalDecision;
  readonly reason?: string | null;
  readonly by: Author;
  readonly at: number;
}

export function answerApproval(
  approval: Approval,
  input: AnswerApprovalInput,
): ApprovalResult<Approval> {
  if (approval.answer !== null) {
    return refuse(
      "already_answered",
      "this approval was already answered; a second answer would rewrite what the session was allowed to do (principle 9)",
    );
  }
  if (input.by.kind !== "human") {
    return refuse(
      "human_only",
      "an approval is answered by the operator; a session answering one would expand its own capability (§6.6, principle 1)",
    );
  }
  const reason = input.reason?.trim() ?? "";
  if (input.decision === "deny" && reason.length === 0) {
    return refuse(
      "deny_needs_reason",
      "a denial carries a reason: deny is feedback the session acts on, and a bare refusal is indistinguishable from the tool being broken (§6.6)",
    );
  }

  return {
    ok: true,
    value: {
      ...approval,
      answer: {
        decision: input.decision,
        reason: reason.length === 0 ? null : reason,
        by: input.by,
        at: input.at,
      },
    },
  };
}

function refuse<T>(
  reason: ApprovalRefusalReason,
  message: string,
): ApprovalResult<T> {
  return { ok: false, refusal: { reason, message } };
}

/**
 * Named for approvals rather than `isAnswered`, because `questions.ts` exports
 * that name for the *other* thing an attention row can be, and the two travel
 * together through one feed (§7.1) — a surface importing both from `@plotroom/core`
 * must not have to know which one it got.
 */
export function isApprovalAnswered(approval: Approval): boolean {
  return approval.answer !== null;
}

/**
 * Whether this approval is an answer to **this** ask.
 *
 * `decideApproval` is handed the approval by its caller, and a caller looking one up
 * by session finds the *session's* approvals rather than this gesture's. Without this
 * check, an approved `object_delete` on `obj_1` would authorize `object_delete` on
 * `obj_2`: a delete nobody agreed to, executed on the strength of agreeing to a
 * different one. One gesture, one answer (principle 9) — and the check lives here
 * rather than at each call site so the destruction path, the gate, and whatever Track
 * A wires next cannot each get it slightly differently.
 *
 * Matched on the facts that identify the gesture: the **kind** of thing being asked
 * for, the tool, and the record it would act on. Deliberately not the summary —
 * wording is for humans, and matching on it would make a reworded row stop settling
 * its own call.
 *
 * The kind is part of the match because two kinds can name one tool and mean
 * different acts: a `standing_instruction_declare` **proposal** (§3.8) and a
 * write-gate raise over the same name are not each other's answers, and a proposal
 * settled by anything but its own acceptance would be applied without being
 * confirmed (principle 1).
 */
export function settlesAsk(approval: Approval, ask: ApprovalAsk): boolean {
  if (approval.ask.kind !== ask.kind) return false;
  if (approval.ask.tool !== ask.tool) return false;
  return sameTarget(approval.ask.target, ask.target);
}

function sameTarget(
  a: ApprovalTarget | null,
  b: ApprovalTarget | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.id === b.id;
}

export function isApproved(approval: Approval): boolean {
  return approval.answer?.decision === "approve-once";
}

/**
 * What the session receives, structurally rather than as prose — the same
 * treatment a question's answer gets (§6.4), because a session that has to parse
 * an apology to find out whether it may proceed will guess.
 *
 * A denial is **feedback, not failure**: `disposition` says so in a word the model
 * can branch on, and the reason is the operator's own text. Nothing here reports an
 * error, and nothing marks the session failed — §6.6's denial is a decision about
 * capability, and a session that was told "not that repository, use the fork" has
 * been given work, not a fault.
 */
export interface EncodedApprovalAnswer {
  readonly approvalId: ApprovalId;
  readonly asked: string;
  readonly decision: ApprovalDecision;
  readonly reason: string | null;
  readonly disposition: "proceed" | "not-this-way";
  readonly sentence: string;
}

export function encodeApprovalAnswer(
  approval: Approval,
): EncodedApprovalAnswer | null {
  const answer = approval.answer;
  if (answer === null) return null;
  const asked = describeAsk(approval.ask);
  const approved = answer.decision === "approve-once";
  return {
    approvalId: approval.id,
    asked,
    decision: answer.decision,
    reason: answer.reason,
    disposition: approved ? "proceed" : "not-this-way",
    sentence: approved
      ? `approved for this call: ${asked}`
      : `declined: ${answer.reason ?? "no reason given"} — this is feedback about how to proceed, not a failure`,
  };
}

/**
 * The outcome that settles the blocked runtime request.
 *
 * A denial answers `deny` with the operator's reason, which is what the runtime
 * hands the model as the tool's result. The gate's own wording and this one meet
 * at the same place (`RequestOutcome`), so a session cannot tell a claim refusal
 * apart from an approval denial by its shape — only by what it says.
 */
export function approvalOutcome(approval: Approval): RequestOutcome | null {
  const answer = approval.answer;
  if (answer === null) return null;
  if (answer.decision === "approve-once") return { kind: "allow" };
  return {
    kind: "deny",
    reason:
      answer.reason ??
      "declined by the operator; this is feedback about how to proceed, not a failure (§6.6)",
  };
}

/** How an approval renders where the operator answers it, in one shape (§7.1). */
export interface ApprovalAnswerOption {
  readonly decision: ApprovalDecision;
  readonly label: string;
  /** True for a denial: §6.6's feedback is only feedback if it says something. */
  readonly requiresReason: boolean;
}

export const APPROVAL_ANSWER_OPTIONS: readonly ApprovalAnswerOption[] = [
  { decision: "approve-once", label: "Approve once", requiresReason: false },
  { decision: "deny", label: "Deny with a reason", requiresReason: true },
];

/**
 * The attention row (§7.1), produced here so the queue, the node bubble, the
 * window title, and an outbound route (§7.3) cannot word one approval four ways.
 *
 * Everything needed to answer it is in the row — that is what "answerable without
 * opening the session" means, and it is why `sentence` is built here rather than by
 * each surface. `null` once answered: an answered approval is history, and the feed
 * ranks what is still asking.
 */
export interface ApprovalAttention {
  readonly kind: "approval";
  readonly approvalId: ApprovalId;
  readonly sessionId: SessionId;
  readonly workstreamId: WorkstreamId;
  readonly askKind: ApprovalKind;
  readonly tool: string | null;
  readonly sentence: string;
  /** Null when no declaration says this touches the outside world (§9.2). */
  readonly reversibility: WriteReversibility | null;
  /** True when §6.6's piercing rule applies: this one always asks. */
  readonly irreversible: boolean;
  /** Set when a pre-grant would have covered it and irreversibility pierced it. */
  readonly piercedPreGrant: string | null;
  readonly raisedAt: number;
  readonly answers: readonly ApprovalAnswerOption[];
}

export function approvalAttention(
  approval: Approval,
): ApprovalAttention | null {
  if (approval.answer !== null) return null;
  return {
    kind: "approval",
    approvalId: approval.id,
    sessionId: approval.sessionId,
    workstreamId: approval.workstreamId,
    askKind: approval.kind,
    tool: approval.ask.tool,
    sentence: describeAsk(approval.ask),
    reversibility: approval.ask.world?.reversibility ?? null,
    irreversible: isIrreversibleAsk(approval.ask),
    piercedPreGrant: approval.piercedPreGrant?.description ?? null,
    raisedAt: approval.raisedAt,
    answers: APPROVAL_ANSWER_OPTIONS,
  };
}
