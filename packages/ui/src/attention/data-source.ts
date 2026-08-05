/**
 * `AttentionDataSource` (§7): the one seam every attention surface reads
 * through. `createApiAttentionDataSource` is the live implementation, over
 * Track A's Stage 2 endpoints (`GET /api/attention`, the `attention` `/ws`
 * entity, and the triage/answer routes — see `docs/attention-contract.md`).
 * `createFixtureAttentionDataSource` stays for tests and `VITE_USE_FIXTURES`
 * dev, behind the identical interface — the fixture carries realistic
 * scenarios, one per feed, so every surface in this package has something
 * concrete to render offline.
 */

import {
  APPROVAL_ANSWER_OPTIONS,
  EMPTY_TRIAGE,
  humanAuthor,
  type ApprovalDecision,
  type DomainEvent,
  type TriageLedger,
} from "@plotroom/core";

import type { HttpClient } from "../transport/http.js";
import type { WebSocketFactory } from "../transport/ws.js";
import { createReconnectingSocket } from "../transport/ws.js";
import type { Unsubscribe } from "../data-source/types.js";
import { parseWsMessage } from "../data-source/api.js";
import {
  acknowledgeOnAnswer,
  applyQueueTriage,
  visibleAttentionItems,
} from "./queue.js";
import type {
  AttentionDataSource,
  AttentionItem,
  SnoozeActionInput,
  TriageActionInput,
} from "./types.js";

