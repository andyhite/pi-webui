import { describe, expect, it, vi } from "vitest";

import type { HttpClient } from "../transport/http.js";
import {
  createApiSettingsDataSource,
  createFixtureSettingsDataSource,
} from "./data-source.js";
import type { SettingRow } from "./types.js";

function fakeHttp(overrides: Record<string, unknown>): HttpClient {
  return {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    ...overrides,
  } as unknown as HttpClient;
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

const CONCURRENCY_ROW: SettingRow = {
  key: "concurrencyLimit",
  group: "Runs",
  label: "Concurrency limit",
  description: "How many sessions may run at once.",
  type: "number",
  envVar: "PLOTROOM_CONCURRENCY_LIMIT",
  sensitive: false,
  appliesWithoutRestart: true,
  value: 4,
  defaultValue: 4,
  overridden: false,
};

describe("createApiSettingsDataSource", () => {
  it("lists without a query when none is given, and with one when it is", async () => {
    const get = vi.fn(async (path: string) => {
      expect(["/api/settings", "/api/settings?q=concurrency"]).toContain(path);
      return { settings: [CONCURRENCY_ROW] };
    });
    const source = createApiSettingsDataSource({
      http: fakeHttp({ get }),
      createSocket: noopSocket,
    });

    await source.list();
    await source.list("concurrency");

    expect(get).toHaveBeenNthCalledWith(1, "/api/settings");
    expect(get).toHaveBeenNthCalledWith(2, "/api/settings?q=concurrency");
  });

  it("reads one setting by key", async () => {
    const get = vi.fn(async (path: string) => {
      expect(path).toBe("/api/settings/concurrencyLimit");
      return { setting: CONCURRENCY_ROW };
    });
    const source = createApiSettingsDataSource({
      http: fakeHttp({ get }),
      createSocket: noopSocket,
    });

    expect(await source.get("concurrencyLimit")).toEqual(CONCURRENCY_ROW);
  });

  it("writes through PUT with the value in the body, keyed in the path", async () => {
    const put = vi.fn(async (path: string, body: unknown) => {
      expect(path).toBe("/api/settings/concurrencyLimit");
      expect(body).toEqual({ value: 8 });
      return { setting: { ...CONCURRENCY_ROW, value: 8, overridden: true } };
    });
    const source = createApiSettingsDataSource({
      http: fakeHttp({ put }),
      createSocket: noopSocket,
    });

    const updated = await source.set("concurrencyLimit", 8);
    expect(updated.value).toBe(8);
    expect(updated.overridden).toBe(true);
  });

  it("reverts through DELETE — a distinct verb from writing an empty value", async () => {
    const del = vi.fn(async (path: string) => {
      expect(path).toBe("/api/settings/concurrencyLimit");
      return { setting: CONCURRENCY_ROW };
    });
    const source = createApiSettingsDataSource({
      http: fakeHttp({ delete: del }),
      createSocket: noopSocket,
    });

    const reverted = await source.remove("concurrencyLimit");
    expect(reverted.overridden).toBe(false);
  });
});

describe("createFixtureSettingsDataSource", () => {
  it("set() marks the row overridden; remove() reverts to the default value", async () => {
    const source = createFixtureSettingsDataSource([CONCURRENCY_ROW]);

    const written = await source.set("concurrencyLimit", 12);
    expect(written.value).toBe(12);
    expect(written.overridden).toBe(true);

    const reverted = await source.remove("concurrencyLimit");
    expect(reverted.value).toBe(CONCURRENCY_ROW.defaultValue);
    expect(reverted.overridden).toBe(false);
  });

  it("list(q) filters by label, description, group, or key", async () => {
    const source = createFixtureSettingsDataSource([CONCURRENCY_ROW]);
    expect(await source.list("Runs")).toHaveLength(1);
    expect(await source.list("nothing matches this")).toHaveLength(0);
  });
});
