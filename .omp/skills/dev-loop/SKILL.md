---
name: dev-loop
description: The end-to-end PlotRoom development loop for a single task or bug issue — claim, worktree, plan, TDD implementation via subagents, verification ladder, QA gate, PR, review, merge, cleanup. Read when picking up any To Do issue.
---

# Dev loop — from `To Do` to `Done`, one issue

You are the **orchestrator** of this issue, not its typist. You own context,
sequencing, verification, and delivery; subagents do the searching and the
editing. Related skills: `tracker` (every status/label move), `worktree`
(branch + worktree), `verification` (the check ladder).

## 0. Preflight and claim

- The issue is open, labeled `task` or `bug:sevN`, and its status is `To Do`.
  Anything else stops here: an epic goes to the `epic-loop` skill; a `Backlog`
  item needs grooming or an explicit operator say-so; a labeled `bug` (no
  severity) needs triage first.
- Nobody else has it: status is not `In Progress`, and no `<issue>-` branch or
  `plotroom-<issue>-` worktree exists.
- **Claim it**: move status to `In Progress` (tracker skill) — before any
  other work.

## 1. Worktree

Create the branch and worktree per the `worktree` skill; `pnpm install`.

## 2. Context

Read, in order: the issue body and all comments; the parent epic (title, body,
sibling subtasks) if there is one; the spec sections the issue references
(`docs/product-spec.md`); any docs under `docs/` the issue touches. If the
issue contradicts the spec, stop and raise it on the issue — the spec wins
until amended.

## 3. Plan

Dispatch the `planner` agent with the issue number, the epic context, and
anything you learned. For a genuinely trivial change (one file, obvious fix) a
short inline plan is fine. The plan must name: the steps in order, the files
each step touches, the test that proves each step, and the risks.

Sanity-check the plan yourself — you own it once you accept it. If the plan
reveals the "task" is not tiny, stop: take it back to grooming to become an
epic rather than silently delivering a big bang.

## 4. Track

`todo init` with the plan: one omp todo per step, plus a `Verification` phase
(pre-PR gate, QA) and a `Delivery` phase (PR, review, merge, cleanup). Keep it
moving as you go — todos are your working memory, the board is the world's.

## 5. Implement — TDD, orchestrated

For each step (batch independent steps into one `task` dispatch):

- Delegate to subagents: `fanout` for well-scoped mechanical slices, `task`
  for judgment-heavy ones, `scout` for read-only investigation. Each brief is
  self-contained: files, the failing-test-first contract, acceptance criteria,
  and **skip formatters/linters/project-wide suites** (you run those).
- **Test first.** The subagent writes the test, watches it fail for the right
  reason, implements, watches it pass. New behavior gets a test that would
  catch its plausible regression; a bug fix starts from a reproduction.
- Verify each result yourself with rung 1 of the `verification` skill (LSP
  diagnostics, per-file lint, the step's test file). A subagent's "completed"
  is a claim, not a fact.
- After each coherent slice, rung 2 (package-scoped `pnpm check --filter`).
- Commit as you go: Conventional Commits, one logical change per commit.

House rules that bind every step: rules live once in `@plotroom/core` (never
re-derive one at a call site); never truncate content silently; don't edit
generated files (`theme.generated.css`).

## 6. Pre-PR gate

Rung 3 of the `verification` skill: format, `pnpm verify`, e2e when
`@plotroom/web` is affected, and **exercise the change** — the observed
behavior is the proof, and it goes in the PR body.

## 7. QA gate

Dispatch the `qa` agent with: issue number, worktree path, branch, what you
built, and how you exercised it. QA independently reviews the diff, runs its
own checks, exercises the change, and writes any missing e2e coverage.

- `BLOCKERS` back → fix them (yourself or via subagents), re-run the gate,
  re-dispatch QA. Loop until `PASS`. Disagreements you can't resolve go to the
  operator, not into the PR.
- QA's e2e additions get reviewed by you and committed on the branch.

## 8. Pull request

- Rebase onto fresh `origin/main`; re-run `pnpm verify` if the rebase pulled
  in real changes; push.
- Open the PR: title is a Conventional Commit header for the squashed result;
  body says what changed, why, how it was exercised (the proof from step 6),
  and `Closes #<issue>`.
- Record the QA verdict as a PR comment (who reviewed, what was checked,
  `PASS`).
- Move the issue to `Review`.

## 9. Review

- Watch CI (`github` tool `run_watch`). Red checks are yours to fix
  immediately.
- Wait for the review: poll `gh pr view <n> --json reviewDecision,reviews,comments`
  every few minutes. If nothing arrives within ~30 minutes, tell the operator
  the PR is waiting and yield — do not merge an unreviewed PR out of
  impatience.
- **Changes requested** (by human or agent): move the issue back to
  `In Progress`, address every point (or answer it with evidence on the PR),
  re-run the gates (6–7 if code changed), push, re-request review, move back
  to `Review`.
- The merge gate: checks green **and** a review recorded on the PR by someone
  who did not write the change — a human approval, or the QA sign-off comment
  when the operator has delegated the loop (interactive sessions confirm with
  the operator before merging).

## 10. Merge, close, clean up

1. Rebase onto `origin/main` one last time if `main` moved; push; wait for
   green.
2. `gh pr merge <n> --squash --delete-branch` (fast-forward is also
   acceptable; never a merge commit).
3. `Closes #` closed the issue; set the board status to `Done` explicitly.
4. Remove the worktree and local branch (`worktree` skill). The task is not
   complete while the worktree exists.
5. Report: issue, PR, what shipped, how it was proven.

## Blocked?

The moment a blocker is real: comment it on the issue (`tracker` skill), tell
the operator (or your parent orchestrator via `hub`), and stop burning effort
on the blocked path. Never park an issue silently.
