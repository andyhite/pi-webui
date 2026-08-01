import { describe, expect, it } from "vitest";

import { buildDiffTree } from "./tree.js";
import type { DiffFile } from "./types.js";

function file(path: string): DiffFile {
  return { path, status: "modified" };
}

describe("buildDiffTree", () => {
  it("nests files under their directory segments", () => {
    const tree = buildDiffTree([file("src/a.ts"), file("src/nested/b.ts")]);
    expect(tree).toHaveLength(1);
    const src = tree[0];
    expect(src?.kind).toBe("dir");
    if (src?.kind !== "dir") throw new Error("expected a dir");
    expect(src.path).toBe("src");
    expect(src.children.map((c) => c.name)).toEqual(["nested", "a.ts"]);
  });

  it("sorts directories before files, both alphabetically", () => {
    const tree = buildDiffTree([
      file("z.ts"),
      file("a.ts"),
      file("dir-b/file.ts"),
      file("dir-a/file.ts"),
    ]);
    expect(tree.map((n) => n.name)).toEqual(["dir-a", "dir-b", "a.ts", "z.ts"]);
  });

  it("places a root-level file with no directory segments directly at the root", () => {
    const tree = buildDiffTree([file("README.md")]);
    expect(tree).toEqual([
      {
        kind: "file",
        name: "README.md",
        path: "README.md",
        file: file("README.md"),
      },
    ]);
  });

  it("is deterministic regardless of input order", () => {
    const a = buildDiffTree([file("b/x.ts"), file("a/y.ts"), file("c.ts")]);
    const b = buildDiffTree([file("c.ts"), file("a/y.ts"), file("b/x.ts")]);
    expect(a).toEqual(b);
  });

  it("carries the full DiffFile through onto the leaf node", () => {
    const deleted: DiffFile = { path: "old.ts", status: "deleted" };
    const tree = buildDiffTree([deleted]);
    expect(tree[0]).toEqual({
      kind: "file",
      name: "old.ts",
      path: "old.ts",
      file: deleted,
    });
  });

  it("returns an empty tree for no files", () => {
    expect(buildDiffTree([])).toEqual([]);
  });
});
