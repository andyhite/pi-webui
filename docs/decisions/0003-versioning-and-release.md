# 0003 — Versioning and release

- **Status:** Accepted
- **Date:** 2026-08-04
- **Deciders:** operator

## Context

The repository had **no tags**, no release tooling of any kind, and all twelve
workspace packages sat `private` at `0.0.0`. Nothing is published to a registry:
packages are linked `workspace:*` and exist to structure the product, not to be
consumed. Conventional Commits are enforced by commitlint and husky, and `main`
accepts fast-forward merges only, so the commit range between two points is exact
and gap-free.

## Decision

1. **One product version, in the root manifest.** Workspace packages stay
   `private` at `0.0.0` permanently — a version on an unpublished package is a
   number nobody reads. No Changesets, no lerna, no per-package bumps.
2. **Tags are `vX.Y.Z` on `main`.** Because history is linear,
   `git log <prev>..<tag>` is the complete changelog range by construction.
3. **The bump is derived, not chosen:** `feat` → minor, `fix`/`perf` → patch,
   `!`/`BREAKING CHANGE` → minor while `0.x` and major from `1.0.0`.
   `docs`, `chore`, `refactor`, `test`, `build`, `ci` and `style` are
   changelog material and bump nothing; a range containing only those produces **no
   release** rather than a patch.
4. **`CHANGELOG.md` is generated from the range**, grouped by type then scope,
   and is the only record of completed work inside the repository. It is never
   hand-edited, so it cannot drift from what landed.
5. **The desktop build reads the version from the root manifest**, injected at
   staging time. `apps/desktop/package.json` never carries a second copy, so the
   version survives a change of shell.
6. **`1.0.0` means spec §15's first-cut list is true**, not a date.

## Consequences

The derivation is only as trustworthy as the commit messages, which is why the
release script refuses to run on a dirty tree, on a branch other than `main`, or
over a range containing a commit commitlint would reject — and why it has a dry-run
mode.

Distribution is deliberately **not** decided here: channels, the update-feed host
and code signing need a publisher's accounts and certificates. Versioning is a
repository convention; publishing is an operator decision.
