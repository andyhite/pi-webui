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
  it("counts only genuinely queued (not starting/running/needs_reask/paused) entries as queuedCount", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/sessions") return { sessions: [] };
      if (path === "/api/run-queue") {
        return {
          queued: [
            { state: "queued" },
            { state: "queued" },
            { state: "starting" },
            { state: "running" },
            { state: "needs_reask" },
            { state: "paused" },
          ],
        };
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const source = createApiFleetDataSource({
      http: fakeHttp(get),
      now: () => 0,
    });

    const summary = await source.load();

    expect(summary.queuedCount).toBe(2);
  });

  it("counts running sessions and reports the fallback concurrency limit", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/sessions") {
        return {
          sessions: [
            { session: { id: "s1" }, end: null },
            { session: { id: "s2" }, end: { kind: "completed", at: 0 } },
          ],
        };
      }
      if (path.startsWith("/api/sessions/")) return { entries: [] };
      if (path === "/api/run-queue") return { queued: [] };
      throw new Error(`unexpected path: ${path}`);
    });
    const source = createApiFleetDataSource({
      http: fakeHttp(get),
      now: () => 0,
    });

    const summary = await source.load();

    expect(summary.runningCount).toBe(1);
    expect(summary.concurrencyLimit).toBe(4);
  });

  it("takes an explicit concurrencyLimit over the fallback", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/sessions") return { sessions: [] };
      if (path === "/api/run-queue") return { queued: [] };
      throw new Error(`unexpected path: ${path}`);
    });
    const source = createApiFleetDataSource({
      http: fakeHttp(get),
      now: () => 0,
      concurrencyLimit: 8,
    });

    const summary = await source.load();

    expect(summary.concurrencyLimit).toBe(8);
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
