import { describe, expect, it, vi } from "vitest";

import { HttpError, createHttpClient } from "./http.js";
import type { FetchLike } from "./http.js";

function fakeFetch(
  handler: (
    path: string,
    init?: Parameters<FetchLike>[1],
  ) => {
    ok: boolean;
    status: number;
    body?: unknown;
  },
): FetchLike {
  return async (path, init) => {
    const result = handler(path, init);
    return {
      ok: result.ok,
      status: result.status,
      json: async () => result.body,
    };
  };
}

describe("createHttpClient", () => {
  it("issues a GET to a same-origin path and returns the parsed body", async () => {
    const fetchImpl = fakeFetch((path) => {
      expect(path).toBe("/api/graph");
      return { ok: true, status: 200, body: { nodes: [] } };
    });
    const client = createHttpClient(fetchImpl);
    await expect(client.get("/api/graph")).resolves.toEqual({ nodes: [] });
  });

  it("sends a JSON body and content-type header on POST", async () => {
    const spy = vi.fn(() => ({ ok: true, status: 200, body: { id: "1" } }));
    const client = createHttpClient(fakeFetch(spy));
    await client.post("/api/notes", { text: "hi" });
    expect(spy).toHaveBeenCalledWith(
      "/api/notes",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "hi" }),
        headers: { "content-type": "application/json" },
      }),
    );
  });

  it("sends PATCH with a body, matching the server's patch routes", async () => {
    const spy = vi.fn(() => ({ ok: true, status: 200, body: {} }));
    const client = createHttpClient(fakeFetch(spy));
    await client.patch("/api/workstreams/w1", { status: "done" });
    expect(spy).toHaveBeenCalledWith(
      "/api/workstreams/w1",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("throws HttpError with the status on a non-ok response", async () => {
    const client = createHttpClient(
      fakeFetch(() => ({ ok: false, status: 404 })),
    );
    await expect(client.get("/api/missing")).rejects.toThrow(HttpError);
    await expect(client.get("/api/missing")).rejects.toMatchObject({
      status: 404,
      path: "/api/missing",
    });
  });

  it("parses the server's ApiErrorBody shape onto code/reason/message", async () => {
    const client = createHttpClient(
      fakeFetch(() => ({
        ok: false,
        status: 409,
        body: {
          error: {
            code: "refused",
            message: "that session has ended; fork or re-run it instead",
            details: { reason: "session_not_running" },
          },
        },
      })),
    );

    await expect(client.post("/api/edges", {})).rejects.toMatchObject({
      status: 409,
      code: "refused",
      reason: "session_not_running",
      message: "that session has ended; fork or re-run it instead",
      isRefusal: true,
    });
  });

  it("degrades gracefully when the error body isn't the ApiErrorBody shape", async () => {
    const client = createHttpClient(
      fakeFetch(() => ({ ok: false, status: 500, body: "not json shaped" })),
    );
    const error = await client.get("/api/x").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBeNull();
    expect((error as HttpError).reason).toBeNull();
    expect((error as HttpError).isRefusal).toBe(false);
  });

  it("returns undefined for a 204 No Content response", async () => {
    const client = createHttpClient(
      fakeFetch(() => ({ ok: true, status: 204 })),
    );
    await expect(client.delete("/api/notes/1")).resolves.toBeUndefined();
  });

  it("refuses an absolute URL rather than making a cross-origin request", async () => {
    const client = createHttpClient(
      fakeFetch(() => ({ ok: true, status: 200, body: {} })),
    );
    await expect(client.get("http://evil.example/api")).rejects.toThrow(
      /same-origin/,
    );
    await expect(client.get("//evil.example/api")).rejects.toThrow(
      /same-origin/,
    );
  });

  it("sets fetch's own keepalive when a caller opts in", async () => {
    const spy = vi.fn(() => ({ ok: true, status: 200, body: {} }));
    const client = createHttpClient(fakeFetch(spy));
    await client.patch(
      "/api/arrangement",
      { positions: [] },
      { keepalive: true },
    );
    expect(spy).toHaveBeenCalledWith(
      "/api/arrangement",
      expect.objectContaining({ method: "PATCH", keepalive: true }),
    );
  });

  it("never sets keepalive when a caller does not opt in — absent, not false", async () => {
    let capturedInit: Parameters<FetchLike>[1];
    const client = createHttpClient(
      fakeFetch((_path, init) => {
        capturedInit = init;
        return { ok: true, status: 200, body: {} };
      }),
    );
    await client.patch("/api/arrangement", { positions: [] });
    expect(capturedInit && "keepalive" in capturedInit).toBe(false);
  });

  it("plumbs keepalive through get/post/put/delete too, not only patch", async () => {
    const captured: Parameters<FetchLike>[1][] = [];
    const client = createHttpClient(
      fakeFetch((_path, init) => {
        captured.push(init);
        return { ok: true, status: 200, body: {} };
      }),
    );

    await client.get("/api/graph", { keepalive: true });
    await client.post("/api/notes", { text: "hi" }, { keepalive: true });
    await client.put("/api/notes/1", { text: "hi" }, { keepalive: true });
    await client.delete("/api/notes/1", { keepalive: true });

    expect(captured).toHaveLength(4);
    for (const init of captured) {
      expect(init?.keepalive).toBe(true);
    }
  });
});
