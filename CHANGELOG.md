# Changelog

Completed work, one section per release. Entries are **generated from the commit
range** rather than hand-written: `main` is a linear history — every change lands as a
squash or a rebase through a pull request — so the range between two tags is exact and
gap-free, and Conventional Commit types decide the grouping. `pnpm release --dry-run` prints what the next release would say and
writes nothing; `pnpm release` derives the version, writes the section, commits
and tags. A mistake in a generated section is fixed at its source — the commit
messages — never by editing the section, which the next run would not agree with.

This is the only record of work inside the repository (`AGENTS.md` →
"Documentation"). Decision records live in `docs/decisions/`.

## Unreleased

No release yet. The first tag replaces this section with generated entries.
