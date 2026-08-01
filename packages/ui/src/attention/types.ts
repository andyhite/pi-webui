/**
 * THE ATTENTION CONTRACT (Epic 6.1, spec §7): "one derivation, many
 * surfaces." Everything in this directory — the queue, the header count,
 * the window title, the app badge, the system notification, the off-screen
 * markers, node state, and the what-changed panel — reads from exactly one
 * feed shaped by `AttentionDataSource`. There is no second computation of
 * "what needs attention" anywhere in this package; every surface is a pure
 * projection of the same ranked list.
 *
 * **Track A's Stage 2 has landed** (`GET /api/attention` + the `attention`
 * WS entity, `docs/attention-contract.md`'s own record of it). The
 * derivation — idle, spinning, conflict-predicted, unanswered,
 * blocked-on-you (§7.2), and turning drift/questions/approvals/completions
 * into ranked items — lives server-side now; `createApiAttentionDataSource`
 * (`data-source.ts`) is the live implementation, over the exact resync
 * recipe `createApiQuestionDataSource`/`createApiGraphDataSource` already
 * established. `createFixtureAttentionDataSource` stays for tests and
 * `VITE_USE_FIXTURES` dev, behind the identical interface.
 *
 * Six feeds (§7.1, §6.5): `question`, `approval`, `drift`, `health`,
 * `completion`, `broadcast`. §6.5 is explicit that a session-originated
 * broadcast "appears in the queue and in each recipient workstream's
 * activity history" — `broadcast` is that queue row; the activity-history
 * half is `what-changed.ts`'s `"broadcast"` `WorkstreamActivityKind`,
 * already landed and aligned to `@plotroom/core`'s `BroadcastActivityEntry`
 * (`sessions/broadcast.ts`). Every feed supports the same three triage
 * verbs — acknowledge, snooze, mute (§4.5) — which is why they share one
 * ledger (`@plotroom/core`'s `TriageLedger`, keyed by `AttentionItem.id`)
 * rather than six bespoke ones.
 */

import type { ApprovalDecision, Author } from "@plotroom/core";

import type { Unsubscribe } from "../data-source/types.js";

export const ATTENTION_FEEDS = [
  "question",
  "approval",
  "drift",
  "health",
  "completion",
  "broadcast",
] as const;

export type AttentionFeed = (typeof ATTENTION_FEEDS)[number];

/**
 * Where selecting this row navigates the canvas to (§5 "selection is the
 * route", §7.1 "selecting a row moves the canvas to it"). `sessionId` is
 * present whenever the item is about a session — a completion always has
 * one, a health alert usually does — so a row can be answered without
 * opening anything even before the canvas finishes navigating.
 */
export interface AttentionTarget {
  readonly nodeId: string;
  readonly workstreamId: string | null;
  readonly sessionId?: string;
}

/** One option a `question` row can pick, matching `@plotroom/core`'s `SessionQuestion.options` shape (id + label; `detail` is dropped, the queue row has no room for it). */
export interface AttentionQuestionOption {
  readonly id: string;
  readonly label: string;
}

/**
 * What "answerable in place" (§7.1) means, concretely, per feed — the shape
 * a queue row needs to render its inline control without opening anything
 * else. Every kind besides `health` and `broadcast` names the id of the
 * thing an answer hook below acts on; those two have nothing to answer
 * beyond triage — a health alert is informational, and §6.5 says a
 * broadcast is a thing the operator is *told*, never something the queue
 * asks a decision about.
 */
