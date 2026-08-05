---
name: plotroom-land
description: Land a finished PlotRoom worktree's branch — rebase, prove, open the pull request, merge it yourself, then clean up and move the board. Use once a change in ~/plotroom is implemented, proven, and reviewed, and is ready to reach main. Not an operator-invoked command — an agent finishing a tracked item runs this itself.
---

# Landing a branch

Land the work in the current worktree for its tracked issue. `AGENTS.md` in
`~/plotroom` wins on any conflict; `skill://plotroom-tracker` has the board verbs.

**Nothing reaches `main` except through a pull request you merge yourself.** No direct
push, no local fast-forward, no exception for one line. The one thing that bypasses
this is `pnpm release`, and that is not this.

Refuse and say why if any of these is true:

- cwd is the primary checkout (`git rev-parse --show-toplevel` is `~/plotroom`);
- the working tree is dirty;
- `pnpm verify` has never been green on this branch;
- the change has not been exercised — not merely compiled (`skill://plotroom-smoke`).

## 1. Rebase, then prove

```sh
git fetch origin
git rebase origin/main
pnpm install            # the lockfile is the most common collision: take main's, reinstall
pnpm verify
```

Plus `pnpm --filter @plotroom/web e2e` if you touched a surface that suite covers. A
rebase that produced conflicts invalidates the earlier run — this one is what counts.
This is the terminal gate: it runs once here (and once more only if the rebase below
moves again while you wait), never per commit during implementation.

## 2. Open the pull request

**The title is the permanent record.** A squash merge writes it, with ` (#N)`
appended, as the commit subject on `main`, and CI lints exactly that string — so it
must be a Conventional Commit subject and it must leave room for the suffix (65
characters of title, at most).

```sh
git push -u origin HEAD
env -u GH_TOKEN gh pr create --title "<type>(<scope>): <description>" --body "$(cat <<'EOF'
Closes #<n>.

What changed, and why — the argument, not the diff.

## How it was exercised
What you actually ran or clicked, and what you saw. Name what you could not check.
EOF
)"
```

## 3. Review, then merge

Somebody who did not write the change reads it, and **the review goes on the pull
request** — `skill://plotroom-review` dispatches it and posts the verdict. Fix the
blockers, squash the fixes into the commits that introduced them, and say on the
thread what you fixed. Then:

```sh
env -u GH_TOKEN gh pr checks --watch
env -u GH_TOKEN gh pr merge --squash        # --rebase when every commit stands alone
```

If a check is red, find out **why** before re-running it. A flake is a bug worth
filing (with its rate, measured) — not a reason to roll again in silence. If `main`
moved while you waited, rebase and push again.

## 4. Clean up, and move the board

```sh
git -C ~/plotroom pull --ff-only
cd ~/plotroom
git worktree remove ../plotroom-<branch-with-dashes>
git worktree prune
git branch -D <branch>              # -D: a squash merge leaves no merge ancestry
```

GitHub deletes the remote branch. Then close the issue with the commit sha and move it
to `Done` (`pr_status <n> 601a9561`). A task is not complete while its worktree exists,
and an item nobody moved reads to every other session as work available.

Remove only worktrees you created — never another session's, not even one that looks
merged.

## 5. Report

The commit sha on `main`, the pull request number, the issue closed, the board moved,
the worktree and branch gone — and anything the next session needs that you recorded on
an issue rather than here.
