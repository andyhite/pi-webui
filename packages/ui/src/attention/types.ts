/**
 * THE ATTENTION CONTRACT (Epic 6.1, spec §7): "one derivation, many
 * surfaces." Everything in this directory — the queue, the header count,
 * the window title, the app badge, the system notification, the off-screen
 * markers, node state, and the what-changed panel — reads from exactly one
 * feed shaped by `AttentionDataSource`. There is no second computation of
 * "what needs attention" anywhere in this package; every surface is a pure
 * projection of the same ranked list.
 *
 * **This is Track A's Stage 2 handoff shape.** The derivation itself —
 * deciding what counts as idle, spinning, conflict-predicted, unanswered,
 * blocked-on-you (§7.2), and turning drift/questions/approvals/completions
 * into ranked items — lives server-side and does not exist yet. Everything
 * in this package is built against `createFixtureAttentionDataSource`
 * below, behind this same interface, so the live swap
 * (`createApiAttentionDataSource`, Stage 2) touches nothing downstream —
 * the exact seam `createApiQuestionDataSource` and `createApiGraphDataSource`
 * already established for their own feeds.
 *
 * Five feeds (§7.1): `question`, `approval`, `drift`, `health`,
 * `completion`. Every feed supports the same three triage verbs —
 * acknowledge, snooze, mute (§4.5) — which is why they share one ledger
 * (`@plotroom/core`'s `TriageLedger`, keyed by `AttentionItem.id`) rather
 * than five bespoke ones.
 */

import type { Author } from "@plotroom/core";

import type { Unsubscribe } from "../data-source/types.js";

export const ATTENTION_FEEDS = [
  "question",
  "approval",
  "drift",
  "health",
  "completion",
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

/**
 * What "answerable in place" (§7.1) means, concretely, per feed — the shape
 * a queue row needs to render its inline control without opening anything
 * else. Every kind besides `health` names the id of the thing an answer
 * hook below acts on; a health alert has nothing to answer beyond triage.
 */
export type AttentionAnswerPayload =
  | {
      readonly kind: "question";
      readonly questionId: string;
      readonly text: string;
      readonly options: readonly string[];
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
  | { readonly kind: "completion"; readonly sessionId: string };

export interface AttentionItem {
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
   * Set by a prior `snooze` (§7.1: "the data-source contract carries
   * snoozeUntil"). The item keeps arriving from the source — snoozed, not
   * gone — and a surface hides it until `now >= snoozeUntil`
   * (`@plotroom/core`'s `triageStatus`, applied uniformly by
   * `queue.ts#visibleAttentionItems`).
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

export interface AttentionDataSource {
  /** A one-shot, point-in-time read (mirrors every other data source's `list`/`load`). */
  list(): Promise<readonly AttentionItem[]>;
  /** Live feed. Muted items never appear again (§7.1); snoozed items return, per `snoozeUntil` above. */
  subscribe(onChange: (items: readonly AttentionItem[]) => void): Unsubscribe;
  /** Seen; the consumer's baseline advances without running anything (§4.5). */
  acknowledge(itemId: string, input: TriageActionInput): Promise<void>;
  /** Bring it back later. */
  snooze(itemId: string, input: SnoozeActionInput): Promise<void>;
  /** Never show this one again. */
  mute(itemId: string, input: TriageActionInput): Promise<void>;
  /** A `question` row's inline pick (§6.4, §7.1) — also acknowledges (answering is seeing it). */
  answerQuestion(
    itemId: string,
    optionId: string,
    input: TriageActionInput,
  ): Promise<void>;
  /** An `approval` row's inline decision (§6.6, §7.1) — also acknowledges. */
  decideApproval(
    itemId: string,
    decision: "approve" | "deny",
    input: TriageActionInput,
  ): Promise<void>;
}