function defaultNow(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Six realistic rows, one per feed (§7.1, §6.5), ranked in the order the
 * spec lists the feeds — approvals and questions block a session outright,
 * drift and health are informational-until-acted-on, completions and
 * broadcasts are the lowest urgency. Ranking itself is Track A's
 * derivation; these numbers are the fixture's own stand-in ordering, not a
 * rule this package enforces.
 */
export const FIXTURE_ATTENTION_ITEMS: readonly AttentionItem[] = [
  {
    id: "attn-approval-1",
    feed: "approval",
    target: {
      nodeId: "session-migrate",
      workstreamId: "workstream-oxy-2982",
      sessionId: "session-migrate",
    },
    rank: 0,
    summary: "session-migrate wants to force-push origin/main (irreversible)",
    payload: {
      kind: "approval",
      approvalId: "approval-1",
      capability: "git:force-push",
      answers: APPROVAL_ANSWER_OPTIONS,
      effectFailure: null,
    },
    raisedAt: 1_000,
    snoozeUntil: null,
  },
  {
    id: "attn-question-1",
    feed: "question",
    target: {
      nodeId: "session-migrate",
      workstreamId: "workstream-oxy-2982",
      sessionId: "session-migrate",
    },
    rank: 1,
    summary: "session-migrate: keep going with the migration?",
    payload: {
      kind: "question",
      questionId: "q1",
      text: "keep going with the migration?",
      options: [
        { id: "opt-yes", label: "yes" },
        { id: "opt-no", label: "no" },
        { id: "opt-later", label: "ask again later" },
      ],
    },
    raisedAt: 900,
    snoozeUntil: null,
  },
  {
    id: "attn-drift-1",
    feed: "drift",
    target: {
      nodeId: "command-review",
      workstreamId: "workstream-oxy-2982",
    },
    rank: 2,
    summary: "the ticket this command reads changed since its last run",
    payload: {
      kind: "drift",
      objectId: "object-ticket-1",
      changedSummary: "ticket status moved from In Progress to In Review",
    },
    raisedAt: 800,
    snoozeUntil: null,
  },
  {
    id: "attn-health-1",
    feed: "health",
    target: {
      nodeId: "session-longrunner",
      workstreamId: "workstream-oxy-2982",
      sessionId: "session-longrunner",
    },
    rank: 3,
    summary: "session-longrunner has been silent for 12 minutes",
    payload: { kind: "health", alert: "idle" },
    raisedAt: 700,
    snoozeUntil: null,
  },
  {
    id: "attn-completion-1",
    feed: "completion",
    target: {
      nodeId: "session-docs",
      workstreamId: "workstream-oxy-2982",
      sessionId: "session-docs",
    },
    rank: 4,
    summary: "session-docs finished: updated the contributing guide",
    payload: { kind: "completion", sessionId: "session-docs" },
    raisedAt: 600,
    snoozeUntil: null,
  },
  {
    id: "attn-broadcast-1",
    feed: "broadcast",
    target: {
      nodeId: "session-migrate",
      workstreamId: "workstream-oxy-2982",
      sessionId: "session-migrate",
    },
    rank: 5,
    summary:
      "session-migrate broadcast to 3 sessions: material state changed under you",
    payload: {
      kind: "broadcast",
      broadcastId: "broadcast-1",
      category: "material-state-changed",
      recipientCount: 3,
    },
    raisedAt: 500,
    snoozeUntil: null,
  },
];

export function createFixtureAttentionDataSource(
  initial: readonly AttentionItem[] = FIXTURE_ATTENTION_ITEMS,
  now: () => number = defaultNow,
): AttentionDataSource {
  const items = initial;
  let ledger: TriageLedger = EMPTY_TRIAGE;
  const listeners = new Set<(items: readonly AttentionItem[]) => void>();

  function currentItems(): readonly AttentionItem[] {
    // Snoozed items report their `snoozeUntil` back to the caller while
    // still hidden (§7.1) — it lives in the ledger, not on the static item,
    // so it is folded in here rather than mutated onto the fixture array.
    // Only while `now() < snoozedUntil`: once it elapses the record is
    // stale (`visibleAttentionItems` below is about to let the item back
    // through), and `snoozeUntil` MUST read `null` again the instant it
    // returns (`types.ts`'s own contract) — a caller reading a non-null
    // value here has no way to tell "still hidden" from "just came back".
    const at = now();
    const withSnooze = items.map((item) => {
      const record = ledger.get(item.id);
      const snoozedUntil =
        record?.verb === "snooze" ? record.snoozedUntil : null;
      if (snoozedUntil === null || at >= snoozedUntil) return item;
      return { ...item, snoozeUntil: snoozedUntil };
    });
    // Ranked and filtered by the exact same reducer a caller could apply by
    // hand (`queue.ts#visibleAttentionItems`), so a muted item genuinely
    // never returns and a snoozed one returns only once its time is up.
    return visibleAttentionItems(withSnooze, ledger, at);
  }

  function notify(): void {
    const snapshot = currentItems();
    for (const listener of listeners) listener(snapshot);
  }

  return {
    list(): Promise<readonly AttentionItem[]> {
      return Promise.resolve(currentItems());
    },

    subscribe(onChange): Unsubscribe {
      listeners.add(onChange);
      onChange(currentItems());
      return () => {
        listeners.delete(onChange);
      };
    },

    acknowledge(itemId, input): Promise<void> {
      ledger = applyQueueTriage(ledger, itemId, "acknowledge", input);
      notify();
      return Promise.resolve();
    },

    snooze(itemId, input: SnoozeActionInput): Promise<void> {
      ledger = applyQueueTriage(ledger, itemId, "snooze", input);
      notify();
      return Promise.resolve();
    },

    mute(itemId, input): Promise<void> {
      ledger = applyQueueTriage(ledger, itemId, "mute", input);
      notify();
      return Promise.resolve();
    },

    answerQuestion(itemId, _optionId, input: TriageActionInput): Promise<void> {
      ledger = acknowledgeOnAnswer(ledger, itemId, input);
      notify();
      return Promise.resolve();
    },

    decideApproval(
      itemId,
      _decision,
      input: TriageActionInput,
      _reason?: string,
    ): Promise<void> {
      ledger = acknowledgeOnAnswer(ledger, itemId, input);
      notify();
      return Promise.resolve();
    },
  };
}

/** Convenience for a caller that just wants an author-stamped "now". */
export function humanTriageInput(at: number): TriageActionInput {
  return { at, by: humanAuthor };
}

/* ------------------------------------------------------------------- live */

interface RawAttentionResponse {
  readonly items: readonly AttentionItem[];
}

interface BufferState {
  buffering: boolean;
  events: DomainEvent[];
}

export interface ApiAttentionDataSourceOptions {
  readonly http: HttpClient;
  readonly createSocket: WebSocketFactory;
}

/**
 * Live over `GET /api/attention` plus the `attention` `/ws` entity
 * (`docs/attention-contract.md`). The server already hides what triage
 * dismissed and already ranks the list, so this never re-derives, re-ranks,
 * or re-filters anything — it only keeps a live map of ids to items current.
 *
 * The resync recipe is `createApiGraphDataSource`'s (connect, buffer,
 * fetch one real snapshot, apply the rest, then deliver), adapted for an
 * endpoint with no `seq` of its own: `GET /api/attention` is a point-in-time
 * read with nothing to compare a buffered event's ordinal against, so every
 * buffered event is simply replayed over the snapshot once it lands — each
 * one is an idempotent upsert-or-delete by id, so replaying one already
 * reflected in the snapshot changes nothing. What the recipe still buys
 * here: a caller never sees a transient state older than what it already
 * had, and (per `types.ts`'s NORMATIVE rule) never a bare `[]` mid-resync.
 */
export function createApiAttentionDataSource(
  options: ApiAttentionDataSourceOptions,
): AttentionDataSource {
  const { http, createSocket } = options;

  let itemsById = new Map<string, AttentionItem>();
  let started = false;
  let socket: ReturnType<typeof createReconnectingSocket> | null = null;
  let currentBuffer: BufferState | null = null;
  const listeners = new Set<(items: readonly AttentionItem[]) => void>();

  function currentItems(): readonly AttentionItem[] {
    return [...itemsById.values()];
  }

  function notify(): void {
    const snapshot = currentItems();
    for (const listener of listeners) listener(snapshot);
  }

  function applyEvent(event: DomainEvent): void {
    if (event.entity !== "attention") return;
    const next = new Map(itemsById);
    if (event.verb === "deleted") {
      next.delete(event.itemId);
    } else {
      next.set(event.item.id, event.item);
    }
    itemsById = next;
  }

  async function resync(buffer: BufferState): Promise<void> {
    const raw = await http.get<RawAttentionResponse>("/api/attention");
    // A newer (re)connect already moved on to its own buffer; this resync
    // lost the race (same reasoning as the graph data source's own recipe).
    if (currentBuffer !== buffer) return;

    itemsById = new Map(raw.items.map((item) => [item.id, item]));
    for (const event of buffer.events) applyEvent(event);
    buffer.buffering = false;
    buffer.events = [];
    notify();
  }

  function ensureStarted(): void {
    if (started) return;
    started = true;

    socket = createReconnectingSocket({
      createSocket,
      onStatusChange: (status) => {
        if (status !== "open") return;
        const buffer: BufferState = { buffering: true, events: [] };
        currentBuffer = buffer;
        void resync(buffer);
      },
      onMessage: (data) => {
        const message = parseWsMessage(data);
        if (!message || message.type !== "event" || !currentBuffer) return;
        if (currentBuffer.buffering) {
          currentBuffer.events.push(message.event);
        } else {
          applyEvent(message.event);
          notify();
        }
      },
    });
  }

  function stopIfIdle(): void {
    if (listeners.size > 0) return;
    socket?.close();
    socket = null;
    started = false;
    currentBuffer = null;
    itemsById = new Map();
  }

  return {
    // Also seeds `itemsById`: a caller that reads once without subscribing
    // (or subscribes later) can still `answerQuestion`/`decideApproval`
    // immediately, since both resolve the real target id off this cache
    // rather than off `AttentionItem.id`. Overwriting here is safe even
    // mid-subscription — it is the same authoritative read `resync` uses.
    list(): Promise<readonly AttentionItem[]> {
      return http.get<RawAttentionResponse>("/api/attention").then((raw) => {
        itemsById = new Map(raw.items.map((item) => [item.id, item]));
        return raw.items;
      });
    },

    subscribe(onChange): Unsubscribe {
      listeners.add(onChange);
      ensureStarted();
      if (itemsById.size > 0) onChange(currentItems());

      return () => {
        listeners.delete(onChange);
        stopIfIdle();
      };
    },

    acknowledge(itemId): Promise<void> {
      return http
        .post(`/api/attention/${encodeURIComponent(itemId)}/acknowledge`, {})
        .then(() => undefined);
    },

    snooze(itemId, input: SnoozeActionInput): Promise<void> {
      return http
        .post(`/api/attention/${encodeURIComponent(itemId)}/snooze`, {
          snoozedUntil: input.snoozedUntil,
        })
        .then(() => undefined);
    },

    mute(itemId): Promise<void> {
      return http
        .post(`/api/attention/${encodeURIComponent(itemId)}/mute`, {})
        .then(() => undefined);
    },

    /**
     * The attention item id is not the question id: `payload.questionId`
     * is the real target `POST /api/questions/:id/answer` needs. Answering
     * also acknowledges by the contract, but that is the server's own
     * doing (answering makes the row stop asking, so the next derivation
     * omits it) — this never calls `acknowledge` itself, the same rule
     * every other answer path in this package follows.
     */
    answerQuestion(itemId, optionId): Promise<void> {
      const item = itemsById.get(itemId);
      if (!item || item.payload.kind !== "question") {
        return Promise.reject(
          new Error(`${itemId} is not a question row (or is gone)`),
        );
      }
      return http
        .post(
          `/api/questions/${encodeURIComponent(item.payload.questionId)}/answer`,
          { optionId },
        )
        .then(() => undefined);
    },

    /** Same reasoning as `answerQuestion`: `payload.approvalId` is the real target. */
    decideApproval(
      itemId,
      decision: ApprovalDecision,
      _input,
      reason?: string,
    ): Promise<void> {
      const item = itemsById.get(itemId);
      if (!item || item.payload.kind !== "approval") {
        return Promise.reject(
          new Error(`${itemId} is not an approval row (or is gone)`),
        );
      }
      return http
        .post(
          `/api/approvals/${encodeURIComponent(item.payload.approvalId)}/answer`,
          { decision, ...(reason === undefined ? {} : { reason }) },
        )
        .then(() => undefined);
    },
  };
}
