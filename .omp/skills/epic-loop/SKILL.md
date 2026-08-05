---
name: epic-loop
description: Orchestrating delivery of a PlotRoom epic — dependency-ordering its subtasks, dispatching issue-worker subagents in parallel waves, integration verification between waves, derived epic status, and closeout. Read when picking up an epic issue.
---

# Epic loop — orchestrate, verify, integrate

An epic is delivered by running the `dev-loop` on each subtask — but never by
you directly. You are the **conductor**: you sequence, dispatch, watch,
integrate, and verify. You do not edit product code, create task worktrees, or
open task PRs; `issue-worker` subagents do that, one per subtask, each in its
own worktree. Related skills: `tracker` (statuses, sub-issue queries, derived
epic status), `grooming` (breakdown), `bug-triage` (integration findings),
`verification`, `worktree`.

## 1. Preflight

- The issue is labeled `epic`. A task or bug goes to the `dev-loop` instead.
- It has subtasks (tracker skill: sub-issue query). **No breakdown, no
  dispatch** — run the breakdown procedure from the `grooming` skill first
  (with the operator in the loop), then come back.
- Subtasks you intend to dispatch are at `To Do`. A subtask already
  `In Progress` belongs to another session — coordinate via the board and
  `hub`, never by dispatching a second writer.

## 2. Read everything, then fix the contracts

Read the epic, every subtask, and the spec sections they cite. Then decide —
**before any dispatch** — the cross-task contracts: shared interfaces, schema
shapes, file ownership, naming. Two workers negotiating a contract mid-flight
is how integration fails. Write the contracts as a comment on the epic (so
they survive you) and into every worker brief that touches them.

If reading reveals the breakdown is wrong — tasks too big, a missing seam, a
dependency nobody recorded — fix the breakdown first (grooming skill), don't
dispatch around it.

## 3. Plan the waves

Build the dependency graph over subtasks. Group into waves: everything in a
wave is independent of everything else in it; a wave only starts when the
waves it depends on are merged. Prefer wide waves — but cap concurrent workers
at **3**: every merge is a rebase onto a moving `main`, and beyond that the
rebase churn eats the parallelism.

`todo init`: one omp todo per subtask, phased by wave, plus an integration
todo per wave and a closeout phase.

## 4. Dispatch a wave

One `task` batch per wave, `agent: issue-worker`, one item per subtask. Each
brief is self-contained (workers start blank): the issue number, the epic
number, the contracts from step 2, anything a sibling's landed work changed,
and the reminder that the worker owns its issue end-to-end — worktree, TDD,
QA gate, PR, merge, cleanup, board moves — per the `dev-loop` skill.

While a wave runs:

- Monitor with `hub` (`jobs`, `wait`); answer worker questions promptly —
  an unanswered contract question stalls a whole wave.
- Keep the epic's derived status current (tracker skill) as subtasks move.
- A stuck worker gets steered via `hub send`; a dead one gets its issue reset
  (blocker comment, status back to `To Do`) and redispatched or split.
- Workers merge their own PRs; if two PRs collide heavily, serialize them —
  tell one worker to hold its merge until the other lands.

A worker's "completed" is a claim. Verify it: the PR is merged, the issue is
`Done`, the worktree is gone.

## 5. Integrate between waves

After each wave fully lands, verify the _integrated_ state — each task was
verified alone, the combination was not:

```sh
PRIMARY=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
git -C "$PRIMARY" fetch origin main
git -C "$PRIMARY" worktree add "$PRIMARY/../plotroom-<epic>-integration" --detach origin/main
```

(Reuse the worktree across waves: `git -C ../plotroom-<epic>-integration fetch
origin && git -C ../plotroom-<epic>-integration checkout --detach origin/main`.)

In it: `pnpm install`, `pnpm verify`, the e2e gate, and — most importantly —
**exercise the epic's behavior across the seams** the wave just joined, per
rung 3 of the `verification` skill.

Findings are never fixed by you in the integration worktree. File each one:
a defect in landed work is a bug (`bug-triage` skill, usually `sev1` since it
blocks the epic); a missing seam is a new subtask (grooming breakdown
addendum, linked to the epic). Dispatch fixes as part of the next wave.

## 6. Closeout

When every subtask is `Done`:

1. Final integration pass (step 5) against the epic's own acceptance criteria
   — judge the epic against what it promised, not just against green checks.
2. Summary comment on the epic: what shipped, per-subtask PRs, how the
   integrated behavior was proven, anything deferred (as linked issues, never
   as prose someone must remember).
3. Close the epic; board status `Done` (this is the one Done that isn't tied
   to a PR of its own).
4. Remove the integration worktree. The epic is not complete while it exists.
