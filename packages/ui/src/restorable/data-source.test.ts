import { describe, expect, it, vi } from "vitest";

import type { HttpClient } from "../transport/http.js";
import {
  createApiRestorableDataSource,
  createFixtureRestorableDataSource,
  EMPTY_RESTORABLE_SUMMARY,
} from "./data-source.js";
import type { RestorableSummary } from "./types.js";

function fakeHttp(get: (path: string) => Promise<unknown>): HttpClient {
  return { get } as unknown as HttpClient;
}

const SUMMARY: RestorableSummary = {
  objects: [{ id: "obj-1", title: "a ticket", deletedAt: 10 }],
  nodes: [
    { id: "node-1", role: "content", refId: "obj-1", workstreamId: null },
  ],
  edges: [{ id: "edge-1", kind: "context", from: "node-1", to: "node-2" }],
  workstreams: [{ id: "ws-1", subjectId: "obj-1", status: "active" }],
  commands: [{ id: "cmd-1", definitionId: "def-1", workstreamId: "ws-1" }],
  commandDefinitions: [{ id: "def-1", name: "Implement" }],
  sessions: [{ id: "sess-1", workstreamId: "ws-1", deletedAt: 20, end: null }],
};

describe("createApiRestorableDataSource", () => {
  it("reads GET /api/restorable and returns the response untouched", async () => {
    const get = vi.fn(async () => SUMMARY);
    const source = createApiRestorableDataSource({ http: fakeHttp(get) });

    const result = await source.load();

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/restorable");
    expect(result).toBe(SUMMARY);
  });
});

describe("createFixtureRestorableDataSource", () => {
  it("resolves the registered summary without a request", async () => {
    const source = createFixtureRestorableDataSource(SUMMARY);

    await expect(source.load()).resolves.toBe(SUMMARY);
  });

  it("defaults to the empty summary constant when nothing is deleted", async () => {
    const source = createFixtureRestorableDataSource(EMPTY_RESTORABLE_SUMMARY);

    await expect(source.load()).resolves.toEqual({
      objects: [],
      nodes: [],
      edges: [],
      workstreams: [],
      commands: [],
      commandDefinitions: [],
      sessions: [],
    });
  });
});
