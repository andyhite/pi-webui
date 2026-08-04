# 0003 — Versioning and release

- **Status:** Accepted
- **Date:** 2026-08-04
- **Issues:** #54 (decision), #94 (the release script)
- **Deciders:** operator

## Context

The repository had **no tags**, no release tooling of any kind, and every
workspace package sat `private` at `0.0.0` — eleven of them, plus the root
manifest. Nothing is published to a registry:
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
   `docs`, `chore`, `refactor`, `test`, `build`, `ci`, `style` and
   `revert` are changelog material and bump nothing — the enumeration is
   exhaustive over the types commitlint accepts, so no commit has an undefined
   outcome; a range containing only those produces **no
   release** rather than a patch.
4. **`CHANGELOG.md` is generated from the range**, grouped by type then scope,
   and is the only record of completed work inside the repository. It is never
   hand-edited, so it cannot drift from what landed.
5. **The desktop build will read the version from the root manifest**, injected at
   staging time, rather than keeping its own. Today `apps/desktop/package.json`
   still carries a `0.0.0` of its own and `electron-builder.yml` interpolates it;
   the injection lands with the release script. One source of truth is the point,
   so the version survives a change of shell.
6. **`1.0.0` means spec §15's first-cut list is true**, not a date.

## Consequences

The derivation is only as trustworthy as the commit messages, so the script this
decision calls for must refuse to run on a dirty tree, on a branch other than
`main`, or over a range containing a commit commitlint would reject, and must have
a dry-run mode. None of it exists yet; the record states the constraints it has to
meet.

Distribution is deliberately **not** decided here: channels, the update-feed host
and code signing need a publisher's accounts and certificates. Versioning is a
repository convention; publishing is an operator decision.
