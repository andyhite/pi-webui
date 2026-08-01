import type { SessionEnd } from "../sessions/end-states.js";

/**
 * The attention vocabulary (§7): **one derivation, many surfaces.**
 *
 * These types are the contract `docs/attention-contract.md` records, stated here
 * rather than in the renderer because the derivation is the server's: the queue,
 * the node badges, the off-screen markers, the header count, the window title, the
 * app badge, and an outbound route (§7.3) are all projections of the one ranked
 * list this module describes. A second computation of "what needs attention"
 * anywhere would be principle 8's failure in the surface the operator trusts most.
 *
 * `packages/ui/src/attention/types.ts` declares the same shape structurally, so a
 * live source satisfies it 1:1 without the renderer importing this module — which
 * is deliberate: the UI package's copy is the contract Track B built against, and
 * the two are held together by that document plus the server tests that assert
 * this shape.
 */
export const ATTENTION_FEEDS = [
  "question",
  "approval",
  "drift",
  "health",
  "completion",
  "broadcast",
] as const;

export type AttentionFeed = (typeof ATTENTION_FEEDS)[number];

export interface AttentionTarget {
  readonly nodeId: string;
  readonly workstreamId: string | null;
  readonly sessionId?: string;
}

/** Matches `SessionQuestion.options` (id + label), never flattened to labels. */
export interface AttentionQuestionOption {
  readonly id: string;
  readonly label: string;
}

export const HEALTH_ALERTS = [
  /** No output for too long (§7.2). */
  "idle",
  /** Cost climbing while nothing in the workspace changes (§7.2). */
  "spinning",
  /** Overlapping paths, across workstreams or on one waitlist (§7.2). */
  "conflict-predicted",
  /** A question or approval nobody replied to (§7.2). */
  "unanswered",
  /** Time a session spent waiting on a human, claim waits included (§7.2). */
  "blocked-on-you",
  /**
   * An integration's connection is broken (§9.3): "broken connection is a health
   * problem, never missing data" — the objects it produced stay present with
   * their last-known content, and this is the alert that says why they stopped
   * updating.
   */
  "integration-broken",
] as const;

export type HealthAlertKind = (typeof HEALTH_ALERTS)[number];

export type AttentionAnswerPayload =
  | {
      readonly kind: "question";
      readonly questionId: string;
      readonly text: string;
      readonly options: readonly AttentionQuestionOption[];
    }
  | {
      readonly kind: "approval";
      readonly approvalId: string;
      readonly capability: string;
    }
  | {
      readonly kind: "drift";
      readonly objectId: string;
      readonly changedSummary: string;
    }
  | { readonly kind: "health"; readonly alert: HealthAlertKind }
  | { readonly kind: "completion"; readonly sessionId: string }
  | {
      readonly kind: "broadcast";
      readonly broadcastId: string;
      readonly category: string;
      readonly recipientCount: number;
    };

export interface AttentionItem {
  /**
   * Stable across a resync, always. The outbound edge-trigger (§7.3) and the
   * queue's own selection both key on this id across separate emissions — an id
   * minted per read would re-fire every open item as brand new on the next
   * emission. Every id here is derived from the underlying fact (a question's own
   * id, `driftItemKey`, a health alert's subject), never generated.
   */
  readonly id: string;
  readonly feed: AttentionFeed;
  readonly target: AttentionTarget;
  /** Lower sorts first. Assigned here; no surface recomputes it (§7.1). */
  readonly rank: number;
  /** Enough context to answer without opening anything (§7.1). */
  readonly summary: string;
  readonly payload: AttentionAnswerPayload;
  readonly raisedAt: number;
  /**
   * Informational only — hiding is the source's job, so an item that is still
   * snoozed does not appear at all. `null` the instant it returns, because a
   * stale non-null value would be indistinguishable from "still hidden".
   */
  readonly snoozeUntil: number | null;
}

/**
 * The states an outbound route attaches to (§7.3): "a route attaches to a
 * _state_ ('anything blocked', 'anything failed'), not to a node, so everything
 * is covered without drawing anything."
 *
 * Derived here beside the item rather than read off it, because two of them
 * cannot be recovered from the item alone: a completion's outcome is not in its
 * payload (the payload is what a surface needs to *answer*, and there is nothing
 * to answer about a finished session), and "blocked" is a fact about the session,
 * not about the row.
 */
export const ATTENTION_STATES = [
  /** A session cannot proceed until a human acts. */
  "blocked",
  /** Work ended other than by proving what it set out to do. */
  "failed",
  /** Something is asking the operator to decide. */
  "wants-decision",
  /** Everything, for an operator who wants one route and no rules. */
  "anything",
] as const;

export type AttentionState = (typeof ATTENTION_STATES)[number];

/**
 * One derived row: the item every surface renders, plus the states an outbound
 * route matches on. The feed hands out `item`; the router reads `states`.
 */
export interface DerivedAttentionItem {
  readonly item: AttentionItem;
  readonly states: readonly AttentionState[];
}

/** How a session's work ended, for the completion feed (§3.6). */
export type CompletionOutcome = SessionEnd["kind"];
