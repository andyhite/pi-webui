import { describe, expect, it, vi } from "vitest";

import type { HttpClient } from "../transport/http.js";
import {
  createApiLogsDataSource,
  createFixtureLogsDataSource,
} from "./data-source.js";
import type { LogsResult } from "./types.js";

function fakeHttp(overrides: Record<string, unknown>): HttpClient {
  return { get: vi.fn(), ...overrides } as unknown as HttpClient;
}

function noopSocket() {
  return {
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send: vi.fn(),
    close: vi.fn(),
  };
}

const EMPTY_RESULT: LogsResult = {
  entries: [],
  droppedTotal: 0,
  capacity: 5_000,
  oldestSeq: null,
  newestSeq: null,
};

describe("createApiLogsDataSource", () => {
  it("queries /api/logs with no params when none are given", async () => {
    const get = vi.fn(async (path: string) => {
      expect(path).toBe("/api/logs");
      return EMPTY_RESULT;
    });
    const source = createApiLogsDataSource({
      http: fakeHttp({ get }),
      createSocket: noopSocket,
    });

    await source.query({});
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("carries level, component, sinceSeq, and limit as query parameters", async () => {
    const get = vi.fn(async (path: string) => {
      expect(path).toBe(
        "/api/logs?level=warn&component=http&sinceSeq=42&limit=100",
      );
      return EMPTY_RESULT;
    });
    const source = createApiLogsDataSource({
      http: fakeHttp({ get }),
      createSocket: noopSocket,
    });

    await source.query({
      level: "warn",
      component: "http",
      sinceSeq: 42,
      limit: 100,
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("reports droppedTotal, capacity, oldestSeq, and newestSeq honestly, untouched", async () => {
    const result: LogsResult = {
      entries: [
        { seq: 1, time: "2024-01-01T00:00:00.000Z", level: "info", msg: "hi" },
      ],
      droppedTotal: 3,
      capacity: 5_000,
      oldestSeq: 1,
      newestSeq: 1,
    };
    const get = vi.fn(async () => result);
    const source = createApiLogsDataSource({
      http: fakeHttp({ get }),
      createSocket: noopSocket,
    });

    expect(await source.query({})).toEqual(result);
  });
});

describe("createFixtureLogsDataSource", () => {
  it("returns exactly the result it was given", async () => {
    const source = createFixtureLogsDataSource(EMPTY_RESULT);
    expect(await source.query({})).toEqual(EMPTY_RESULT);
  });
});
