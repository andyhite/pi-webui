# PlotRoom — hard rules

The delivery workflow — issues, the board, worktrees, PRs, the QA gate, who
merges — belongs to the **foreman** extension. Read its skills
(`skill://tracker`, `skill://dev-loop`, `skill://worktree`,
`skill://verification`, …) rather than improvising, and treat
`.omp/foreman.json` as the source of truth for this repo's board, labels, and
commands. `AGENTS.md` is the background: layout, toolchain, conventions.

These are the rules foreman can't know — this product, this repository.

## Working alongside others

- **One issue, one branch, one worktree, one writer.** Never work on `main`,
  never switch the primary checkout's branch.
- **A worktree you did not create belongs to another session.** Read it if you
  are reviewing it; never edit, commit, install, build, or remove it.
- **The board is the only shared memory.** Move tracked state the moment it
  changes; an item nobody moved reads as work available.

## The product

- **`docs/product-spec.md` is the thesis.** Every change is judged against it.
  A proposal that violates a governing principle is an amendment to the spec,
  not a feature — say so and get the operator's sign-off before building it.
- **Rules are enforced, not documented.** One predicate in `@plotroom/core`,
  called by every surface; never re-derive a rule at a call site. The
  `lint:arch` pass exists to catch exactly that.
- **Never truncate silently.** Content that was cut says so.
- **Bugs stay bugs.** Severity rides the label (`bug:sev0`–`bug:sev3`),
  assigned at triage; a bug is never relabeled task or epic.
- **A documentation edit is never the price of merging something else.**

## The toolchain

- **Bun, not pnpm/npm/yarn.** `bun@1.3.14` is pinned, `bun.lock` is the
  lockfile, `bunx` replaces `npx`. `package.json` and `.github/workflows/`
  are the authority for exactly what the toolchain is, if anything ever
  looks inconsistent.
- **Green `bun verify` is not proof.** It shows nothing broke, not that what
  you built works — exercise the change itself, and run the e2e gate
  (`bun run --filter=@plotroom/web e2e`, after building `@plotroom/web`) when
  you touched a surface it covers.
- **Generated files are never hand-edited** —
  `packages/toolkit/src/theme.generated.css` comes from the token table,
  `bun.lock` from Bun.
