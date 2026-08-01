# The attention contract — for Track A (Epic 6.1 Stage 2)

Landed by Track B, Batch 4 Stage 1 (Weeks 15–18). This is the shape every
in-app attention surface (`packages/ui/src/attention/`) is already built and
tested against, via `createFixtureAttentionDataSource`
(`packages/ui/src/attention/data-source.ts`). Track A's Stage 2 job is to
implement the same interface server-side (`createApiAttentionDataSource`,
which does not exist yet) and swap it in at `apps/web/src/App.tsx`'s one
call site — nothing downstream should need to change.

## Why this shape

Spec §7: "one derivation, many surfaces." The queue, node badges, off-screen
markers, the header count, the window title, the app badge, and system
notifications are all pure projections of one ranked list — there is
deliberately no second computation of "what needs attention" anywhere in
`packages/ui`. Whatever Track A derives server-side has to arrive as this one
list for that property to hold end to end.

## The types (`packages/ui/src/attention/types.ts`)

```ts
export type AttentionFeed =
  "question" | "approval" | "drift" | "health" | "completion" | "broadcast";

export interface AttentionTarget {
  readonly nodeId: string;
  readonly workstreamId: string | null;
  readonly sessionId?: string;
}

/** Matches @plotroom/core's SessionQuestion.options shape (id + label). */
export interface AttentionQuestionOption {
  readonly id: string;
  readonly label: string;
}

export type AttentionAnswerPayload =
  | {
      kind: "question";
      questionId: string;
      text: string;
      options: readonly AttentionQuestionOption[];
    }
  | { kind: "approval"; approvalId: string; capability: string }
  | { kind: "drift"; objectId: string; changedSummary: string }
  | {
      kind: "health";
      alert:
        | "idle"
        | "spinning"
        | "conflict-predicted"
        | "unanswered"
        | "blocked-on-you";
    }
  | { kind: "completion"; sessionId: string }
  | {
      // @plotroom/core's BroadcastAttention (sessions/broadcast.ts), on
      // main already: §6.5 "a session-originated broadcast appears in the
      // queue." No answer beyond triage — the operator is told, not asked.
      kind: "broadcast";
      broadcastId: string;
      category: string;
      recipientCount: number;
    };

export interface AttentionItem {
  /**
   * MUST be stable across a resync (REQUIRED). The notification
   * edge-trigger and the queue's own selection both key on this id across
   * separate `subscribe()` emissions — an id regenerated per read would
   * make an already-seen item look new (spurious re-notification) and
   * silently drop the queue's highlight. Derive it from the underlying
   * fact (a question's own id, `driftItemKey` for drift, ...), never mint
   * a fresh one per read.
   */
  readonly id: string;
  readonly feed: AttentionFeed;
  readonly target: AttentionTarget;
  /** Lower sorts first. Assigned upstream — no surface recomputes priority, only orders by it. */
  readonly rank: number;
  /** Enough context to answer without opening anything (§7.1). */
  readonly summary: string;
  readonly payload: AttentionAnswerPayload;
  readonly raisedAt: number;
  /**
   * Informational only, not something a surface filters on (see the
   * NORMATIVE rule below). `null` whenever the item is not currently
   * snoozed, including immediately after it returns — a stale non-null
   * value here would be indistinguishable from "still hidden."
   */
  readonly snoozeUntil: number | null;
}
```

### NORMATIVE: hiding is the source's job, not a surface's

**This corrects a self-contradiction an earlier draft of this contract had**
(caught in Batch 4 review): the source, not the queue or any other surface,
MUST exclude every item a `mute` has permanently dismissed and every item a
`snooze` has not yet released, _before_ `list()`/`subscribe()` ever emits it.
`createFixtureAttentionDataSource` (`data-source.ts`) is the reference
implementation — it filters its own real `TriageLedger` through
`queue.ts#visibleAttentionItems` on every emission. A surface never holds a
ledger of its own and never re-filters; it only ranks what it is given
(`queue.ts#rankAttentionItems`, which `QueuePanel` calls — it used to call
`visibleAttentionItems` against an always-empty ledger, which filtered
nothing and only pretended to double-check triage state it had no real copy
of; that call is gone now).

**A live implementation must also never emit a transient empty snapshot
during a resync.** Follow the same discipline `createApiQuestionDataSource`/
`createApiGraphDataSource` already do: connect, buffer incoming events,
apply one real snapshot, and only then start delivering — never a bare `[]`
in between. Beyond staleness, a spurious empty emission here would make
`notifications.ts`'s edge-trigger (`nextNotificationEdgeState` folds its
state forward _by id_) treat every currently-open item as brand new on the
very next real emission and re-fire a notification for all of them at once.

Plus triage verbs and two feed-specific answer hooks — the full interface:

```ts
interface AttentionDataSource {
  list(): Promise<readonly AttentionItem[]>;
  subscribe(onChange: (items: readonly AttentionItem[]) => void): Unsubscribe;
  acknowledge(itemId: string, input: { at: number; by: Author }): Promise<void>;
  snooze(
    itemId: string,
    input: { at: number; by: Author; snoozedUntil: number },
  ): Promise<void>;
  mute(itemId: string, input: { at: number; by: Author }): Promise<void>;
  // optionId is the real id off the picked AttentionQuestionOption, never
  // its label — the row always carries both, so there is no label→id
  // resolution anywhere downstream of this call (a live source populates
  // options from SessionQuestion.options directly, id and label both).
  answerQuestion(
    itemId: string,
    optionId: string,
    input: TriageActionInput,
  ): Promise<void>;
  decideApproval(
    itemId: string,
    decision: "approve" | "deny",
    input: TriageActionInput,
  ): Promise<void>;
}
```

