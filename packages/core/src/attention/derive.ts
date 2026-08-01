import type { BroadcastAttention } from "../sessions/broadcast.js";
import type { DriftFlag } from "../sessions/drift.js";
import { endStateFacts, type SessionEnd } from "../sessions/end-states.js";
import type { ApprovalAttention } from "../sessions/approvals/approval.js";
import type { SessionQuestion } from "../sessions/questions.js";
import {
  isVisible,
  triageStatus,
  type TriageLedger,
} from "../sessions/triage.js";
import type { HealthAlert } from "./health.js";
import {
  approvalItemId,
  broadcastItemId,
  completionItemId,
  driftItemKey,
  questionItemId,
} from "./ids.js";
import type {
  AttentionItem,
  AttentionState,
  AttentionTarget,
  DerivedAttentionItem,
} from "./types.js";

/**
 * The one derivation (§7): six feeds in, one ranked list out.
 *
 * Each source below is a record PlotRoom already keeps — an unanswered question,
 * an unanswered approval, a drift flag, a health alert, a finished session, a
 * session-originated broadcast — paired with the node a surface would navigate
 * to. This function does three things and nothing else: it words each row once,
 * assigns the rank every surface only ever sorts by, and applies the triage
 * ledger.
 *
 * **Hiding is the source's job.** A muted item never comes back and a snoozed one
 * does not appear until its time is up — filtered here, before anything is
 * emitted, because a surface holding its own ledger would be a second copy of
 * triage state to disagree with (§4.5, and the attention contract's normative
 * rule).
 */
export interface QuestionAttentionSource {
  readonly question: SessionQuestion;
  readonly target: AttentionTarget;
}

export interface ApprovalAttentionSource {
  readonly attention: ApprovalAttention;
  readonly target: AttentionTarget;
}

export interface DriftAttentionSource {
  readonly flag: DriftFlag;
  readonly target: AttentionTarget;
  /** What changed, in one line — the row answers without opening anything. */
  readonly changedSummary: string;
  readonly raisedAt: number;
}

export interface CompletionAttentionSource {
  readonly sessionId: string;
  readonly target: AttentionTarget;
  readonly end: SessionEnd;
  /** What it produced, or why it stopped: the row's own sentence. */
  readonly summary: string;
}

export interface BroadcastAttentionSource {
  readonly attention: BroadcastAttention;
  readonly target: AttentionTarget;
}

export interface AttentionSources {
  readonly questions: readonly QuestionAttentionSource[];
  readonly approvals: readonly ApprovalAttentionSource[];
  readonly drift: readonly DriftAttentionSource[];
  readonly health: readonly HealthAlert[];
  readonly completions: readonly CompletionAttentionSource[];
  readonly broadcasts: readonly BroadcastAttentionSource[];
}

export interface AttentionContext {
  readonly now: number;
  readonly triage?: TriageLedger;
}

/**
 * Rank, decided here and nowhere else (§7.1: "a surface only ever orders by it").
 *
 * The order is what blocks whom. An approval and a question hold a session still
 * until a human answers, so they come first; a session waiting on the operator is
 * the same stall observed from the other side. A failed or out-of-budget end
 * wants a decision and outranks drift, which is true but not urgent. A proven
 * completion and a broadcast are the operator being *told* something, so they
 * come last — they are the rows a busy queue is allowed to leave for later.
 */
export const ATTENTION_RANKS = {
  approval: 0,
  question: 100,
  blockedHealth: 200,
  wantsDecisionCompletion: 300,
  otherHealth: 400,
  drift: 500,
  completion: 600,
  broadcast: 700,
} as const;

export function deriveAttention(
  sources: AttentionSources,
  context: AttentionContext,
): readonly DerivedAttentionItem[] {
  const derived: DerivedAttentionItem[] = [
    ...sources.approvals.map(approvalRow),
    ...sources.questions.map(questionRow),
    ...sources.health.map(healthRow),
    ...sources.completions.map(completionRow),
    ...sources.drift.map(driftRow),
    ...sources.broadcasts.map(broadcastRow),
  ];

  return visibleAttention(derived, context);
}

/**
 * Apply the ledger and order the result.
 *
 * A snoozed item is dropped while it is hidden and reports `snoozeUntil` — but
 * only while `now` is genuinely before it. The instant it elapses the item comes
 * back with `snoozeUntil: null`, because a stale value there is indistinguishable
 * from still being hidden.
 */
export function visibleAttention(
  derived: readonly DerivedAttentionItem[],
  context: AttentionContext,
): readonly DerivedAttentionItem[] {
  const ledger = context.triage;
  const now = context.now;

  return derived
    .filter((entry) => {
      const status = triageStatus(ledger?.get(entry.item.id), now);
      return isVisible(status);
    })
    .map((entry) => {
      const record = ledger?.get(entry.item.id);
      const snoozedUntil =
        record?.verb === "snooze" ? record.snoozedUntil : null;
      if (snoozedUntil === null || now >= snoozedUntil) return entry;
      return { ...entry, item: { ...entry.item, snoozeUntil: snoozedUntil } };
    })
    .sort(
      (a, b) =>
        a.item.rank - b.item.rank ||
        a.item.raisedAt - b.item.raisedAt ||
        a.item.id.localeCompare(b.item.id),
    );
}

