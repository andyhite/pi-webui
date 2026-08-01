import { describe, expect, it } from "vitest";

import {
  decideNotification,
  EMPTY_NOTIFICATION_STATE,
  newAttentionItemIds,
  nextNotificationEdgeState,
} from "./notifications.js";
import type { AttentionItem } from "./types.js";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "a",
    feed: "question",
    target: { nodeId: "n1", workstreamId: "w1" },
    rank: 0,
    summary: "summary of a",
    payload: {
      kind: "question",
      questionId: "q1",
      text: "text",
      options: [{ id: "opt-yes", label: "yes" }],
    },
    raisedAt: 0,
    snoozeUntil: null,
    ...overrides,
  };
}

describe("decideNotification", () => {
  it("fires once for a brand-new item", () => {
    const notification = decideNotification([item()], EMPTY_NOTIFICATION_STATE);
    expect(notification?.itemIds).toEqual(["a"]);
  });

  it("never re-fires for an item already notified (edge-triggered)", () => {
    const state = nextNotificationEdgeState(EMPTY_NOTIFICATION_STATE, [item()]);
    expect(decideNotification([item()], state)).toBeNull();
  });

  it("batches several new items into one notification naming the count", () => {
    const items = [item({ id: "a" }), item({ id: "b" }), item({ id: "c" })];
    const notification = decideNotification(items, EMPTY_NOTIFICATION_STATE);
    expect(notification?.itemIds).toEqual(["a", "b", "c"]);
    expect(notification?.title).toBe("3 new items need attention");
  });

  it("fires only for the genuinely new subset when some were already notified", () => {
    const state = nextNotificationEdgeState(EMPTY_NOTIFICATION_STATE, [
      item({ id: "a" }),
    ]);
    const notification = decideNotification(
      [item({ id: "a" }), item({ id: "b" })],
      state,
    );
    expect(notification?.itemIds).toEqual(["b"]);
  });

  it("a snoozed item that returns later is a new occurrence, notified again", () => {
    // Gone from `visible` while snoozed (dropped by the queue's own
    // filtering) — the edge state should forget it so its return re-fires.
    const afterFirst = nextNotificationEdgeState(EMPTY_NOTIFICATION_STATE, [
      item({ id: "a" }),
    ]);
    const whileSnoozed = nextNotificationEdgeState(afterFirst, []);
    const notification = decideNotification([item({ id: "a" })], whileSnoozed);
    expect(notification?.itemIds).toEqual(["a"]);
  });
});

describe("newAttentionItemIds / nextNotificationEdgeState", () => {
  it("reports nothing new once folded forward", () => {
    const first = newAttentionItemIds([item()], EMPTY_NOTIFICATION_STATE);
    expect(first).toEqual(["a"]);
    const state = nextNotificationEdgeState(EMPTY_NOTIFICATION_STATE, [item()]);
    expect(newAttentionItemIds([item()], state)).toEqual([]);
  });
});