export type AttentionAnswerPayload =
  | {
      readonly kind: "question";
      readonly questionId: string;
      readonly text: string;
      /**
       * `{id, label}` pairs, never bare label strings: `answerQuestion`
       * below takes the real `optionId` a live source's `SessionQuestion.
       * options` already carries (`bubbles/question-source.ts`'s own
       * shape), so a row picks by id directly rather than the data source
       * resolving a clicked label back to one — the label-collision
       * fragility that resolution had is exactly why duplicate labels are
       * refused at authoring instead (Batch 3 finding).
       */
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
  | {
      readonly kind: "health";
      readonly alert:
        | "idle"
        | "spinning"
        | "conflict-predicted"
        | "unanswered"
        | "blocked-on-you";
    }
  | { readonly kind: "completion"; readonly sessionId: string }
  | {
      readonly kind: "broadcast";
      /** `@plotroom/core`'s `BroadcastAttention.broadcastId` (`sessions/broadcast.ts`). */
      readonly broadcastId: string;
      readonly category: string;
      readonly recipientCount: number;
    };

export interface AttentionItem {
  /**
   * MUST be stable across a resync (REQUIRED, not a style preference): the
   * notification edge-trigger (`notifications.ts#decideNotification`/
   * `nextNotificationEdgeState`) and the queue's own selection tracking
   * (`QueuePanel`'s `selectedId`) both key on this id across separate
   * `subscribe()` emissions. An id that changed on every resync would
   * make an already-seen item look new (a spurious re-notification for
   * nothing new, since the edge-trigger's state is folded forward *by
   * id*) and would silently drop the queue's current highlight the
   * moment anything else changed. Derive it from the underlying fact,
   * never regenerate it per read — e.g. a question's own `SessionQuestion.
   * id`, a drift row keyed the same way `@plotroom/core`'s `driftItemKey`
   * already does for drift specifically.
   */
  readonly id: string;
  readonly feed: AttentionFeed;
  readonly target: AttentionTarget;
  /** Lower sorts first (§7.1's single ranked list). Assigned upstream — never recomputed by a surface. */
  readonly rank: number;
  /** Enough context to answer without opening anything (§7.1). */
  readonly summary: string;
  readonly payload: AttentionAnswerPayload;
  readonly raisedAt: number;
  /**
   * Set by a prior `snooze`, until the source stops hiding it again —
   * informational, not a filtering instruction a surface acts on (see the
   * NORMATIVE rule on `AttentionDataSource.subscribe`/`list` below: hiding
   * a currently-snoozed item is the *source's* job, done once, before it
   * emits at all). `null` whenever the item is not currently snoozed,
   * including immediately after it returns.
   */
  readonly snoozeUntil: number | null;
}

export interface TriageActionInput {
  readonly at: number;
  readonly by: Author;
}

export interface SnoozeActionInput extends TriageActionInput {
  readonly snoozedUntil: number;
}

/**
 * NORMATIVE (fixes a Batch 4 review finding: the contract previously
 * implied a surface hides a snoozed item by reading `snoozeUntil` itself
 * — nothing in this package ever did that, and none should): a
 * conforming implementation's `list()`/`subscribe()` MUST already exclude
 * every item a mute has permanently dismissed and every item a snooze has
 * not yet released, exactly as `createFixtureAttentionDataSource`
 * (`data-source.ts`) does — filtering its own real `TriageLedger` through
 * `queue.ts#visibleAttentionItems` before it ever emits. A surface (the
 * queue, a node badge, ...) never holds a ledger of its own and never
 * re-filters; it only ranks what it is given
 * (`queue.ts#rankAttentionItems`). One hiding rule, stated once, enforced
 * once — not "stated for a surface" and then actually done somewhere
 * else, which is what made the two disagree before this fix.
 *
 * A second, related rule for a live implementation specifically: **no
 * transient empty snapshot during a resync.** The same discipline
 * `createApiQuestionDataSource`/`createApiGraphDataSource` already follow
 * (connect, buffer, apply a real snapshot, never emit a bare `[]` in
 * between) applies here for an additional reason beyond staleness —
 * `notifications.ts`'s edge-triggered decision folds forward whatever it
 * was last shown (`nextNotificationEdgeState`), so a spurious empty
 * emission would make every currently-open item look brand new on the
 * very next real one and re-fire a notification for all of them at once.
 */
export interface AttentionDataSource {
  /** A one-shot, point-in-time read (mirrors every other data source's `list`/`load`). */
  list(): Promise<readonly AttentionItem[]>;
  /** Live feed. Muted items never appear again; snoozed items return once released — both per the NORMATIVE rule above, never a transient `[]` mid-resync. */
  subscribe(onChange: (items: readonly AttentionItem[]) => void): Unsubscribe;
  /** Seen; the consumer's baseline advances without running anything (§4.5). */
  acknowledge(itemId: string, input: TriageActionInput): Promise<void>;
  /** Bring it back later. */
  snooze(itemId: string, input: SnoozeActionInput): Promise<void>;
  /** Never show this one again. */
  mute(itemId: string, input: TriageActionInput): Promise<void>;
  /**
   * A `question` row's inline pick (§6.4, §7.1) — also acknowledges
   * (answering is seeing it). `optionId` is the real id off the picked
   * `AttentionQuestionOption`, never its label — the row always has both,
   * so no label→id resolution happens here or anywhere downstream of it.
   */
  answerQuestion(
    itemId: string,
    optionId: string,
    input: TriageActionInput,
  ): Promise<void>;
  /**
   * An `approval` row's inline decision (§6.6, §7.1) — also acknowledges.
   * `decision` is `@plotroom/core`'s own `ApprovalDecision` (`"approve-
   * once" | "deny"`, from `APPROVAL_ANSWER_OPTIONS`) rather than a
   * synthetic `"approve"` this layer would have to translate — there is
   * only ever one approve shape (§6.6 never offers a standing yes from
   * this row; that is a pre-grant, a different gesture entirely).
   * `reason` is required for `"deny"` and refused for anything else
   * (`APPROVAL_ANSWER_OPTIONS`'s own `requiresReason` states which) —
   * "declining is feedback the session acts on, never a bare refusal".
   */
  decideApproval(
    itemId: string,
    decision: ApprovalDecision,
    input: TriageActionInput,
    reason?: string,
  ): Promise<void>;
}
