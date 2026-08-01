/**
 * The Diff panel (spec §11): a workspace's changes as a read-only file tree
 * plus per-file patches. Fed through the `DiffDataSource` seam
 * (`data-source.ts`) rather than a fixture handed to this component
 * directly — the same pattern `ConversationPanel` takes `sessionId` +
 * `SessionDataSource` instead of a snapshot, so a live source is a pure
 * swap at the host, nothing here changes. Addressed by **workstream** id
 * (a workstream has at most one workspace); not-ready is rendered as its
 * own honest state (§3.4), never as "no changes".
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 * `<details>`/`<summary>` supplies the tree's expand/collapse mechanics.
 */

import { useEffect, useMemo, useState } from "react";

import type { DiffDataSource } from "./data-source.js";
import { buildDiffTree } from "./tree.js";
import type { DiffTreeNode } from "./tree.js";
import type { DiffFile, WorkspaceDiff } from "./types.js";

export interface DiffPanelProps {
  readonly workstreamId: string;
  readonly dataSource: DiffDataSource;
}

function FileNodeView({ file }: { readonly file: DiffFile }) {
  return (
    <li>
      <div>
        {file.path} — {file.status}
        {file.previousPath ? ` (from ${file.previousPath})` : ""}
      </div>
      {file.hunks ? (
        <ul>
          {file.hunks.map((hunk, index) => (
            <li key={index}>
              <div>{hunk.header}</div>
              <pre>{hunk.lines.join("\n")}</pre>
            </li>
          ))}
        </ul>
      ) : null}
      {file.patchText ? <pre>{file.patchText}</pre> : null}
    </li>
  );
}

function TreeNodeView({ node }: { readonly node: DiffTreeNode }) {
  if (node.kind === "file") {
    return <FileNodeView file={node.file} />;
  }
  return (
    <li>
      <details open>
        <summary>{node.name}/</summary>
        <ul>
          {node.children.map((child) => (
            <TreeNodeView key={child.path} node={child} />
          ))}
        </ul>
      </details>
    </li>
  );
}

export function DiffPanel({ workstreamId, dataSource }: DiffPanelProps) {
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    const unsubscribe = dataSource.subscribe(workstreamId, (next) => {
      if (!cancelled) setDiff(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [workstreamId, dataSource]);

  const tree = useMemo(() => buildDiffTree(diff?.files ?? []), [diff]);

  if (diff === null) {
    return <div role="status">loading workstream {workstreamId} diff…</div>;
  }

  // Not-ready is a fact reported, never an empty "no changes" success (§3.4,
  // principle 12) — a workstream with no workspace, an unprovisioned
  // record, and a checkout git could not read are three different reasons.
  if (diff.state !== "ready") {
    return (
      <div data-testid="diff-not-ready" data-diff-state={diff.state}>
        {diff.reason ?? `diff not ready: ${diff.state}`}
      </div>
    );
  }

  if (diff.files.length === 0) {
    return <div>no changes in this workspace</div>;
  }

  return (
    <div>
      <div>{diff.files.length} file(s) changed</div>
      {diff.base ? <div>against: {diff.base.description}</div> : null}
      <ul>
        {tree.map((node) => (
          <TreeNodeView key={node.path} node={node} />
        ))}
      </ul>
    </div>
  );
}
