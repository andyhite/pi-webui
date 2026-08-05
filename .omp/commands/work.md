---
description: Deliver a task or bug issue end to end (dev loop)
---

Deliver issue #$1 end to end.

Read `skill://dev-loop`, `skill://tracker`, `skill://worktree`, and
`skill://verification`, then execute the dev loop exactly as written: preflight
and claim, worktree, context, plan (dispatch the `planner` agent for anything
non-trivial), omp todos, TDD implementation orchestrated through subagents,
the verification ladder, the `qa` agent gate looped to PASS, PR, review wait,
merge, board moves, cleanup.

Two checks before you start: if #$1 is labeled `epic`, stop and tell me to use
`/orchestrate $1`instead; if it is not at`To Do`(or carries an untriaged`bug` label), stop and tell me what state it is actually in — do not work
around the lifecycle.

You are the orchestrator: subagents search and edit, you own sequencing,
verification, and delivery. Confirm with me before merging the PR. Report at
the end: PR, what shipped, how it was proven, board state, worktree removed.
