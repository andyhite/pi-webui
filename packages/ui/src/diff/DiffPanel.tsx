/**
 * The Diff panel (spec §11): a workspace's changes as a read-only file tree
 * plus per-file patches. Fixture-fed until a real workspace/diff server API
 * exists (see the seam report); `WorkspaceDiff` is this track's minimal
 * shape (`diff/types.ts`) for what a server will eventually supply.
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 * `<details>`/`<summary>` supplies the tree's expand/collapse mechanics.
 */

import { useMemo } from "react";

import { buildDiffTree } from "./tree.js";
import type { DiffTreeNode } from "./tree.js";
import type { DiffFile, WorkspaceDiff } from "./types.js";

export interface DiffPanelProps {
  readonly diff: WorkspaceDiff;
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

export function DiffPanel({ diff }: DiffPanelProps) {
  const tree = useMemo(() => buildDiffTree(diff.files), [diff.files]);

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
