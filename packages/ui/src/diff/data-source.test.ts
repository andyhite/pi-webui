import { describe, expect, it, vi } from "vitest";

import type { HttpClient } from "../transport/http.js";
import {
  createApiDiffDataSource,
  createFixtureDiffDataSource,
} from "./data-source.js";
import type { WorkspaceDiff } from "./types.js";

const READY_DIFF: WorkspaceDiff = {
  workspaceId: "ws1",
  state: "ready",
  reason: null,
  base: { ref: "main", resolved: "abc123", description: "since main" },
  files: [],
};

describe("createFixtureDiffDataSource", () => {
  it("loads the diff seeded for a workstream id", async () => {
    const source = createFixtureDiffDataSource(
      new Map([["workstream-1", READY_DIFF]]),
    );
    expect(await source.load("workstream-1")).toEqual(READY_DIFF);
  });

  it("an unknown workstream id reports no-workspace rather than throwing", async () => {
    const source = createFixtureDiffDataSource(new Map());
    const diff = await source.load("workstream-missing");
    expect(diff.state).toBe("no-workspace");
    expect(diff.workspaceId).toBeNull();
  });

  it("subscribe notifies once immediately; fixtures never change", async () => {
    const source = createFixtureDiffDataSource(
      new Map([["workstream-1", READY_DIFF]]),
    );
    const onDiff = vi.fn();
    source.subscribe("workstream-1", onDiff);
    expect(onDiff).toHaveBeenCalledTimes(1);
    expect(onDiff).toHaveBeenCalledWith(READY_DIFF);
  });
});

describe("createApiDiffDataSource", () => {
  it("load reads GET /api/workstreams/:id/diff", async () => {
    const get = vi.fn(async (path: string) => {
      expect(path).toBe("/api/workstreams/ws%2F1/diff");
      return READY_DIFF;
    });
    const http = { get } as unknown as HttpClient;
    const source = createApiDiffDataSource({ http });

    expect(await source.load("ws/1")).toEqual(READY_DIFF);
  });

  it("subscribe loads once and reports the result", async () => {
    const get = vi.fn(async () => READY_DIFF);
    const http = { get } as unknown as HttpClient;
    const source = createApiDiffDataSource({ http });

    const onDiff = vi.fn();
    source.subscribe("ws1", onDiff);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onDiff).toHaveBeenCalledWith(READY_DIFF);
  });

  it("a not-ready state passes through as its own honest answer, not an empty success", async () => {
    const unprovisioned: WorkspaceDiff = {
      workspaceId: "ws1",
      state: "unprovisioned",
      reason: "nothing checked out yet",
      base: null,
      files: [],
    };
    const get = vi.fn(async () => unprovisioned);
    const http = { get } as unknown as HttpClient;
    const source = createApiDiffDataSource({ http });

    expect(await source.load("ws1")).toEqual(unprovisioned);
  });
});
