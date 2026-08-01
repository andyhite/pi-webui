/**
 * `AttentionDataSource` (§7): the one seam every attention surface reads
 * through. `createFixtureAttentionDataSource` is Stage 1's only
 * implementation — there is no `createApiAttentionDataSource` yet because
 * there is nothing server-side to call (Track A's Stage 2 job, see
 * `types.ts`'s doc comment for the handoff shape). The fixture carries
 * realistic scenarios, one per feed, so every surface in this package has
 * something concrete to render in dev/offline mode and in tests.
 */

import { EMPTY_TRIAGE, humanAuthor, type TriageLedger } from "@plotroom/core";

import type { Unsubscribe } from "../data-source/types.js";
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
 * Five realistic rows, one per feed (§7.1), ranked in the order the spec
 * lists the feeds — approvals and questions block a session outright, drift
 * and health are informational-until-acted-on, completions are the lowest
 * urgency. Ranking itself is Track A's derivation; these numbers are the
 * fixture's own stand-in ordering, not a rule this package enforces.
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
      options: ["yes", "no", "ask again later"],
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
];

export function createFixtureAttentionDataSource(
  initial: readonly AttentionItem[] = FIXTURE_ATTENTION_ITEMS,
  now: () => number = defaultNow,
): AttentionDataSource {
  const items = initial;
  let ledger: TriageLedger = EMPTY_TRIAGE;
  const listeners = new Set<(items: readonly AttentionItem[]) => void>();

  function currentItems(): readonly AttentionItem[] {
    // Snoozed items report their `snoozeUntil` back to the caller (§7.1) —
    // it lives in the ledger, not on the static item, so it is folded in
    // here rather than mutated onto the fixture array — then ranked and
    // filtered by the exact same reducer a caller could apply by hand
    // (`queue.ts#visibleAttentionItems`), so a muted item genuinely never
    // returns and a snoozed one returns only once its time is up (§7.1).
    const withSnooze = items.map((item) => {
      const record = ledger.get(item.id);
      if (!record || record.verb !== "snooze") return item;
      return { ...item, snoozeUntil: record.snoozedUntil };
    });
    return visibleAttentionItems(withSnooze, ledger, now());
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

    decideApproval(itemId, _decision, input: TriageActionInput): Promise<void> {
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
