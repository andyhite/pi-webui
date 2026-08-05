# PlotRoom — hard rules

Several agents and the operator are working in this repository right now, on
different branches, in different worktrees, and none of them can see each
other's context. `AGENTS.md` is the full description of the conventions; these
are the ones that must stay in view.

- **One issue, one branch, one worktree, one writer.** Work in a worktree of
  your own, never on `main`, and never by switching the primary checkout's
  branch.
- **A worktree you did not create belongs to another session.** Read it if you
  are reviewing it; never edit, commit, install, build, or remove it.
- **Move tracked state the moment it changes** — claim the issue (`In
Progress`) before your first edit, record a blocker as an issue comment when
  it becomes true, `Review` when the PR opens, `Done` only after merge and
  cleanup. The board is the only shared memory; an item nobody moved reads as
  work available. The `tracker` skill is the single source of truth for
  statuses, labels, and recipes.
- **Nothing reaches `main` except a pull request, and only the operator
  merges it.** The merge **is** the approval; an operator comment on an open
  PR **is** a change request — back to `In Progress`, address it, return to
  `Review`. Agents never merge, never push to `main`, no local fast-forward,
  no exception for one line. `main` stays linear: squash or fast-forward,
  never a merge commit; keep the PR rebased onto `origin/main` while it
  waits.
- **Conventional Commits**, one logical change per commit; branches are
  `<type>/<slug>` (issue work: `<type>/<issue>-<slug>`).
- **Green `pnpm verify` is not proof.** It shows nothing broke, not that what
  you built works — exercise the change itself, and run
  `pnpm --filter @plotroom/web e2e` when you touched a surface it covers.
- **Bugs stay bugs.** Severity rides the label (`bug:sev0`–`bug:sev3`),
  assigned at triage; a bug is never relabeled task or epic.
- **A task without an epic must be tiny** — one small PR. Anything more gets
  an epic and a breakdown before work starts.
- **Rules are enforced, not documented.** One predicate in `@plotroom/core`,
  called by every surface; never re-derive a rule at a call site.
- **Never truncate silently.** Content that was cut says so.
- **A documentation edit is never the price of merging something else.**
- **Clean up after yourself, and only after yourself.** A task is not complete
  while its worktree still exists.
