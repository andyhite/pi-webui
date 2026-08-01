/**
 * Outbound-facing surfaces share one discipline (§7.3): "edge-triggered ...
 * only on new items, never re-fired." This module is the pure decision —
 * given what was already notified and what is visible now, what (if
 * anything) fires next — kept apart from `Notification` itself so the
 * rule is testable without a fake global and without a fake clock hiding
 * inside a `setTimeout`.
 *
 * Two disciplines, both load-bearing:
 *
 *   - **Edge-triggered.** An id notified once is never notified again while
 *     it stays visible — muting/acknowledging/snoozing it and then it
 *     coming back later (a different visible occurrence) is the only way
 *     the same id notifies twice, because a snooze that elapses is,
 *     correctly, a new arrival to be noticed again (§7.1's own "snoozed
 *     items return" rule extends here).
 *   - **A simple debounce/batch.** Several items arriving within one
 *     window collapse into a single notification naming the count, so a
 *     burst (a broadcast landing on twelve sessions, say) is one system
 *     notification, not twelve.
 */

import type { AttentionItem } from "./types.js";

export interface AttentionNotification {
  readonly title: string;
  readonly body: string;
  readonly itemIds: readonly string[];
}

export interface NotificationEdgeState {
  /** Every item id a notification has already fired for, so it never fires twice for the same occurrence. */
  readonly notifiedIds: ReadonlySet<string>;
}

export const EMPTY_NOTIFICATION_STATE: NotificationEdgeState = {
  notifiedIds: new Set(),
};

/**
 * The ids in `visible` that have never been notified before — the raw
 * "what's new" set, before batching into one notification. Exported on its
 * own because the id set is also what `nextNotificationEdgeState` needs to
 * fold forward.
 */
export function newAttentionItemIds(
  visible: readonly AttentionItem[],
  state: NotificationEdgeState,
): readonly string[] {
  return visible
    .filter((item) => !state.notifiedIds.has(item.id))
    .map((item) => item.id);
}

/** Folds newly-notified ids into the edge state — call once per `decideNotification`. */
export function nextNotificationEdgeState(
  state: NotificationEdgeState,
  visible: readonly AttentionItem[],
): NotificationEdgeState {
  const stillVisible = new Set(visible.map((item) => item.id));
  const notifiedIds = new Set(
    [...state.notifiedIds].filter((id) => stillVisible.has(id)),
  );
  for (const item of visible) notifiedIds.add(item.id);
  return { notifiedIds };
}

function summaryTitle(items: readonly AttentionItem[]): string {
  if (items.length === 1) {
    const only = items[0];
    return only ? feedLabel(only.feed) : "attention";
  }
  return `${items.length} new items need attention`;
}

function feedLabel(feed: AttentionItem["feed"]): string {
  switch (feed) {
    case "question":
      return "a session asked a question";
    case "approval":
      return "a session needs approval";
    case "drift":
      return "context drifted";
    case "health":
      return "a session needs a look";
    case "completion":
      return "a session finished";
    case "broadcast":
      return "a session broadcast to other sessions";
  }
}

/**
 * One notification for every newly-visible item since `state`, batched into
 * a single call — `null` when nothing is new (edge-triggered: re-running
 * this against an unchanged `visible` fires nothing).
 */
export function decideNotification(
  visible: readonly AttentionItem[],
  state: NotificationEdgeState,
): AttentionNotification | null {
  const newIds = new Set(newAttentionItemIds(visible, state));
  if (newIds.size === 0) return null;

  const newItems = visible.filter((item) => newIds.has(item.id));
  return {
    title: summaryTitle(newItems),
    body: newItems.map((item) => item.summary).join("\n"),
    itemIds: newItems.map((item) => item.id),
  };
}
