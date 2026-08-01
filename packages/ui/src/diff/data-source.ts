/**
 * The Diff panel's data seam (spec §11), the same "fixture behind the real
 * interface" pattern every other panel already uses (`SessionDataSource`,
 * `GraphDataSource`). No workspace/diff server endpoint exists on `main` as
 * of this rebase — `GET /api/workstreams/:id/diff` is Track A's Batch 3
 * scope, not yet landed — so `createFixtureDiffDataSource` is the only
 * implementation today, ready to be joined by a live one the exact way
 * `createApiSessionDataSource` joined its fixture: same interface, same
 * `WorkspaceDiff` shape, the host swaps which constructor it calls.
 *
 * Swap point for Stage 2: once `GET /api/workstreams/:id/diff` exists,
 * `createApiDiffDataSource({ http, createSocket })` reads it the way
 * `createApiSessionDataSource` reads `/transcript` — refetch on the
 * relevant `/ws` event, since a workspace diff has no snapshot-level `seq`
 * of its own either.
 */

import type { Unsubscribe } from "../data-source/types.js";
import type { WorkspaceDiff } from "./types.js";

export interface DiffDataSource {
  load(workspaceId: string): Promise<WorkspaceDiff>;
  subscribe(
    workspaceId: string,
    onDiff: (diff: WorkspaceDiff) => void,
  ): Unsubscribe;
}

function emptyDiffFor(workspaceId: string): WorkspaceDiff {
  return { workspaceId, files: [] };
}

/** Stage 1/tests/dev-offline: fixtures behind the same interface a live source will implement. */
export function createFixtureDiffDataSource(
  diffs: ReadonlyMap<string, WorkspaceDiff>,
): DiffDataSource {
  return {
    load(workspaceId: string): Promise<WorkspaceDiff> {
      return Promise.resolve(
        diffs.get(workspaceId) ?? emptyDiffFor(workspaceId),
      );
    },

    subscribe(workspaceId, onDiff): Unsubscribe {
      // Fixtures never change; nothing to notify (mirrors
      // `createFixtureGraphDataSource`/`createFixtureSessionDataSource`).
      onDiff(diffs.get(workspaceId) ?? emptyDiffFor(workspaceId));
      return () => {};
    },
  };
}
