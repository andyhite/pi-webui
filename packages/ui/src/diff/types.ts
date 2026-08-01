/**
 * The Diff panel's data shape (spec §11: "a workspace's changes — file tree
 * and patches, read-only"). No server API exists yet for this — Epic 7.3
 * ports the coding/git plugin's diff mechanics later, and Track A's
 * workspace/session server surface is still in flight — so this is defined
 * here, minimal on purpose, as the shape the panel renders against until a
 * real one arrives. Keep it small: a status per file and patch text (or
 * pre-split hunks) is everything the read-only tree + patch view needs.
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

export interface WorkspaceDiff {
  readonly workspaceId: string;
  readonly files: readonly DiffFile[];
}
