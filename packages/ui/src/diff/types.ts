/**
 * The Diff panel's data shape (spec §11: "a workspace's changes — file tree
 * and patches, read-only"). Matches Track A's real `GET /api/workstreams/
 * :id/diff` response (`apps/server/src/workspaces/diff.ts`) field for
 * field — the server owns the wire shape, this is the contract, never the
 * other way around (see that module's own doc comment).
 */

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffHunk {
  /** The hunk header, e.g. `@@ -1,4 +1,6 @@` — rendered as-is, read-only. */
  readonly header: string;
  readonly lines: readonly string[];
}

export interface DiffFile {
  readonly path: string;
  readonly status: DiffFileStatus;
  /** Set for a rename/copy; the path this file's content came from. */
  readonly previousPath?: string;
  /**
   * Either pre-split hunks or one patch-text blob — a producer that has not
   * split its patch into hunks yet can still supply one, and the panel
   * renders whichever it has rather than forcing every producer through
   * the same parser.
   */
  readonly hunks?: readonly DiffHunk[];
  readonly patchText?: string;
}

/**
 * Not-ready is an answer, never an empty success (§3.4): a workstream with
 * no workspace, a record with nothing checked out, and a checkout git
 * cannot read are three different facts, distinct from `ready`.
 */
export type WorkspaceDiffState =
  "ready" | "no-workspace" | "unprovisioned" | "unreadable";

export interface WorkspaceDiff {
  readonly workspaceId: string | null;
  readonly state: WorkspaceDiffState;
  /** Why, when `state` is not `ready`. Null when it is. */
  readonly reason: string | null;
  /** What the patches are relative to, and how that was decided. Null when `state` is not `ready`. */
  readonly base: {
    readonly ref: string;
    readonly resolved: string | null;
    readonly description: string;
  } | null;
  readonly files: readonly DiffFile[];
}