/** The items alone, which is what every in-app surface consumes. */
export function attentionItems(
  derived: readonly DerivedAttentionItem[],
): readonly AttentionItem[] {
  return derived.map((entry) => entry.item);
}

function approvalRow(source: ApprovalAttentionSource): DerivedAttentionItem {
  const attention = source.attention;
  return {
    item: {
      id: approvalItemId(attention.approvalId),
      feed: "approval",
      target: source.target,
      rank: ATTENTION_RANKS.approval,
      summary: attention.sentence,
      payload: {
        kind: "approval",
        approvalId: attention.approvalId,
        // The capability being asked for, in the vocabulary the ask itself uses:
        // the tool where there is one, the kind where there is not (a claim).
        capability: attention.tool ?? attention.askKind,
      },
      raisedAt: attention.raisedAt,
      snoozeUntil: null,
    },
    states: ["blocked", "wants-decision", "anything"],
  };
}

function questionRow(source: QuestionAttentionSource): DerivedAttentionItem {
  const question = source.question;
  return {
    item: {
      id: questionItemId(question.id),
      feed: "question",
      target: source.target,
      rank: ATTENTION_RANKS.question,
      summary: `${question.sessionId}: ${question.text}`,
      payload: {
        kind: "question",
        questionId: question.id,
        text: question.text,
        // Verbatim from the record, ids included: `answerQuestion` takes the
        // option's real id, so a row that carried labels alone would need a
        // label→id resolution nothing should have to do.
        options: question.options.map((option) => ({
          id: option.id,
          label: option.label,
        })),
      },
      raisedAt: question.askedAt,
      snoozeUntil: null,
    },
    states: ["blocked", "wants-decision", "anything"],
  };
}

function healthRow(alert: HealthAlert): DerivedAttentionItem {
  const blocking =
    alert.alert === "blocked-on-you" || alert.alert === "unanswered";
  return {
    item: {
      id: alert.id,
      feed: "health",
      target: alert.target,
      rank: blocking
        ? ATTENTION_RANKS.blockedHealth
        : ATTENTION_RANKS.otherHealth,
      summary: alert.summary,
      payload: { kind: "health", alert: alert.alert },
      raisedAt: alert.since,
      snoozeUntil: null,
    },
    states: blocking
      ? ["blocked", "wants-decision", "anything"]
      : ["wants-decision", "anything"],
  };
}

function completionRow(
  source: CompletionAttentionSource,
): DerivedAttentionItem {
  const facts = endStateFacts(source.end);
  const states: AttentionState[] = ["anything"];
  if (facts.failed || !facts.proven) states.push("failed");
  if (facts.wantsDecision) states.push("wants-decision");

  return {
    item: {
      id: completionItemId(source.sessionId),
      feed: "completion",
      target: source.target,
      rank: facts.wantsDecision
        ? ATTENTION_RANKS.wantsDecisionCompletion
        : ATTENTION_RANKS.completion,
      summary: source.summary,
      payload: { kind: "completion", sessionId: source.sessionId },
      raisedAt: source.end.at,
      snoozeUntil: null,
    },
    states,
  };
}

function driftRow(source: DriftAttentionSource): DerivedAttentionItem {
  return {
    item: {
      id: driftItemKey(source.flag.consumer, source.flag.objectId),
      feed: "drift",
      target: source.target,
      rank: ATTENTION_RANKS.drift,
      summary: source.changedSummary,
      payload: {
        kind: "drift",
        objectId: source.flag.objectId,
        changedSummary: source.changedSummary,
      },
      raisedAt: source.raisedAt,
      snoozeUntil: null,
    },
    states: ["wants-decision", "anything"],
  };
}

function broadcastRow(source: BroadcastAttentionSource): DerivedAttentionItem {
  const attention = source.attention;
  return {
    item: {
      id: broadcastItemId(attention.broadcastId),
      feed: "broadcast",
      target: source.target,
      rank: ATTENTION_RANKS.broadcast,
      // The broadcast's own text is deliberately not in the summary: it is
      // content a session wrote, it goes out over notification routes (§7.3),
      // and the operator is being told that one happened rather than asked to
      // read it. The category and the reach are what the row is for.
      summary: `${attention.senderSessionId} broadcast to ${attention.recipientCount} ${attention.recipientCount === 1 ? "session" : "sessions"}: ${attention.category}`,
      payload: {
        kind: "broadcast",
        broadcastId: attention.broadcastId,
        category: attention.category,
        recipientCount: attention.recipientCount,
      },
      raisedAt: attention.at,
      snoozeUntil: null,
    },
    states: ["anything"],
  };
}
