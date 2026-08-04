# Contributing to PlotRoom

PlotRoom is a context-authoring canvas for operating a fleet of AI agents. Before contributing, read:

1. [`docs/product-spec.md`](docs/product-spec.md) — what the product is and how it behaves.
2. [`AGENTS.md`](AGENTS.md) — the canonical conventions (git rules, worktrees, commit format, work tracking). This document expands on them; `AGENTS.md` wins on any conflict.
3. The **PlotRoom project board** (https://github.com/users/andyhite/projects/1) — all work is tracked as GitHub Issues on this repo; every change starts from an issue and moves through the ticket lifecycle (see "Work tracking — GitHub Projects" / "The ticket lifecycle" in `AGENTS.md`).

The project is a greenfield rebuild: docs only so far. The stack is decided — TypeScript, Electron + Hono server, SQLite via Drizzle, React + xyflow canvas, pnpm + Turborepo, Vitest + Playwright. See "Stack" and "Open decisions" in `AGENTS.md`.

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

The full ticket lifecycle (idea → delivery, incl. board-status obligations) is
defined in `AGENTS.md` — this is the git-level view of the middle of it.

**Several agents work here at once.** Expect other worktrees in the parent
directory and other tickets in flight; `In Progress` on the board means claimed
by somebody else, and a worktree you did not create is theirs. Never take an
`In Progress` item and never touch another worktree — `AGENTS.md`'s "Many agents
work here at once" is the rule, this is the reminder.

1. **Issue first.** No branch without an issue. Take from the top of `To Do`, never from `In Progress`, and move yours to `In Progress` (with a comment naming your branch) **before** the first edit — that claim is the only thing stopping a second agent starting the same work.
2. **Branch.** `<type>/<short-slug>`, referencing the issue where practical, e.g. `feat/42-session-delete`, in a worktree in the parent directory:
   ```sh
   git worktree add ../plotroom-feat-42-session-delete -b feat/42-session-delete
   ```
3. **Commit** in small, single-purpose Conventional Commits (see below), each referencing the issue (`#42`) in the body.
4. **Verify** (`pnpm verify`, plus e2e when you touched covered surfaces), then move the issue to `Review`.
5. **Rebase** onto `main` after review passes and immediately before landing — another agent may have landed meanwhile — and never merge `main` into your branch.
   ```sh
   git fetch origin
   git rebase origin/main
   ```
6. **Land** as a fast-forward or a squash with `Fixes #42` in the landing commit/PR body. No merge commits. Confirm the issue closed.
7. **Clean up** the branch and its worktree — the ticket is not delivered while its worktree exists. Yours only: leave every other worktree alone.

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

`git worktree list` normally shows several: one per ticket currently
`In Progress`, each another agent's. Create and remove your own; touch no other.

## Changing the spec

`docs/product-spec.md` describes behavior, never implementation. Amendments to its governing principles (§2) or non-goals (§14) are changes to the product's thesis — propose them in their own `docs:` commit with the reasoning, separate from any implementation.

Any behavior change that contradicts the spec must update the spec in the same commit.

## Review expectations

- The change matches the spec section it claims to implement.
- No violation of the four first-cut invariants (`AGENTS.md` → "Spec invariants worth memorizing").
- Commits are Conventional, scoped, and rebased on `main`.
- No secrets, generated artifacts, or machine-specific paths.
