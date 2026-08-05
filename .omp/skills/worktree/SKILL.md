---
name: worktree
description: Creating, using, and cleaning up PlotRoom git worktrees for issue work — naming conventions, setup, and the discipline that keeps concurrent sessions from corrupting each other. Read before creating a branch or worktree, and before removing one.
---

# Worktrees — one issue, one branch, one worktree, one writer

Every piece of issue work happens in its own worktree, a sibling of the
primary checkout, on its own branch. The primary checkout belongs to the
operator: never switch its branch, never edit in it. A worktree you did not
create belongs to another session: read-only, always.

## Naming

| Thing    | Pattern                   | Example                               |
| -------- | ------------------------- | ------------------------------------- |
| Branch   | `<type>/<issue>-<slug>`   | `fix/291-actor-identity-gate`         |
| Worktree | `plotroom-<issue>-<slug>` | `../plotroom-291-actor-identity-gate` |

- `<type>` is a Conventional Commit type — the pre-commit hook **rejects**
  branches outside `feat fix docs refactor perf test build ci chore style
revert`. Bugs are `fix/`; tasks take whatever type fits the change.
- `<slug>` is the issue title, lower-kebab, trimmed to a handful of words.
- No colons or other characters that break a Windows checkout — kebab only.

## Create

```sh
PRIMARY=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
git -C "$PRIMARY" fetch origin main
git -C "$PRIMARY" worktree add "$PRIMARY/../plotroom-<issue>-<slug>" \
  -b <type>/<issue>-<slug> origin/main
cd "$PRIMARY/../plotroom-<issue>-<slug>"
pnpm install   # node_modules is per-worktree; this also wires the husky hooks
```

Before creating, check nobody beat you to it: the issue must not already be
`In Progress`, and `git branch -a | grep <issue>-` must come up empty. Claim
the issue (status `In Progress`, `tracker` skill) before your first edit.

## Work inside it

- Everything — edits, installs, checks, commits — happens inside the worktree.
- Keep the branch fresh against `origin/main` with `git rebase origin/main`
  (never `git merge`); resolve conflicts locally, in the worktree.
- Push with `git push -u origin <branch>` (`--force-with-lease` after a
  rebase, never bare `--force`).

## Clean up — yours, and only after the work landed

A task is not complete while its worktree still exists. After the PR is merged
and the issue is `Done`:

```sh
cd "$PRIMARY"
git worktree remove ../plotroom-<issue>-<slug>
git branch -d <type>/<issue>-<slug>
git worktree prune
```

`git worktree remove` refuses a dirty tree — that refusal means uncommitted
work exists; look at it before reaching for `--force`.

Never remove, edit, install into, or build inside a worktree another session
created — its dirty state is someone's in-flight work.
