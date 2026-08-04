import { describe, expect, it } from "vitest";

import { parseCommit, parseCommits } from "./commits.ts";

function record(subject: string, body = "") {
  return { hash: "abcdef1234567890", subject, body };
}

describe("parseCommit", () => {
  it("reads type, scope and description", () => {
    expect(
      parseCommit(record("feat(canvas): refuse illegal edges mid-drag")),
    ).toEqual({
      hash: "abcdef1234567890",
      type: "feat",
      scope: "canvas",
      breaking: false,
      description: "refuse illegal edges mid-drag",
    });
  });

  it("reads a scopeless subject as having no scope, not an empty one", () => {
    expect(
      parseCommit(record("docs: add product spec"))?.scope,
    ).toBeUndefined();
  });

  it("treats ! and a BREAKING CHANGE footer as the same declaration", () => {
    expect(
      parseCommit(record("refactor(graph)!: address outputs as output@n"))
        ?.breaking,
    ).toBe(true);
    expect(
      parseCommit(
        record(
          "refactor(graph): address outputs",
          "BREAKING CHANGE: `output` no longer resolves implicitly.",
        ),
      )?.breaking,
    ).toBe(true);
    // The specification treats the hyphenated spelling as equivalent.
    expect(
      parseCommit(record("refactor: rework", "BREAKING-CHANGE: it moved."))
        ?.breaking,
    ).toBe(true);
  });

  it("reads the footer only in the trailing block, not a quoted one mid-body", () => {
    // A `revert:` or a `fix:` citing what it undoes quotes the earlier
    // footer on its own line. Line-initial is not the same as a footer, and
    // treating it as one is a spurious major once the major is 1.
    expect(
      parseCommit(
        record(
          "revert: undo the addressing change",
          "This reverts a commit whose footer read:\nBREAKING CHANGE: output no longer resolves implicitly.\n\nNothing about this revert is breaking.",
        ),
      )?.breaking,
    ).toBe(false);
    // Still read when it really is the trailing block, after other footers.
    expect(
      parseCommit(
        record(
          "refactor: rework addressing",
          "Body prose.\n\nRefs: #123\nBREAKING CHANGE: it moved.",
        ),
      )?.breaking,
    ).toBe(true);
  });

  it("does not read prose about a breaking change as a declaration", () => {
    expect(
      parseCommit(
        record(
          "fix: tidy",
          "This is not a BREAKING CHANGE: it only looks like one mid-sentence.",
        ),
      )?.breaking,
    ).toBe(false);
  });

  it("refuses a subject commitlint would also refuse, rather than inventing a type", () => {
    for (const subject of [
      'Revert "feat: x"',
      "Feat: capitalised type",
      "feat:no space after the colon",
      "no type at all",
      "feat(scope with spaces): x",
      "",
    ]) {
      expect(parseCommit(record(subject))).toBeUndefined();
    }
  });

  it("keeps a colon in the description", () => {
    expect(parseCommit(record("fix(db): keep 1:1 mapping"))?.description).toBe(
      "keep 1:1 mapping",
    );
  });
});

describe("parseCommits", () => {
  it("returns every commit when all of them parse", () => {
    const result = parseCommits([record("feat: a"), record("fix: b")]);
    expect("commits" in result && result.commits.map((c) => c.type)).toEqual([
      "feat",
      "fix",
    ]);
  });

  it("names the offender instead of dropping it, so a commit cannot vanish from the notes", () => {
    const bad = record("not a conventional commit");
    const result = parseCommits([record("feat: a"), bad, record("fix: b")]);
    expect("unparsed" in result && result.unparsed).toEqual(bad);
  });
});
