---
description: Deliver an epic by orchestrating issue-worker subagents
---

Deliver epic #$1 by orchestration.

Read `skill://epic-loop` and `skill://tracker`, then run the epic loop exactly
as written: preflight (it must be a broken-down epic — if the breakdown is
missing, run it per `skill://grooming` with my sign-off first), fix the
cross-task contracts before any dispatch, plan the dependency waves, dispatch
`issue-worker` subagents (one per subtask, at most 3 concurrent), keep the
epic's derived board status current, run the integration verification between
waves in an integration worktree, file integration findings as tracked issues,
and close out with the final verification and summary.

You conduct; you never edit product code or open task PRs yourself. Workers
merge their own PRs after their QA gates — verify their claims against the
board and `main`, not their say-so.

Report at the end: subtask → PR → status table, how the integrated behavior
was proven, anything deferred (as linked issues), integration worktree
removed.
