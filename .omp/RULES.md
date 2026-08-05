# PlotRoom — hard rules

Several agents and the operator are working in this repository right now, on
different branches, in different worktrees, and none of them can see each other's
context. `AGENTS.md` is the full description of the conventions; these are the ones
that must stay in view.

- **One change, one branch, one worktree, one writer.** Work in a worktree of your
  own, never on `main`, and never by switching the primary checkout's branch.
- **A worktree you did not create belongs to another session.** Read it if you are
  reviewing it; never edit, commit, install, build, or remove it.
- **Move tracked state the moment it changes** — claim before your first edit,
  record a blocker when it becomes true, close when the work lands. Work tracking
  lives outside this repository; an item nobody moved reads as work available.
- **Nothing reaches `main` except through a pull request**, which its author merges
  once the checks are green and the review is answered. No direct push, no local
  fast-forward, no exception for one line. `main` stays linear: squash or rebase,
  never a merge commit, and rebase onto `main` immediately before merging.
- **Conventional Commits**, one logical change per commit.
- **Green `pnpm verify` is not proof.** It shows nothing broke, not that what you
  built works — exercise the change itself (`docs/development.md`), and run
  `pnpm --filter @plotroom/web e2e` when you touched a surface it covers.
- **Somebody who did not write the change reads it** before it lands, and the review
  is recorded on the pull request.
- **Rules are enforced, not documented.** One predicate in `@plotroom/core`, called
  by every surface; never re-derive a rule at a call site.
- **Never truncate silently.** Content that was cut says so.
- **A documentation edit is never the price of merging something else.**
- **Clean up after yourself, and only after yourself.** A task is not complete while
  its worktree still exists.
