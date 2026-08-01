import { describe, expect, it } from "vitest";

import {
  canonicalizePath,
  claimPath,
  describePath,
  isRootPath,
  isWithin,
  pathDepth,
  pathsConflict,
  relativeSegments,
  ROOT_PATH,
  samePath,
} from "./paths.js";

describe("canonicalizePath", () => {
  it("treats trailing and repeated separators as insignificant", () => {
    const forms = ["src", "src/", "src//", "./src/", "src/."];
    const keys = forms.map((form) => {
      const result = canonicalizePath(form);
      expect(result.ok).toBe(true);
      return result.ok ? result.path.key : "";
    });
    expect(new Set(keys).size).toBe(1);
  });

  it("normalizes backslashes to forward slashes", () => {
    const back = canonicalizePath("src\\auth.ts");
    const forward = canonicalizePath("src/auth.ts");
    expect(back.ok && forward.ok && back.path.key === forward.path.key).toBe(
      true,
    );
  });

  it("compares case-insensitively but keeps the authored case for display", () => {
    const upper = canonicalizePath("SRC/README.md");
    const lower = canonicalizePath("src/readme.md");
    expect(upper.ok && lower.ok && upper.path.key === lower.path.key).toBe(
      true,
    );
    expect(upper.ok && upper.path.display).toBe("SRC/README.md");
  });

  it("folds NFD and NFC spellings of one filename together", () => {
    // macOS stores decomposed names, Linux and Windows tools hand over composed
    // ones: `café.ts` typed by a human and the same name read from a directory
    // listing are routinely different byte strings for one physical file. Two
    // claims on one file is the single-writer guarantee failing invisibly, since
    // both spellings print identically (principle 4).
    const composed = "caf\u00e9.ts"; // é as one code point
    const decomposed = "cafe\u0301.ts"; // e + combining acute
    expect(composed).not.toBe(decomposed);

    const a = canonicalizePath(`src/${composed}`);
    const b = canonicalizePath(`src/${decomposed}`);
    expect(a.ok && b.ok && a.path.key === b.path.key).toBe(true);
    expect(
      pathsConflict(
        claimPath(`src/${composed}`),
        claimPath(`src/${decomposed}`),
      ),
    ).toBe(true);
  });

  it("normalizes before folding case, not after", () => {
    // Lowercasing a decomposed name leaves it decomposed, so the wrong order
    // silently reintroduces the collision for any name with an accent.
    expect(claimPath("SRC/CAFE\u0301.TS").key).toBe(
      claimPath("src/caf\u00e9.ts").key,
    );
  });

  it("normalizes directory segments too, so the hierarchy check agrees", () => {
    const parent = claimPath("caf\u00e9"); // composed
    const child = claimPath("cafe\u0301/auth.ts"); // decomposed
    expect(isWithin(child, parent)).toBe(true);
  });

  it("leaves the authored spelling in `display` for messages", () => {
    const decomposed = canonicalizePath("src/cafe\u0301.ts");
    expect(decomposed.ok && decomposed.path.display).toBe("src/cafe\u0301.ts");
  });

  it("does not claim full Unicode case folding — ς and σ stay distinct", () => {
    // Documented limit, not an oversight: `toLowerCase` maps Σ to σ but leaves ς
    // alone, which is what the common case-insensitive filesystems do. Folding
    // them together would refuse claims those filesystems consider different
    // files; a stricter rule belongs to whichever workspace kind can prove its
    // filesystem needs it (§3.4's mechanism-per-kind).
    expect(claimPath("\u03a3igma.ts").key).toBe(claimPath("\u03c3igma.ts").key);
    expect(claimPath("final\u03c2.ts").key).not.toBe(
      claimPath("final\u03c3.ts").key,
    );
  });

  it("resolves `.` and interior `..`", () => {
    const result = canonicalizePath("src/api/../ui/./widget.tsx");
    expect(result.ok && result.path.display).toBe("src/ui/widget.tsx");
  });

  it("refuses a `..` that climbs above the workspace root", () => {
    const result = canonicalizePath("../outside/secret");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.reason).toBe("escapes_root");
    expect(result.refusal.input).toBe("../outside/secret");
  });

  it("refuses a `..` that escapes after resolving", () => {
    expect(canonicalizePath("src/../../etc").ok).toBe(false);
  });

  it("refuses absolute paths and drive prefixes rather than re-anchoring them", () => {
    expect(canonicalizePath("/etc/passwd").ok).toBe(false);
    expect(canonicalizePath("C:\\Windows\\system32").ok).toBe(false);
  });

  it("refuses an empty path; the root is spelled `.`", () => {
    const empty = canonicalizePath("   ");
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.refusal.reason).toBe("empty");

    const root = canonicalizePath(".");
    expect(root.ok && isRootPath(root.path)).toBe(true);
    expect(root.ok && samePath(root.path, ROOT_PATH)).toBe(true);
  });

  it("refuses a NUL byte", () => {
    const result = canonicalizePath("src/a\0b.ts");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toBe("invalid_segment");
  });

  it("trims surrounding whitespace", () => {
    expect(
      canonicalizePath("  src/auth.ts  ").ok && claimPath("src/auth.ts").key,
    ).toBe(claimPath("  src/auth.ts  ").key);
  });

  it("throws from `claimPath` rather than falling back silently", () => {
    expect(() => claimPath("../nope")).toThrow(/above the workspace root/);
  });
});

describe("hierarchy", () => {
  it("makes a directory claim cover everything under it, existing or not", () => {
    expect(isWithin(claimPath("src/auth.ts"), claimPath("src"))).toBe(true);
    expect(
      isWithin(claimPath("src/deep/not/created/yet.ts"), claimPath("src")),
    ).toBe(true);
    expect(isWithin(claimPath("src"), claimPath("src/auth.ts"))).toBe(false);
  });

  it("does not confuse a prefix of a name with a parent directory", () => {
    expect(isWithin(claimPath("srcfoo/a.ts"), claimPath("src"))).toBe(false);
    expect(pathsConflict(claimPath("src"), claimPath("srcfoo"))).toBe(false);
  });

  it("conflicts on ancestor, descendant, and identical paths (§3.4)", () => {
    expect(pathsConflict(claimPath("src"), claimPath("src/auth.ts"))).toBe(
      true,
    );
    expect(pathsConflict(claimPath("src/auth.ts"), claimPath("src"))).toBe(
      true,
    );
    expect(
      pathsConflict(claimPath("src/auth.ts"), claimPath("SRC/AUTH.TS")),
    ).toBe(true);
    expect(pathsConflict(claimPath("src/api"), claimPath("src/ui"))).toBe(
      false,
    );
  });

  it("makes the root conflict with everything", () => {
    expect(pathsConflict(ROOT_PATH, claimPath("anything/at/all"))).toBe(true);
    expect(pathDepth(ROOT_PATH)).toBe(0);
    expect(describePath(ROOT_PATH)).toBe("the workspace root");
  });

  it("reports the segments below an enclosing path", () => {
    expect(
      relativeSegments(claimPath("src/ui/app.tsx"), claimPath("src")),
    ).toEqual(["ui", "app.tsx"]);
    expect(relativeSegments(claimPath("src"), claimPath("src"))).toEqual([]);
    expect(relativeSegments(claimPath("lib"), claimPath("src"))).toEqual([]);
  });
});
