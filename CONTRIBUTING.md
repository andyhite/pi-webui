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

| Command        | Does                                                       |
| -------------- | ---------------------------------------------------------- |
| `pnpm dev`     | the product: server on 4600, renderer on **4601**          |
| `pnpm verify`  | everything CI checks — run before pushing                  |
| `pnpm build`   | `tsc -b` across the project graph                          |
| `pnpm test`    | Vitest                                                     |
| `pnpm lint`    | ESLint                                                     |
| `pnpm format`  | Prettier, writing changes                                  |
| `pnpm compile` | the session host as this platform's standalone binary, run |

[`docs/development.md`](docs/development.md) is the runbook behind that first row —
what `pnpm dev` starts, why the page is on 4601, what the product needs before it can
run any work, how to exercise a change, and the shape each kind of change takes.

`pnpm compile` is not part of `verify`: it produces ~400MB (the binary plus the
agent SDK's native addon staged beside it) for the platform it runs on, and only
a packaged build needs it. It ends by running what it built, so a compile that
succeeds is one whose artifact starts.

Local hooks refuse commits on `main`, reject non-conforming branch names, and
run commitlint on every message. CI repeats all of it and additionally rejects
merge commits in a PR.

## Workflow

This is the git-level view of making a change.

**Several agents work here at once.** Expect other worktrees in the parent
directory. A worktree you did not create is another session's: never write to one
(reading is fine — reviewing a branch you did not write means reading it).
`AGENTS.md`'s "Many agents work here at once" is the rule, this is the reminder.

1. **Branch.** `<type>/<short-slug>`, in a worktree in the parent directory, off
   `origin/main` rather than off whatever the checkout you are standing in points at:
   ```sh
   git fetch origin
   git worktree add ../plotroom-feat-session-delete -b feat/session-delete origin/main
   ```
2. **Commit** in small, single-purpose Conventional Commits (see below).
3. **Verify** — `pnpm verify`, plus the e2e suite when you touched surfaces it covers,
   and then **exercise the change itself** ([`docs/development.md`](docs/development.md)).
4. **Rebase** onto `main` — another agent may have landed meanwhile — and never merge
   `main` into your branch.
   ```sh
   git fetch origin && git rebase origin/main
   ```
5. **Open the pull request.** Its body says what changed, why, and how it was exercised.
   ```sh
   git push -u origin HEAD
   gh pr create
   ```
6. **Review, then merge it yourself** when the checks are green and the review is
   answered. Somebody who did not write the change reads it (see "Review
   expectations") and the review goes on the pull request; then rebase again if `main`
   moved while you waited. Nothing reaches `main` any other way.
   ```sh
   gh pr checks --watch
   gh pr merge --squash --subject "type(scope): description"   # --rebase when every commit stands alone
   ```
7. **Clean up** your worktree and local branch — GitHub deletes the remote one on
   merge. Yours only: leave every other worktree alone.
   ```sh
   git -C ~/plotroom pull --ff-only
   cd ~/plotroom && git worktree remove ../plotroom-feat-session-delete && git worktree prune
   git branch -D feat/session-delete    # -D: a squash merge leaves no merge ancestry
   ```

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

## History policy: pull requests, linear history

**Every change reaches `main` through a pull request, merged by its author.** No
direct push, no local fast-forward, no exception for a one-line fix or a docs
change — the commitlint-over-the-range and merge-commit checks only run on a pull
request, so a change that skipped it skipped them.

`main` is a linear history:

- **No merge commits, from any source.** GitHub offers only squash and rebase here,
  and CI rejects a merge commit in a pull request.
- **Squash** when the branch is one logical change; **rebase** when each of its
  commits stands alone and is itself a valid Conventional Commit. A squashed subject
  becomes the permanent record, so it must be a real Conventional Commit.
- Integrate upstream work with `git rebase`, never `git merge`, and rebase again
  immediately before merging.

```sh
# from the worktree that holds the work
git fetch origin && git rebase origin/main
pnpm verify
git push -u origin HEAD
gh pr create
gh pr checks --watch
gh pr merge --squash --subject "type(scope): description"   # --rebase when every commit stands alone

# then bring the primary checkout forward without ever switching its branch
git -C ../plotroom pull --ff-only
```

**Pass the squash subject yourself.** It becomes the permanent record and nothing lints
it: commitlint runs over the branch's commits before the squash, and the default
subject is the pull-request title with ` (#N)` appended, which is over 72 characters
more often than not.

The one thing that does not go through a pull request is a release: `pnpm release` cuts
from `main` and commits there (decision 0003).

You merge your own work. Nobody else is waiting to press the button, so a pull
request whose checks are green and whose review is answered and which nobody merged
is simply unfinished work.

Never `git switch` or `git checkout` in the primary checkout — another agent or the
operator may be relying on it, and switching it breaks every concurrent session at
once (`AGENTS.md` → "Worktrees").

Force-push topic branches only, with `--force-with-lease`. Never rewrite commits already on `main`.

## Worktrees

Worktrees live beside the repo, named `plotroom-<branch-with-slashes-as-dashes>`:

```sh
# create, from the primary checkout or any worktree
git fetch origin
git worktree add ../plotroom-fix-drift-flags -b fix/drift-flags origin/main
git worktree list

# then, inside the new one — node_modules is not shared
cd ../plotroom-fix-drift-flags && pnpm install

# after landing, from anywhere except the worktree being removed
git -C ~/plotroom worktree remove ../plotroom-fix-drift-flags
git -C ~/plotroom worktree prune
```

Branch from `origin/main`, not from the primary checkout's `main`, which may be
behind — that way starting work never touches the primary checkout at all. Removing
a worktree while standing in it deletes the shell's own directory and the next
command fails, so run the last two from somewhere else.

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
