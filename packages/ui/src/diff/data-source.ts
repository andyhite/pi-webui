/**
 * The Diff panel's data seam (spec §11), the same "fixture behind the real
 * interface" pattern every other panel already uses (`SessionDataSource`,
 * `GraphDataSource`). `createApiDiffDataSource` is the live implementation,
 * Stage 2, over Track A's `GET /api/workstreams/:id/diff` (now merged to
 * main) — addressed by **workstream** id, not workspace id (a workstream
 * has at most one workspace; the response's own `workspaceId` field can be
 * null when none has been provisioned yet). `createFixtureDiffDataSource`
 * stays for tests and dev-offline, behind the identical interface.
 */

import type { HttpClient } from "../transport/http.js";
import type { Unsubscribe } from "../data-source/types.js";
import type { WorkspaceDiff } from "./types.js";

export interface DiffDataSource {
  load(workstreamId: string): Promise<WorkspaceDiff>;
  subscribe(
    workstreamId: string,
    onDiff: (diff: WorkspaceDiff) => void,
  ): Unsubscribe;
}

function emptyDiffFor(workstreamId: string): WorkspaceDiff {
  return {
    workspaceId: null,
    state: "no-workspace",
    reason: `no diff loaded yet for workstream ${workstreamId}`,
    base: null,
    files: [],
  };
}

/** Stage 1/tests/dev-offline: fixtures behind the same interface a live source will implement. */
export function createFixtureDiffDataSource(
  diffs: ReadonlyMap<string, WorkspaceDiff>,
): DiffDataSource {
  return {
    load(workstreamId: string): Promise<WorkspaceDiff> {
      return Promise.resolve(
        diffs.get(workstreamId) ?? emptyDiffFor(workstreamId),
      );
    },

    subscribe(workstreamId, onDiff): Unsubscribe {
      // Fixtures never change; nothing to notify (mirrors
      // `createFixtureGraphDataSource`/`createFixtureSessionDataSource`).
      onDiff(diffs.get(workstreamId) ?? emptyDiffFor(workstreamId));
      return () => {};
    },
  };
}

/* ------------------------------------------------------------- live (Stage 2) */

export interface ApiDiffDataSourceOptions {
  readonly http: HttpClient;
}

/**
 * Live over `GET /api/workstreams/:id/diff`. There is no `/ws` event for
 * "this workspace's diff changed" (a diff is a git read, not a domain
 * mutation this product tracks), so this is a one-shot load per
 * subscription rather than the refetch-on-event recipe `subscribeTranscript`
 * uses — a caller that wants it current calls `load` again (e.g. after a
 * run finishes).
 */
export function createApiDiffDataSource(
  options: ApiDiffDataSourceOptions,
): DiffDataSource {
  const { http } = options;

  function load(workstreamId: string): Promise<WorkspaceDiff> {
    return http.get<WorkspaceDiff>(
      `/api/workstreams/${encodeURIComponent(workstreamId)}/diff`,
    );
  }

  return {
    load,

    subscribe(workstreamId, onDiff): Unsubscribe {
      let cancelled = false;
      void load(workstreamId).then((diff) => {
        if (!cancelled) onDiff(diff);
      });
      return () => {
        cancelled = true;
      };
    },
  };
}
