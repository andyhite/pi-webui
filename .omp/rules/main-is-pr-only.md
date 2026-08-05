---
description: main is PR-only and only the operator merges — no direct pushes, merges, or checkouts of main
condition: 'git\s+push[^\n]*[\s:]main\b|git\s+(checkout|switch)\s+main\b|git\s+merge\s+(?!--abort|--continue)|gh\s+pr\s+merge|gh\s+stack\s+merge'
scope: tool
---

Stop — that command merges, or touches `main` directly.

- **Agents never merge.** The operator merging a PR is the approval; an
  operator comment on it is a change request. Open the PR, move the issue to
  `Review`, and wait — `gh pr merge` and `gh stack merge` are the operator's
  gestures, not yours.
- Nothing reaches `main` except an operator-merged pull request. Never
  `git push … main`, never a local merge into anything.
- Never check out `main` in a work session — the primary checkout belongs to
  the operator; your work lives on `<type>/<issue>-<slug>` in your own
  worktree.
- To take updates from main: `git fetch origin main && git rebase
origin/main` (or `gh stack sync` inside a stack) — a rebase, never
  `git merge`.

If this fired on something legitimately different (e.g. reading a merge
state), proceed — but re-check the command against the rules above first.
