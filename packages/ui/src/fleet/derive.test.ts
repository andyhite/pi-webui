import { describe, expect, it } from "vitest";

import { deriveFleetSummary, startOfUtcDay } from "./derive.js";

describe("startOfUtcDay", () => {
  it("floors to midnight UTC", () => {
    const oneDay = 24 * 60 * 60;
    expect(startOfUtcDay(oneDay + 3_661)).toBe(oneDay);
    expect(startOfUtcDay(oneDay - 1)).toBe(0);
  });
});

describe("deriveFleetSummary", () => {
  const oneDay = 24 * 60 * 60;

  it("sums only today's entries into todayTotalMicros", () => {
    const summary = deriveFleetSummary({
      sessions: [{ sessionId: "s1", running: true }],
      spend: [
        {
          sessionId: "s1",
          entries: [
            { amountMicros: 1_000, at: 0 }, // yesterday
            { amountMicros: 2_000, at: oneDay + 10 }, // today
          ],
        },
      ],
      nowSeconds: oneDay + 100,
      concurrencyLimit: 4,
      queuedCount: 0,
    });
    expect(summary.todayTotalMicros).toBe(2_000);
  });

  it("finds the biggest spender by all-time total, across sessions", () => {
    const summary = deriveFleetSummary({
      sessions: [
        { sessionId: "small", running: false },
        { sessionId: "big", running: false },
      ],
      spend: [
        { sessionId: "small", entries: [{ amountMicros: 500, at: 0 }] },
        { sessionId: "big", entries: [{ amountMicros: 5_000, at: 0 }] },
      ],
      nowSeconds: 0,
      concurrencyLimit: 4,
      queuedCount: 0,
    });
    expect(summary.biggestSpender).toEqual({
      sessionId: "big",
      amountMicros: 5_000,
    });
  });

  it("reports no biggest spender when nobody has spent anything", () => {
    const summary = deriveFleetSummary({
      sessions: [{ sessionId: "s1", running: true }],
      spend: [{ sessionId: "s1", entries: [] }],
      nowSeconds: 0,
      concurrencyLimit: 4,
      queuedCount: 0,
    });
    expect(summary.biggestSpender).toBeNull();
  });

  it("counts only running sessions, against the given concurrency limit", () => {
    const summary = deriveFleetSummary({
      sessions: [
        { sessionId: "a", running: true },
        { sessionId: "b", running: true },
        { sessionId: "c", running: false },
      ],
      spend: [],
      nowSeconds: 0,
      concurrencyLimit: 4,
      queuedCount: 2,
    });
    expect(summary.runningCount).toBe(2);
    expect(summary.concurrencyLimit).toBe(4);
    expect(summary.queuedCount).toBe(2);
  });
});
