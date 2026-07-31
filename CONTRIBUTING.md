# Contributing to PlotRoom

PlotRoom is a context-authoring canvas for operating a fleet of AI agents. Before contributing, read:

1. [`docs/product-spec.md`](docs/product-spec.md) — what the product is and how it behaves.
2. [`AGENTS.md`](AGENTS.md) — the canonical conventions (git rules, worktrees, commit format). This document expands on them; `AGENTS.md` wins on any conflict.

The project is a greenfield rebuild: docs only so far. The stack is decided — TypeScript, Electron + Hono server, SQLite via Drizzle, React + xyflow canvas, pnpm + Turborepo, Vitest + Playwright. See "Stack" and "Open decisions" in `AGENTS.md`.

## Quick start

```sh
git clone <remote> plotroom
cd plotroom
git config merge.ff only
git config pull.rebase true
pnpm install       # once the workspace exists
```

## Workflow

1. **Branch.** `<type>/<short-slug>` (optionally with a ticket id), e.g. `feat/context-edge-authors`.
   ```sh
   git switch -c feat/context-edge-authors
   ```
   Or use a worktree in the parent directory:
   ```sh
   git worktree add ../plotroom-feat-context-edge-authors -b feat/context-edge-authors
   ```
2. **Commit** in small, single-purpose Conventional Commits (see below).
3. **Rebase** onto `main` before opening a PR — never merge `main` into your branch.
   ```sh
   git fetch origin
   git rebase origin/main
   ```
4. **Open a PR** with a Conventional Commit title and a body that states what changed and why, plus which spec section it implements.
5. **Land** as a fast-forward or a squash. No merge commits.
6. **Clean up** the branch and its worktree.

## Commit messages

Conventional Commits 1.0.0 is required:

```
<type>(<optional scope>)<optional !>: <description>

<optional body>

<optional footer(s)>
```

| Type | Use for |
|---|---|
| `feat` | new user-visible capability |
| `fix` | bug fix |
| `docs` | documentation only |
| `refactor` | behavior-preserving code change |
| `perf` | performance change |
| `test` | tests only |
| `build` | build system, dependencies, packaging |
| `ci` | CI configuration |
| `chore` | maintenance with no src/test impact |
| `style` | formatting only |
| `revert` | reverts a previous commit |

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

Never nest a worktree inside the repo. Keep the primary checkout on `main`.

## Changing the spec

`docs/product-spec.md` describes behavior, never implementation. Amendments to its governing principles (§2) or non-goals (§14) are changes to the product's thesis — propose them in their own `docs:` commit with the reasoning, separate from any implementation.

Any behavior change that contradicts the spec must update the spec in the same commit.

## Review expectations

- The change matches the spec section it claims to implement.
- No violation of the four first-cut invariants (`AGENTS.md` → "Spec invariants worth memorizing").
- Commits are Conventional, scoped, and rebased on `main`.
- No secrets, generated artifacts, or machine-specific paths.
