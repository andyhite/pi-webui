---
description: main is PR-only — no direct pushes, merges, or checkouts of main
condition: 'git\s+push[^\n]*[\s:]main\b|git\s+(checkout|switch)\s+main\b|git\s+merge\s+(?!--abort|--continue)'
scope: tool
---

Stop — that command touches `main` or creates a merge commit.

- Nothing reaches `main` except a pull request: checks green, a review by
  someone who did not write the change recorded on the PR, then
  `gh pr merge --squash` (or fast-forward). Never `git push … main`, never a
  local merge into anything.
- Never check out `main` in a work session — the primary checkout belongs to
  the operator; your work lives on `<type>/<issue>-<slug>` in your own
  worktree.
- To take updates from main: `git fetch origin main && git rebase origin/main`
  — a rebase, never `git merge`.

If this fired on something legitimately different (e.g. a rebase invocation
that happened to match), proceed — but re-check the command against the rules
above first.
