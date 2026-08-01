/**
 * The Diff panel (spec §11): a workspace's changes as a read-only file tree
 * plus per-file patches. Fed through the `DiffDataSource` seam
 * (`data-source.ts`) rather than a fixture handed to this component
 * directly — the same pattern `ConversationPanel` takes `sessionId` +
 * `SessionDataSource` instead of a snapshot, so a live source is a pure
 * swap at the host, nothing here changes. No workspace/diff server API
 * exists yet (see the seam's own doc comment for the exact swap point);
 * `createFixtureDiffDataSource` is what every host wires today.
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
  readonly workspaceId: string;
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

export function DiffPanel({ workspaceId, dataSource }: DiffPanelProps) {
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    const unsubscribe = dataSource.subscribe(workspaceId, (next) => {
      if (!cancelled) setDiff(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [workspaceId, dataSource]);

  const tree = useMemo(() => buildDiffTree(diff?.files ?? []), [diff]);

  if (diff === null) {
    return <div role="status">loading workspace {workspaceId} diff…</div>;
  }

  if (diff.files.length === 0) {
    return <div>no changes in this workspace</div>;
  }

  return (
    <div>
      <div>{diff.files.length} file(s) changed</div>
      <ul>
        {tree.map((node) => (
          <TreeNodeView key={node.path} node={node} />
        ))}
      </ul>
    </div>
  );
}
