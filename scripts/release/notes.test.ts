import { describe, expect, it } from "vitest";

import type { ParsedCommit } from "./commits.ts";
import { headinglessTypes, renderNotes } from "./notes.ts";

let counter = 0;
function commit(
  type: string,
  description: string,
  overrides: Partial<ParsedCommit> = {},
): ParsedCommit {
  counter += 1;
  return {
    hash: `${counter}`.padStart(40, "0"),
    type,
    scope: undefined,
    breaking: false,
    description,
    ...overrides,
  };
}

describe("renderNotes", () => {
  it("contains every commit in the range exactly once (#94)", () => {
    const commits = [
      commit("feat", "one"),
      commit("fix", "two"),
      commit("docs", "three"),
      commit("chore", "four"),
      commit("feat", "five", { breaking: true }),
    ];
    const notes = renderNotes(commits);
    for (const { description } of commits) {
      expect(notes.split(description).length - 1).toBe(1);
    }
  });

  it("gives a breaking change no section of its own, so it is not listed twice", () => {
    const notes = renderNotes([commit("feat", "moved the address")]);
    expect(notes).not.toContain("Breaking");

    const breaking = renderNotes([
      commit("feat", "moved the address", { breaking: true }),
    ]);
    expect(breaking).toContain("### Features");
    expect(breaking).toContain("**BREAKING** moved the address");
    expect(breaking.match(/moved the address/g)).toHaveLength(1);
  });

  it("orders sections news-first rather than alphabetically", () => {
    const notes = renderNotes([
      commit("chore", "c"),
      commit("docs", "d"),
      commit("fix", "f"),
      commit("feat", "n"),
    ]);
    expect(notes.indexOf("### Features")).toBeLessThan(
      notes.indexOf("### Fixes"),
    );
    expect(notes.indexOf("### Fixes")).toBeLessThan(
      notes.indexOf("### Documentation"),
    );
    expect(notes.indexOf("### Documentation")).toBeLessThan(
      notes.indexOf("### Chores"),
    );
  });

  it("groups by scope within a type, with scopeless entries first", () => {
    const notes = renderNotes([
      commit("fix", "z", { scope: "sessions" }),
      commit("fix", "y", { scope: "canvas" }),
      commit("fix", "x"),
      commit("fix", "a", { scope: "sessions" }),
    ]);
    const lines = notes.split("\n").filter((line) => line.startsWith("- "));
    expect(lines.map((line) => line.replace(/ \(\w+\)$/, ""))).toEqual([
      "- x",
      "- **canvas:** y",
      "- **sessions:** a",
      "- **sessions:** z",
    ]);
  });

  it("emits no heading for a type with no commits", () => {
    expect(renderNotes([commit("feat", "only this")])).toBe(
      "### Features\n\n- only this (00000000)",
    );
  });

  it("carries the short hash, because the changelog is the record of what landed", () => {
    const one = commit("fix", "something");
    expect(renderNotes([one])).toContain(`(${one.hash.slice(0, 8)})`);
  });
});

describe("headinglessTypes", () => {
  it("names a type with no heading rather than dropping its commits", () => {
    expect(headinglessTypes([commit("feat", "a"), commit("wip", "b")])).toEqual(
      ["wip"],
    );
    expect(headinglessTypes([commit("feat", "a")])).toEqual([]);
  });
});
