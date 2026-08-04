# Contributing to PlotRoom

PlotRoom is a context-authoring canvas for operating a fleet of AI agents. Before contributing, read:

1. [`docs/product-spec.md`](docs/product-spec.md) — what the product is and how it behaves.
2. [`AGENTS.md`](AGENTS.md) — the canonical conventions (git rules, worktrees, commit format). This document expands on them; `AGENTS.md` wins on any conflict.

Work tracking lives outside this repository, and nothing about it is documented
here. The only in-repo record of work is [`CHANGELOG.md`](CHANGELOG.md).

The stack is decided — TypeScript, Electron + Hono server, SQLite via Drizzle, React + xyflow canvas, pnpm + Turborepo, Vitest + Playwright. See "Stack" in `AGENTS.md`, and `docs/decisions/` for the records behind it.

## Quick start

```sh
git clone <remote> plotroom
cd plotroom
git config merge.ff only
git config pull.rebase true
pnpm install
pnpm verify        # format:check + typecheck + lint + test
```

Requires Node 22+ and pnpm 9. Husky hooks install with `pnpm install`.

**Plus Bun 1.3.14+, for one package.** `apps/session-host` embeds the agent SDK,
which is Bun-only, and runs its tests with `bun test`; everything else stays on
Node, with pnpm as the package manager and turbo as the task runner. Without Bun
on `PATH`, `pnpm verify` fails at that package's `test` — the rest of the
workspace builds, typechecks and tests normally. Install it from
[bun.sh](https://bun.sh); point the server at a Bun kept elsewhere with
`PLOTROOM_SESSION_HOST_BUN`.

| Command       | Does                                      |
| ------------- | ----------------------------------------- |
| `pnpm verify` | everything CI checks — run before pushing |
| `pnpm build`  | `tsc -b` across the project graph         |
| `pnpm test`   | Vitest                                    |
| `pnpm lint`   | ESLint                                    |
| `pnpm format` | Prettier, writing changes                 |

Local hooks refuse commits on `main`, reject non-conforming branch names, and
run commitlint on every message. CI repeats all of it and additionally rejects
merge commits in a PR.

## Workflow

This is the git-level view of making a change.

**Several agents work here at once.** Expect other worktrees in the parent
directory. A worktree you did not create is another session's: never write to one
(reading is fine — reviewing a branch you did not write means reading it).
`AGENTS.md`'s "Many agents work here at once" is the rule, this is the reminder.

1. **Branch.** `<type>/<short-slug>`, in a worktree in the parent directory:
   ```sh
   git worktree add ../plotroom-feat-session-delete -b feat/session-delete
   ```
2. **Commit** in small, single-purpose Conventional Commits (see below).
3. **Verify** — `pnpm verify`, plus the e2e suite when you touched surfaces it covers.
4. **Review.** Somebody who did not write the change reads it (see "Review expectations").
5. **Rebase** onto `main` immediately before landing — another agent may have landed meanwhile — and never merge `main` into your branch.
   ```sh
   git fetch origin
   git rebase origin/main
   ```
6. **Land** as a fast-forward or a squash. No merge commits.
7. **Clean up** your branch and its worktree. Yours only: leave every other worktree alone.

## Commit messages

Conventional Commits 1.0.0 is required:

```
<type>(<optional scope>)<optional !>: <description>

<optional body>

<optional footer(s)>
```

| Type       | Use for                               |
| ---------- | ------------------------------------- |
| `feat`     | new user-visible capability           |
| `fix`      | bug fix                               |
| `docs`     | documentation only                    |
| `refactor` | behavior-preserving code change       |
| `perf`     | performance change                    |
| `test`     | tests only                            |
| `build`    | build system, dependencies, packaging |
| `ci`       | CI configuration                      |
| `chore`    | maintenance with no src/test impact   |
| `style`    | formatting only                       |
| `revert`   | reverts a previous commit             |

Rules:

- Imperative, lowercase description; no trailing period; subject ≤ 72 chars.
- Scope is optional and lowercase (`canvas`, `graph`, `sessions`, `workspaces`, `integrations`, `docs`, …).
- Breaking change: `!` after type/scope **and** a `BREAKING CHANGE:` footer.
- Reference tickets in a footer: `Refs: OXY-2982`.

Good:

```
feat(queue): support acknowledge, snooze, and mute on every feed

Drift and health alerts share one triage path so the queue stays
clearable. Implements spec §4.5 and §7.1.

Refs: OXY-2982
```

Bad: `updated stuff`, `WIP`, `Fix bug.`, `feat: Added new canvas feature.`

## History policy: fast-forward only

`main` is a linear history.

- **No merge commits on `main`**, from any source.
- A branch lands as a **fast-forward** (already rebased on `main`) or as a **squash** into one Conventional Commit.
- Integrate upstream work with `git rebase`, never `git merge`.
- If a squash is used, the squashed subject must itself be a valid Conventional Commit — it becomes the permanent record.

```sh
# fast-forward land, done from the primary checkout
git switch main
git pull --ff-only
git merge --ff-only feat/context-edge-authors
```

Force-push topic branches only, with `--force-with-lease`. Never rewrite commits already on `main`.

## Worktrees

Worktrees live beside the repo, named `plotroom-<branch-with-slashes-as-dashes>`:

```sh
git worktree add ../plotroom-fix-drift-flags -b fix/drift-flags   # create
git worktree list                                                  # inspect
git worktree remove ../plotroom-fix-drift-flags                    # after landing
git worktree prune
```

Never nest a worktree inside the repo. Keep the primary checkout on `main` —
switching its branch breaks every concurrent session at once.

`git worktree list` normally shows several: one per change in flight, because a
worktree lives until its branch lands. Create and remove your own; write to no
other.

## Changing the spec

`docs/product-spec.md` describes behavior, never implementation. Amendments to its governing principles (§2) or non-goals (§14) are changes to the product's thesis — propose them in their own `docs:` commit with the reasoning, separate from any implementation.

A behavior change that contradicts the spec does not carry the spec edit: record
the contradiction where work is tracked and fix it on its own, in its own `docs:`
commit (`AGENTS.md` → "Documentation").

## Review expectations

- The change matches the spec section it claims to implement.
- No violation of the four first-cut invariants (`AGENTS.md` → "Spec invariants worth memorizing").
- Commits are Conventional, scoped, and rebased on `main`.
- No secrets, generated artifacts, or machine-specific paths.
