/**
 * The bump derivation (decision 0003 §3, #94). The rule is stated once,
 * here, because the script, its tests and any future release surface must
 * agree about what a range of commits means.
 */
import type { ParsedCommit } from "./commits.ts";

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export type Bump = "major" | "minor" | "patch";

export const ZERO_VERSION: SemVer = { major: 0, minor: 0, patch: 0 };

/**
 * The rule as data: every type commitlint accepts, and what it bumps.
 * `"none"` means changelog material that bumps nothing (0003 §3).
 *
 * This table is what makes 0003's claim — "the enumeration is exhaustive
 * over the types commitlint accepts, so no commit has an undefined outcome"
 * — checkable instead of asserted: a type reaching the derivation that is
 * absent here is reported by {@link unclassifiedTypes} and stops the run,
 * rather than quietly bumping nothing.
 *
 * `major` appears in no row on purpose. A major comes only from a breaking
 * change at `1.x` or later; `1.0.0` itself is a deliberate act (0003 §6),
 * never derived.
 */
export const BUMP_BY_TYPE: Record<string, Bump | "none"> = {
  feat: "minor",
  fix: "patch",
  perf: "patch",
  docs: "none",
  chore: "none",
  refactor: "none",
  test: "none",
  build: "none",
  ci: "none",
  style: "none",
  revert: "none",
};

export function formatVersion(version: SemVer): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

const VERSION = /^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/;

/** Reads `1.2.3` or `v1.2.3`; anything else is not a version this repo made. */
export function parseVersion(text: string): SemVer | undefined {
  const groups = VERSION.exec(text.trim())?.groups;
  if (groups === undefined) return undefined;
  return {
    major: Number(groups["major"]),
    minor: Number(groups["minor"]),
    patch: Number(groups["patch"]),
  };
}

export interface Release {
  readonly version: SemVer;
  readonly bump: Bump;
  /** Which commits earned the bump — what a dry run should be able to show. */
  readonly reason: readonly ParsedCommit[];
}

/**
 * The next release, or `undefined` when the range earns none.
 *
 * A range of only bumpless types produces **no release** rather than a
 * patch (0003 §3): a version people read is a claim that something changed
 * for them, and a range of `docs`/`chore` commits is not that claim.
 *
 * A breaking change is a minor while the major is `0` and a major from
 * `1.0.0` — semver's own allowance for pre-1.0, and 0003's reading of it.
 */
export function deriveRelease(
  previous: SemVer,
  commits: readonly ParsedCommit[],
): Release | undefined {
  const breaking = commits.filter((commit) => commit.breaking);
  if (breaking.length > 0) {
    return previous.major >= 1
      ? {
          version: { major: previous.major + 1, minor: 0, patch: 0 },
          bump: "major",
          reason: breaking,
        }
      : {
          version: {
            major: previous.major,
            minor: previous.minor + 1,
            patch: 0,
          },
          bump: "minor",
          reason: breaking,
        };
  }

  const features = commits.filter(
    (commit) => BUMP_BY_TYPE[commit.type] === "minor",
  );
  if (features.length > 0) {
    return {
      version: { major: previous.major, minor: previous.minor + 1, patch: 0 },
      bump: "minor",
      reason: features,
    };
  }

  const fixes = commits.filter(
    (commit) => BUMP_BY_TYPE[commit.type] === "patch",
  );
  if (fixes.length > 0) {
    return {
      version: {
        major: previous.major,
        minor: previous.minor,
        patch: previous.patch + 1,
      },
      bump: "patch",
      reason: fixes,
    };
  }

  return undefined;
}

/**
 * Types {@link BUMP_BY_TYPE} has no row for. Empty by construction today; it
 * is a check rather than a comment so a type added to commitlint's list
 * without a rule here fails a run instead of silently bumping nothing.
 */
export function unclassifiedTypes(
  commits: readonly ParsedCommit[],
): readonly string[] {
  const unknown = new Set<string>();
  for (const commit of commits) {
    if (BUMP_BY_TYPE[commit.type] === undefined) unknown.add(commit.type);
  }
  return [...unknown].sort();
}
