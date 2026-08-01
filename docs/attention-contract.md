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
  "question" | "approval" | "drift" | "health" | "completion";

export interface AttentionTarget {
  readonly nodeId: string;
  readonly workstreamId: string | null;
  readonly sessionId?: string;
}

export type AttentionAnswerPayload =
  | {
      kind: "question";
      questionId: string;
      text: string;
      options: readonly string[];
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
  | { kind: "completion"; sessionId: string };

export interface AttentionItem {
  readonly id: string;
  readonly feed: AttentionFeed;
  readonly target: AttentionTarget;
  /** Lower sorts first. Assigned upstream — no surface recomputes priority, only orders by it. */
  readonly rank: number;
  /** Enough context to answer without opening anything (§7.1). */
  readonly summary: string;
  readonly payload: AttentionAnswerPayload;
  readonly raisedAt: number;
  /** Set by a prior snooze; the item keeps arriving (snoozed, not gone) until `now >= snoozeUntil`. */
  readonly snoozeUntil: number | null;
}
```

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

- **Muted items never appear again.** `mute` is permanent; the source should
  simply stop emitting that id, not merely flag it (the fixture's own
  `visibleAttentionItems` re-application on every `list()`/`subscribe()`
  emission is the reference behavior — see `data-source.ts`).
- **A snoozed item keeps arriving**, with `snoozeUntil` set, until the clock
  passes it — that is what lets the queue and the fixture both derive
  visibility from `@plotroom/core`'s `triageStatus` rather than the source
  hiding it outright. If a live source _does_ hide it while snoozed, it must
  resume emitting the item (with `snoozeUntil: null` again) once the time is
  up — dropping it silently forever would be indistinguishable from a mute.
- **Answering also acknowledges.** `answerQuestion`/`decideApproval` are
  expected to behave as "the item leaves the queue" in the same gesture —
  the UI never calls `acknowledge` separately after answering.
- **Triage is the one ledger.** All five feeds use the same three verbs
  (§4.5). A live implementation is expected to key triage records by
  `AttentionItem.id`, exactly like `@plotroom/core`'s `TriageLedger` already
  does for drift (`driftItemKey`) — extended here to every feed rather than
  drift alone.
- **`rank` is assigned upstream.** The queue (`attention/queue.ts`'s
  `visibleAttentionItems`) only ever sorts by `rank` ascending, tie-broken by
  `raisedAt` ascending. Track A's derivation decides what "more urgent" means
  across feeds (an unanswered approval outranking a drift flag, say) — the UI
  has no opinion and never will.

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

- `visibleAttentionItems`, `moveQueueSelection`, `acknowledgeOnAnswer` —
  ranking, clamped j/k traversal, and the answer-also-acknowledges rule
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

47 tests across `packages/ui/src/attention/*.test.ts` exercise every pure
function above; none of them need a live server to pass, and none of them
should need to change once one exists.
