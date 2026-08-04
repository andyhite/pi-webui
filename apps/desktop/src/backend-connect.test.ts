import { describe, expect, it, vi } from "vitest";

import { checkRemoteBackendHealth } from "./backend-connect.js";
import type { FetchLike } from "./backend-connect.js";

describe("checkRemoteBackendHealth", () => {
  it("reports ok on a healthy response", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }));
    const result = await checkRemoteBackendHealth(
      { url: "https://plotroom.example.com", credential: "secret" },
      fetchImpl,
    );
    expect(result).toEqual({ ok: true });
  });

  it("sends the credential as a bearer header", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }));
    await checkRemoteBackendHealth(
      { url: "https://plotroom.example.com", credential: "secret" },
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://plotroom.example.com/api/health",
      { headers: { Authorization: "Bearer secret" } },
    );
  });

  it("sends no Authorization header when no credential is remembered", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }));
    await checkRemoteBackendHealth(
      { url: "https://plotroom.example.com", credential: null },
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://plotroom.example.com/api/health",
      { headers: {} },
    );
  });

  it("trims a trailing slash before appending /api/health", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }));
    await checkRemoteBackendHealth(
      { url: "https://plotroom.example.com/", credential: null },
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://plotroom.example.com/api/health",
      { headers: {} },
    );
  });

  it("names a 401 as a credential refusal, not a generic failure", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({
      ok: false,
      status: 401,
    }));
    const result = await checkRemoteBackendHealth(
      { url: "https://plotroom.example.com", credential: "wrong" },
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("credential");
  });

  it("reports a network failure without throwing", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await checkRemoteBackendHealth(
      { url: "https://plotroom.example.com", credential: null },
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("ECONNREFUSED");
  });
});
