/**
 * Builds a read-only file tree from a flat `WorkspaceDiff.files` list (spec
 * §11). Pure: splits each path on `/`, folds every file into nested
 * directory nodes, and sorts directories-before-files, then alphabetically,
 * at every level — deterministic regardless of the input array's order.
 */

import type { DiffFile } from "./types.js";

export interface DiffTreeFileNode {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
  readonly file: DiffFile;
}

export interface DiffTreeDirNode {
  readonly kind: "dir";
  readonly name: string;
  readonly path: string;
  readonly children: readonly DiffTreeNode[];
}

export type DiffTreeNode = DiffTreeFileNode | DiffTreeDirNode;

interface MutableDir {
  name: string;
  path: string;
  dirs: Map<string, MutableDir>;
  files: Map<string, DiffTreeFileNode>;
}

function newDir(name: string, path: string): MutableDir {
  return { name, path, dirs: new Map(), files: new Map() };
}

function finalize(dir: MutableDir): readonly DiffTreeNode[] {
  const dirNodes: DiffTreeDirNode[] = [...dir.dirs.values()]
    .map((child) => ({
      kind: "dir" as const,
      name: child.name,
      path: child.path,
      children: finalize(child),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const fileNodes = [...dir.files.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return [...dirNodes, ...fileNodes];
}

/** Builds the nested tree; directories sort before files, both alphabetical. */
export function buildDiffTree(
  files: readonly DiffFile[],
): readonly DiffTreeNode[] {
  const root = newDir("", "");

  for (const file of files) {
    const segments = file.path.split("/").filter((segment) => segment !== "");
    let cursor = root;
    let pathSoFar = "";
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      if (segment === undefined) continue;
      pathSoFar = pathSoFar === "" ? segment : `${pathSoFar}/${segment}`;
      let next = cursor.dirs.get(segment);
      if (!next) {
        next = newDir(segment, pathSoFar);
        cursor.dirs.set(segment, next);
      }
      cursor = next;
    }
    const fileName = segments.at(-1) ?? file.path;
    cursor.files.set(fileName, {
      kind: "file",
      name: fileName,
      path: file.path,
      file,
    });
  }

  return finalize(root);
}