## What the UI already assumes, load-bearing

- **Muted items never appear again, and hiding is the source's job** — see
  the NORMATIVE section above; this is the corrected version of a rule an
  earlier draft stated but did not actually implement consistently.
- **A snoozed item stops arriving while hidden, and returns with
  `snoozeUntil: null`** once the source's own clock says its time is up.
  Dropping it silently forever would be indistinguishable from a mute;
  reporting a stale `snoozeUntil` after it returns would be indistinguishable
  from still being hidden.
- **Answering also acknowledges.** `answerQuestion`/`decideApproval` are
  expected to behave as "the item leaves the queue" in the same gesture —
  the UI never calls `acknowledge` separately after answering.
- **Triage is the one ledger.** All six feeds use the same three verbs
  (§4.5). A live implementation is expected to key triage records by
  `AttentionItem.id`, exactly like `@plotroom/core`'s `TriageLedger` already
  does for drift (`driftItemKey`) — extended here to every feed rather than
  drift alone.
- **`rank` is assigned upstream.** A surface (`attention/queue.ts`'s
  `rankAttentionItems`) only ever sorts by `rank` ascending, tie-broken by
  `raisedAt` ascending. Track A's derivation decides what "more urgent" means
  across feeds (an unanswered approval outranking a drift flag, say) — the UI
  has no opinion and never will.
- **Question options carry real ids.** `AttentionQuestionOption` is
  `{id, label}`, matching `SessionQuestion.options` (`bubbles/question-
source.ts`) directly — a live source should populate it verbatim rather
  than flattening to labels, which is what made the earlier `string[]`
  shape a lie about what `answerQuestion`'s `optionId` parameter actually
  needs.
- **Ids are stable across resync**, and a resync never emits a transient
  `[]` — both above, in the NORMATIVE section, because getting either wrong
  breaks the notification edge-trigger and the queue's own selection
  tracking in ways that only show up after the first reconnect, not in an
  initial-load test.

## Gaps Track A's Stage 2 needs to close (not fixture-fakeable from here)

1. **The derivation itself** — turning drift/questions/approvals/completions
   and §7.2's health signals (idle, spinning, conflict-predicted, unanswered,
   blocked-on-you with claim-wait thresholds) into ranked `AttentionItem`s.
   Nothing in `packages/ui` computes any of this; it is all fixture data.
2. **`createApiAttentionDataSource`** — the live implementation of the
   interface above, swapped in at `apps/web/src/App.tsx`'s
   `attentionDataSource` constant (currently unconditionally
   `createFixtureAttentionDataSource`).
3. **Outbound notification routing** (§7.3) — state-attached push/webhook
   routes, with redaction. Not started; the in-app system notification
   (`attention/notifications.ts`) is a different, already-landed surface and
   shares only the "edge-triggered" discipline with this one, not any code.
4. **A fleet aggregate endpoint** (Epic 6.2, not 6.1, but the same batch): no
   endpoint returns the concurrency limit's configured value, and
   `GET /api/spend` has no per-session breakdown or "today" scoping. See
   `packages/ui/src/fleet/types.ts`'s doc comment and the `TODO` in
   `fleet/data-source.ts`. `FleetPanel` aggregates what it can from
   `GET /api/sessions` + per-session `GET /api/sessions/:id/spend` in the
   meantime — real data, real aggregation, not a fixture.

## What Track B already proved works against this shape

- `rankAttentionItems`, `visibleAttentionItems`, `moveQueueSelection`,
  `acknowledgeOnAnswer` — the surface/source ranking split above, clamped
  j/k traversal, and the answer-also-acknowledges rule
  (`attention/queue.test.ts`).
- `decideNotification` / `nextNotificationEdgeState` — edge-triggered,
  batched, and correctly re-fires once a snoozed item returns
  (`attention/notifications.test.ts`).
- `appendActivityEntry` / `describeActivityTarget` — the what-changed
  history's per-workstream cap and its honest tombstone for a gone target
  (`attention/what-changed.test.ts`).
- `deriveWindowTitle` / `deriveBadgeCount` — the title/badge half of "one
  derivation, many surfaces" (`attention/surfaces.test.ts`).
- The app badge itself, end to end through Electron: `apps/desktop/src/
badge.ts` (`applyBadgeCount`) wired through a minimal `contextBridge`
  preload (`apps/desktop/src/preload.ts`) and `ipcMain` listener
  (`apps/desktop/src/main.ts`); `apps/web` calls `window.plotroom?.
setBadgeCount(...)`, feature-detected, no-op in a plain browser tab.

38 tests across `packages/ui/src/attention/*.test.ts` exercise every pure
function above (`queue.test.ts`, `data-source.test.ts`, `notifications.
test.ts`, `surfaces.test.ts`, `what-changed.test.ts` — `off-screen.test.ts`'s
own 5 predate this stage and are not counted here); none of them need a
live server to pass, and none of them should need to change once one
exists.
