import { describe, expect, it, vi } from "vitest";

import type { HttpClient } from "../transport/http.js";
import {
  createApiSearchDataSource,
  createFixtureSearchDataSource,
} from "./data-source.js";

function fakeHttp(get: (path: string) => Promise<unknown>): HttpClient {
  return { get } as unknown as HttpClient;
}

describe("createApiSearchDataSource", () => {
  it("resolves no hits without a request when the query is empty (§6.8: nothing to rank)", async () => {
    const get = vi.fn();
    const source = createApiSearchDataSource({ http: fakeHttp(get) });

    const result = await source.search({ q: "   " });

    expect(get).not.toHaveBeenCalled();
    // Nothing was asked for, so nothing was withheld — and no bound was
    // applied to invent a number for.
    expect(result).toEqual({ query: "", hits: [], limit: 0, truncated: false });
  });

  it("quotes the query as an FTS5 phrase (never a bare MATCH grammar term) and returns the response untouched, in the server's own order", async () => {
    const get = vi.fn(async (path: string) => {
      expect(path).toBe("/api/search?q=%22migrate%22");
      return {
        query: "migrate",
        hits: [
          {
            kind: "session",
            refKind: "session",
            refId: "sess_1",
            title: "session sess_1",
            location: "workstream-oxy-2982",
            snippet: "...migrate the schema...",
            rank: 0.9,
            archived: false,
          },
        ],
      };
    });
    const source = createApiSearchDataSource({ http: fakeHttp(get) });

    const result = await source.search({ q: "migrate" });

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.archived).toBe(false);
  });

  // What this defends is that the client does not **reshape** the completeness
  // report: it maps `query` by hand, so an edit that mapped the rest of the
  // response field by field is one keystroke from dropping these two. It is
  // what it is — the current client spreads the whole response, so it would
  // stay green at runtime if the type change were reverted, and would fail only
  // under `tsc`. The empty-query case above is the one that fails either way.
  it("keeps the server's own completeness report intact — the panel cannot infer it", async () => {
    const hit = {
      kind: "session",
      refKind: "session",
      refId: "sess_1",
      title: "session sess_1",
      location: "workstream-oxy-2982",
      snippet: "...",
      rank: 0.9,
      archived: false,
    };
    const get = vi.fn(async () => ({
      query: "migrate",
      // One hit at a limit of one: `hits.length === limit` says nothing about
      // whether more matched, which is exactly why `truncated` is reported.
      limit: 1,
      truncated: true,
      hits: [hit],
    }));
    const source = createApiSearchDataSource({ http: fakeHttp(get) });

    const result = await source.search({ q: "migrate" });

    expect(result.truncated).toBe(true);
    expect(result.limit).toBe(1);

    const complete = createApiSearchDataSource({
      http: fakeHttp(async () => ({
        query: "migrate",
        limit: 25,
        truncated: false,
        hits: [hit],
      })),
    });
    expect(await complete.search({ q: "migrate" })).toMatchObject({
      limit: 25,
      truncated: false,
    });
  });

  it("quotes a hyphenated word instead of letting FTS5 read it as NOT — the crash a raw ticket id or branch name used to cause", async () => {
    const get = vi.fn(async (path: string) => {
      expect(path).toBe("/api/search?q=%22OXY-2982%22");
      return { query: "OXY-2982", hits: [] };
    });
    const source = createApiSearchDataSource({ http: fakeHttp(get) });

    await source.search({ q: "OXY-2982" });

    expect(get).toHaveBeenCalledTimes(1);
  });

  it("quotes each word of a multi-word query separately, so terms still AND together rather than becoming one exact phrase", async () => {
    const get = vi.fn(async (path: string) => {
      expect(path).toBe("/api/search?q=%22flaky%22+%22login%22");
      return { query: "flaky login", hits: [] };
    });
    const source = createApiSearchDataSource({ http: fakeHttp(get) });

    await source.search({ q: "flaky login" });

    expect(get).toHaveBeenCalledTimes(1);
  });

  it("carries kinds and limit as query parameters, never into the path", async () => {
    const get = vi.fn(async (path: string) => {
      expect(path).toBe("/api/search?q=%22x%22&kinds=session%2Cnote&limit=10");
      return { query: "x", hits: [] };
    });
    const source = createApiSearchDataSource({ http: fakeHttp(get) });

    await source.search({ q: "x", kinds: ["session", "note"], limit: 10 });

    expect(get).toHaveBeenCalledTimes(1);
  });

  it("never hides an archived hit \u2014 it stays a row, flagged honestly", async () => {
    const get = vi.fn(async () => ({
      query: "x",
      hits: [
        {
          kind: "session",
          refKind: "session",
          refId: "sess_archived",
          title: "an old session",
          location: "workstream-gone",
          snippet: "...",
          rank: 0.1,
          archived: true,
        },
      ],
    }));
    const source = createApiSearchDataSource({ http: fakeHttp(get) });

    const result = await source.search({ q: "x" });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.archived).toBe(true);
  });
});

describe("createFixtureSearchDataSource", () => {
  it("returns exactly the result registered for that query", async () => {
    const registered = {
      query: "migrate",
      hits: [],
      limit: 25,
      truncated: true,
    };
    const source = createFixtureSearchDataSource(
      new Map([["migrate", registered]]),
    );
    expect(await source.search({ q: "migrate" })).toEqual(registered);
  });

  it("returns no hits for an unregistered query rather than throwing", async () => {
    const source = createFixtureSearchDataSource(new Map());
    expect(await source.search({ q: "anything" })).toEqual({
      query: "anything",
      hits: [],
      limit: 0,
      truncated: false,
    });
  });
});
