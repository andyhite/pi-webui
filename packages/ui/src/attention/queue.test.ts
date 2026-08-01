import { describe, expect, it } from "vitest";
import {
  applyTriage,
  EMPTY_TRIAGE,
  humanAuthor,
  type TriageLedger,
} from "@plotroom/core";

import {
  acknowledgeOnAnswer,
  applyQueueTriage,
  moveQueueSelection,
  rankAttentionItems,
  visibleAttentionItems,
} from "./queue.js";
import type { AttentionItem } from "./types.js";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "attn-1",
    feed: "question",
    target: { nodeId: "n1", workstreamId: "w1" },
    rank: 0,
    summary: "summary",
    payload: {
      kind: "question",
      questionId: "q1",
      text: "text",
      options: [
        { id: "opt-yes", label: "yes" },
        { id: "opt-no", label: "no" },
      ],
    },
    raisedAt: 100,
    snoozeUntil: null,
    ...overrides,
  };
}

describe("rankAttentionItems", () => {
  it("sorts by rank ascending", () => {
    const a = item({ id: "a", rank: 2 });
    const b = item({ id: "b", rank: 0 });
    const c = item({ id: "c", rank: 1 });
    expect(rankAttentionItems([a, b, c]).map((i) => i.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("tie-breaks equal rank by raisedAt ascending (oldest first)", () => {
    const a = item({ id: "a", rank: 0, raisedAt: 200 });
    const b = item({ id: "b", rank: 0, raisedAt: 100 });
    expect(rankAttentionItems([a, b]).map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("never filters — a surface with no ledger of its own trusts the source already excluded triaged items", () => {
    const a = item({ id: "a" });
    expect(rankAttentionItems([a])).toHaveLength(1);
  });
});

describe("visibleAttentionItems", () => {
  it("sorts by rank ascending, like rankAttentionItems", () => {
    const a = item({ id: "a", rank: 2 });
    const b = item({ id: "b", rank: 0 });
    const c = item({ id: "c", rank: 1 });
    const result = visibleAttentionItems([a, b, c], EMPTY_TRIAGE, 0);
    expect(result.map((i) => i.id)).toEqual(["b", "c", "a"]);
  });

  it("excludes an acknowledged item", () => {
    const a = item({ id: "a" });
    let ledger: TriageLedger = EMPTY_TRIAGE;
    ledger = applyTriage(ledger, "a", "acknowledge", {
      at: 0,
      by: humanAuthor,
    });
    expect(visibleAttentionItems([a], ledger, 0)).toEqual([]);
  });

  it("excludes a muted item permanently", () => {
    const a = item({ id: "a" });
    let ledger: TriageLedger = EMPTY_TRIAGE;
    ledger = applyTriage(ledger, "a", "mute", { at: 0, by: humanAuthor });
    expect(visibleAttentionItems([a], ledger, 1_000_000)).toEqual([]);
  });

  it("excludes a snoozed item only until its time is up", () => {
    const a = item({ id: "a" });
    let ledger: TriageLedger = EMPTY_TRIAGE;
    ledger = applyTriage(ledger, "a", "snooze", {
      at: 0,
      by: humanAuthor,
      snoozedUntil: 100,
    });
    expect(visibleAttentionItems([a], ledger, 50)).toEqual([]);
    expect(visibleAttentionItems([a], ledger, 100).map((i) => i.id)).toEqual([
      "a",
    ]);
  });
});

describe("moveQueueSelection", () => {
  const items = [
    item({ id: "a", rank: 0 }),
    item({ id: "b", rank: 1 }),
    item({ id: "c", rank: 2 }),
  ];

  it("selects the first row when nothing is selected yet", () => {
    expect(moveQueueSelection(items, null, "next")).toBe("a");
    expect(moveQueueSelection(items, null, "prev")).toBe("a");
  });

  it("moves next/prev through the list", () => {
    expect(moveQueueSelection(items, "a", "next")).toBe("b");
    expect(moveQueueSelection(items, "b", "next")).toBe("c");
    expect(moveQueueSelection(items, "c", "prev")).toBe("b");
  });

  it("clamps rather than wraps at either end", () => {
    expect(moveQueueSelection(items, "a", "prev")).toBe("a");
    expect(moveQueueSelection(items, "c", "next")).toBe("c");
  });

  it("falls back to the first row when the current selection no longer exists", () => {
    expect(moveQueueSelection(items, "gone", "next")).toBe("a");
  });

  it("returns null for an empty list", () => {
    expect(moveQueueSelection([], null, "next")).toBeNull();
    expect(moveQueueSelection([], "a", "next")).toBeNull();
  });
});

describe("applyQueueTriage / acknowledgeOnAnswer", () => {
  it("acknowledge advances the baseline without running anything (\u00a74.5)", () => {
    const ledger = applyQueueTriage(EMPTY_TRIAGE, "a", "acknowledge", {
      at: 5,
      by: humanAuthor,
    });
    expect(ledger.get("a")?.verb).toBe("acknowledge");
    expect(ledger.get("a")?.at).toBe(5);
  });

  it("acknowledgeOnAnswer is acknowledge under the hood \u2014 answering leaves the queue the same way seeing it would", () => {
    const ledger = acknowledgeOnAnswer(EMPTY_TRIAGE, "a", {
      at: 5,
      by: humanAuthor,
    });
    expect(ledger.get("a")?.verb).toBe("acknowledge");
  });

  it("snooze records when the item comes back", () => {
    const ledger = applyQueueTriage(EMPTY_TRIAGE, "a", "snooze", {
      at: 5,
      by: humanAuthor,
      snoozedUntil: 500,
    });
    expect(ledger.get("a")?.snoozedUntil).toBe(500);
  });
});
