---
description: Cut a release — dry run first, then the one path that writes to main directly
---

Cut a release of PlotRoom. Arguments, if any, are constraints on this run: $@

Decision 0003 (`docs/decisions/0003-versioning-and-release.md`) is the authority for
every rule below; `scripts/release.ts` implements them. **There are no tags yet**, so
the first run is also the first exercise of the first-release path — say so in the
report rather than presenting it as routine.

## 1. Dry run, always

```sh
cd ~/plotroom && git status --short && git log --oneline -1
pnpm release --dry-run
```

It prints what the release would say and writes nothing. Read the output as the thing
being reviewed: the derived version, the sections, and every commit that will appear in
the notes.

The script refuses rather than guessing, and each refusal is information:

- **not on `main`** — releases are cut from `main`;
- **a commit commitlint rejects** anywhere in the range — the range is the record, so one
  malformed subject stops the release. Fix it forward with a `docs:`/`chore:` note or
  accept that the range is what it is; **never rewrite a commit already on `main`**;
- **nothing releasable** — no `feat`, `fix` or `perf` since the last tag. That is an
  answer: there is nothing to release.

Version derivation is `feat` → minor, `fix`/`perf` → patch, a breaking change → minor
while the major is 0. `1.0.0` is never derived: it is the claim that spec §15 is true,
and it is mine to make.

## 2. Check the range says what happened

Before running it for real, read the notes against the tracker: does every entry
correspond to work that actually landed, and does anything that landed appear nowhere?
A missing entry means a commit that was not Conventional, and it is easier to find now
than after the tag.

## 3. Cut it

```sh
pnpm release
```

This is **the one path in this repository that writes to `main` without a pull
request** (`AGENTS.md` → "How work lands"): it writes the version and the changelog
section, commits `chore(release): vX.Y.Z` with `ALLOW_MAIN_COMMIT=1`, and creates the
annotated tag with the notes as its message. It does **not** push. The script prints the
two push commands; run them only when the local commit and tag are what you expected:

```sh
git push origin main && git push origin v<version>
```

Never edit `CHANGELOG.md` by hand. A wrong section is fixed at its source — the commit
messages — because the next run regenerates it and would disagree.

## 4. Say what a release does not do

CI has no tag or release trigger, so after the tag **nothing is built, signed, notarized,
published or fed to an updater**. Installers, signing posture and the update feed are
open work and, in part, decisions I still owe. Report the tag as a tag, and name what
would have to happen for it to be a download somebody can install.

## 5. Report

The version and how it was derived, the tag, the commit range, what the notes say, the
push commands you ran, and the list from step 4 — what this release is not yet.
