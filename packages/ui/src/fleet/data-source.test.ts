import { describe, expect, it, vi } from "vitest";

import type { HttpClient } from "../transport/http.js";
import {
  createApiFleetDataSource,
  createFixtureFleetDataSource,
} from "./data-source.js";

function fakeHttp(get: (path: string) => Promise<unknown>): HttpClient {
  return { get } as unknown as HttpClient;
}

describe("createApiFleetDataSource", () => {
  it("maps GET /api/fleet's real fields, one read, no fan-out", async () => {
    const get = vi.fn(async (path: string) => {
      expect(path).toBe("/api/fleet");
      return {
        today: { spentMicros: 4_250_000, spent: "$4.25", sessions: 2 },
        allTime: { spentMicros: 9_000_000, spent: "$9.00" },
        biggestSpender: {
          sessionId: "session-running",
          workstreamId: "workstream-oxy-2982",
          spentMicros: 3_100_000,
          spent: "$3.10",
        },
        concurrency: { running: 2, limit: 4, queued: 1 },
        budgets: [],
      };
    });
    const source = createApiFleetDataSource({ http: fakeHttp(get) });

    const summary = await source.load();

    expect(get).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({
      todayTotalMicros: 4_250_000,
      biggestSpender: {
        sessionId: "session-running",
        workstreamId: "workstream-oxy-2982",
        amountMicros: 3_100_000,
      },
      runningCount: 2,
      concurrencyLimit: 4,
      queuedCount: 1,
    });
  });

  it("reports no biggest spender when the fleet response says so, rather than guessing", async () => {
    const get = vi.fn(async () => ({
      today: { spentMicros: 0, spent: "$0.00", sessions: 0 },
      allTime: { spentMicros: 0, spent: "$0.00" },
      biggestSpender: null,
      concurrency: { running: 0, limit: 4, queued: 0 },
      budgets: [],
    }));
    const source = createApiFleetDataSource({ http: fakeHttp(get) });

    const summary = await source.load();

    expect(summary.biggestSpender).toBeNull();
  });

  it("reads the concurrency limit's real configured value off the response, never a fallback", async () => {
    const get = vi.fn(async () => ({
      today: { spentMicros: 0, spent: "$0.00", sessions: 0 },
      allTime: { spentMicros: 0, spent: "$0.00" },
      biggestSpender: null,
      concurrency: { running: 0, limit: 12, queued: 0 },
      budgets: [],
    }));
    const source = createApiFleetDataSource({ http: fakeHttp(get) });

    const summary = await source.load();

    expect(summary.concurrencyLimit).toBe(12);
  });
});

describe("createFixtureFleetDataSource", () => {
  it("returns exactly the summary it was given", async () => {
    const summary = {
      todayTotalMicros: 1,
      biggestSpender: null,
      runningCount: 0,
      concurrencyLimit: 4,
      queuedCount: 0,
    };
    const source = createFixtureFleetDataSource(summary);
    expect(await source.load()).toEqual(summary);
  });
});
