import { describe, expect, it } from "vitest";

import { deriveDivergence, checkContinuation } from "../divergence.js";
import { GIT_WORKSPACE_KIND } from "../kind.js";
import {
  parsePorcelainV2,
  unitFingerprintFrom,
  unitStatusFrom,
} from "./status.js";

const HEAD = "1".repeat(40);

function porcelain(lines: readonly string[]): string {
  return `${lines.join("\0")}\0`;
}

const cleanBranch = porcelain([
  `# branch.oid ${HEAD}`,
  "# branch.head feat/git-workspaces",
  "# branch.upstream origin/feat/git-workspaces",
  "# branch.ab +2 -3",
]);

describe("parsePorcelainV2", () => {
  it("reads branch, head, upstream, and ahead/behind (§3.4 live status)", () => {
    const read = parsePorcelainV2(cleanBranch);

    expect(read).toMatchObject({
      branch: "feat/git-workspaces",
      head: HEAD,
      detached: false,
      upstream: "origin/feat/git-workspaces",
      ahead: 2,
      behind: 3,
    });
  });

  it("reports a detached checkout as detached rather than as a branch", () => {
    const read = parsePorcelainV2(
      porcelain([`# branch.oid ${HEAD}`, "# branch.head (detached)"]),
    );

    expect(read.detached).toBe(true);
    expect(read.branch).toBeNull();
  });

  it("reports an unborn branch with no head", () => {
    const read = parsePorcelainV2(
      porcelain(["# branch.oid (initial)", "# branch.head main"]),
    );

    expect(read.head).toBeNull();
  });

  it("reads changed, untracked, renamed, and unmerged paths", () => {
    const read = parsePorcelainV2(
      porcelain([
        `# branch.oid ${HEAD}`,
        "# branch.head main",
        "1 .M N... 100644 100644 100644 aaa bbb src/auth.ts",
        "2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts",
        "src/old.ts",
        "u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts",
        "? notes.md",
        "! dist/bundle.js",
      ]),
    );

    expect(read.entries).toEqual([
      { code: ".M", path: "src/auth.ts", origPath: null, kind: "tracked" },
      {
        code: "R.",
        path: "src/new.ts",
        origPath: "src/old.ts",
        kind: "tracked",
      },
      { code: "UU", path: "src/conflict.ts", origPath: null, kind: "unmerged" },
      { code: "?", path: "notes.md", origPath: null, kind: "untracked" },
      { code: "!", path: "dist/bundle.js", origPath: null, kind: "ignored" },
    ]);
  });

  it("keeps every changed path — status is never truncated (principle 12)", () => {
    const many = Array.from(
      { length: 500 },
      (_unused, index) =>
        `1 .M N... 100644 100644 100644 aaa bbb src/file-${index}.ts`,
    );
    const read = parsePorcelainV2(
      porcelain([`# branch.oid ${HEAD}`, "# branch.head main", ...many]),
    );

    expect(read.entries).toHaveLength(500);
  });
});

describe("unitStatusFrom", () => {
  it("splits uncommitted from untracked and keeps the paths", () => {
    const read = parsePorcelainV2(
      porcelain([
        `# branch.oid ${HEAD}`,
        "# branch.head main",
        "1 .M N... 100644 100644 100644 aaa bbb src/auth.ts",
        "? notes.md",
      ]),
    );

    expect(unitStatusFrom("root", "/work/app", read)).toMatchObject({
      rootKey: "root",
      path: "/work/app",
      branch: "main",
      uncommitted: ["src/auth.ts"],
      untracked: ["notes.md"],
    });
  });
});

describe("unitFingerprintFrom", () => {
  it("changes when a file is moved — one of §3.4's named divergences", () => {
    const before = unitFingerprintFrom(
      "root",
      parsePorcelainV2(cleanBranch),
      HEAD,
    );
    const after = unitFingerprintFrom(
      "root",
      parsePorcelainV2(
        porcelain([
          `# branch.oid ${HEAD}`,
          "# branch.head feat/git-workspaces",
          "# branch.upstream origin/feat/git-workspaces",
          "# branch.ab +2 -3",
          "2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts",
          "src/old.ts",
        ]),
      ),
      HEAD,
    );

    expect(before.dirtyDigest).not.toBe(after.dirtyDigest);

    const report = deriveDivergence(
      { kind: GIT_WORKSPACE_KIND, observedAt: 1, units: [before] },
      { kind: GIT_WORKSPACE_KIND, observedAt: 2, units: [after] },
    );

    expect(report.changes.map((change) => change.kind)).toEqual([
      "uncommitted-changed",
    ]);
    expect(checkContinuation(report).allowed).toBe(true);
  });

  it("ignores ignored files, so a build output does not read as divergence", () => {
    const withIgnored = unitFingerprintFrom(
      "root",
      parsePorcelainV2(
        porcelain([
          `# branch.oid ${HEAD}`,
          "# branch.head feat/git-workspaces",
          "# branch.upstream origin/feat/git-workspaces",
          "# branch.ab +2 -3",
          "! dist/bundle.js",
        ]),
      ),
      HEAD,
    );

    expect(withIgnored.dirtyDigest).toBe(
      unitFingerprintFrom("root", parsePorcelainV2(cleanBranch), HEAD)
        .dirtyDigest,
    );
  });
});
