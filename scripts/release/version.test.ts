import { describe, expect, it } from "vitest";

import type { ParsedCommit } from "./commits.ts";
import {
  BUMP_BY_TYPE,
  ZERO_VERSION,
  deriveRelease,
  formatVersion,
  parseVersion,
  unclassifiedTypes,
} from "./version.ts";

function commit(
  type: string,
  overrides: Partial<ParsedCommit> = {},
): ParsedCommit {
  return {
    hash: "0".repeat(40),
    type,
    scope: undefined,
    breaking: false,
    description: `a ${type}`,
    ...overrides,
  };
}

describe("parseVersion", () => {
  it("reads a tag with or without its v, and refuses anything else", () => {
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("v1.2")).toBeUndefined();
    expect(parseVersion("v1.2.3-beta.1")).toBeUndefined();
    expect(parseVersion("release-1.2.3")).toBeUndefined();
  });
});

describe("deriveRelease", () => {
  it("proposes 0.1.0 from nothing when the range has a feature (#94)", () => {
    const release = deriveRelease(ZERO_VERSION, [commit("feat")]);
    expect(release && formatVersion(release.version)).toBe("0.1.0");
    expect(release?.bump).toBe("minor");
  });

  it("proposes no release at all when nothing in the range bumps (0003 §3)", () => {
    expect(
      deriveRelease(ZERO_VERSION, [
        commit("docs"),
        commit("chore"),
        commit("refactor"),
        commit("test"),
        commit("build"),
        commit("ci"),
        commit("style"),
        commit("revert"),
      ]),
    ).toBeUndefined();
  });

  it("patches for fix and for perf", () => {
    expect(
      formatVersion(
        deriveRelease({ major: 0, minor: 4, patch: 1 }, [commit("fix")])!
          .version,
      ),
    ).toBe("0.4.2");
    expect(
      formatVersion(
        deriveRelease({ major: 0, minor: 4, patch: 1 }, [commit("perf")])!
          .version,
      ),
    ).toBe("0.4.2");
  });

  it("minors a breaking change while the major is 0, and majors it from 1.0.0", () => {
    const breaking = [commit("feat", { breaking: true })];
    expect(
      formatVersion(
        deriveRelease({ major: 0, minor: 9, patch: 4 }, breaking)!.version,
      ),
    ).toBe("0.10.0");
    expect(
      formatVersion(
        deriveRelease({ major: 1, minor: 9, patch: 4 }, breaking)!.version,
      ),
    ).toBe("2.0.0");
  });

  it("never derives 1.0.0, which is a deliberate act (0003 §6)", () => {
    // Whatever a 0.x range contains, the major does not move: only an
    // operator publishing 1.0.0 says spec §15's first cut is true.
    for (const commits of [
      [commit("feat", { breaking: true })],
      [commit("feat")],
      [commit("fix")],
    ]) {
      const release = deriveRelease(
        { major: 0, minor: 99, patch: 99 },
        commits,
      );
      expect(release?.version.major).toBe(0);
    }
  });

  it("takes the strongest bump in the range, whatever the order", () => {
    const commits = [commit("fix"), commit("feat"), commit("docs")];
    expect(deriveRelease(ZERO_VERSION, commits)?.bump).toBe("minor");
    expect(deriveRelease(ZERO_VERSION, [...commits].reverse())?.bump).toBe(
      "minor",
    );

    const withBreaking = [commit("fix"), commit("chore", { breaking: true })];
    expect(
      deriveRelease({ major: 2, minor: 0, patch: 0 }, withBreaking)?.bump,
    ).toBe("major");
  });

  it("reports which commits earned the bump, not merely that one was earned", () => {
    const earning = commit("feat", { description: "the one that counts" });
    const release = deriveRelease(ZERO_VERSION, [commit("docs"), earning]);
    expect(release?.reason).toEqual([earning]);
  });

  it("resets the lower components, so a minor does not carry a stale patch", () => {
    expect(
      formatVersion(
        deriveRelease({ major: 0, minor: 3, patch: 7 }, [commit("feat")])!
          .version,
      ),
    ).toBe("0.4.0");
  });
});

describe("the bump table", () => {
  it("covers every type AGENTS.md allows, so no commit has an undefined outcome", () => {
    // The list in AGENTS.md → "Conventional Commits — required". If a type is
    // added there, this fails until the derivation has a rule for it.
    const allowed = [
      "feat",
      "fix",
      "docs",
      "refactor",
      "perf",
      "test",
      "build",
      "ci",
      "chore",
      "style",
      "revert",
    ];
    expect(Object.keys(BUMP_BY_TYPE).sort()).toEqual([...allowed].sort());
  });

  it("names a type it has no rule for rather than bumping nothing by accident", () => {
    expect(unclassifiedTypes([commit("feat"), commit("wip")])).toEqual(["wip"]);
    expect(unclassifiedTypes([commit("feat")])).toEqual([]);
  });
});
