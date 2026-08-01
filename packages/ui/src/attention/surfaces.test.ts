import { describe, expect, it } from "vitest";

import {
  attentionCount,
  deriveBadgeCount,
  deriveWindowTitle,
} from "./surfaces.js";
import type { AttentionItem } from "./types.js";

function item(id: string): AttentionItem {
  return {
    id,
    feed: "completion",
    target: { nodeId: "n1", workstreamId: "w1" },
    rank: 0,
    summary: "s",
    payload: { kind: "completion", sessionId: "s1" },
    raisedAt: 0,
    snoozeUntil: null,
  };
}

describe("attentionCount", () => {
  it("counts the visible items", () => {
    expect(attentionCount([item("a"), item("b")])).toBe(2);
    expect(attentionCount([])).toBe(0);
  });
});

describe("deriveWindowTitle", () => {
  it("is the bare title when there is nothing to attend to", () => {
    expect(deriveWindowTitle("PlotRoom", 0)).toBe("PlotRoom");
  });

  it("prefixes the count otherwise", () => {
    expect(deriveWindowTitle("PlotRoom", 3)).toBe("(3) PlotRoom");
  });
});

describe("deriveBadgeCount", () => {
  it("passes a positive count through", () => {
    expect(deriveBadgeCount(5)).toBe(5);
  });

  it("never goes negative", () => {
    expect(deriveBadgeCount(-1)).toBe(0);
  });
});
