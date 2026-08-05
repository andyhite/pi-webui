---
name: plotroom-smoke
description: Run PlotRoom and exercise a change by hand — the step green pnpm verify does not cover. Use exactly once, when implementation of a PlotRoom change is finished and before opening or merging its pull request; not a per-commit loop step.
---

# Exercising a change by hand

Exercise the gesture or seam the change touched — work it out from
`git diff origin/main...HEAD` if it is not already obvious, and say what you chose.

`docs/development.md` in `~/plotroom` is the runbook; read it rather than guessing at
ports and variables. Green `pnpm verify` proves nothing broke, not that what you built
works, and this is the step that closes that gap.

## Pick the cheapest thing that actually exercises it

- **A pure function or a data source** — its own suite. Do not start a server for this.
- **A server seam** — the in-process harness (`apps/server/src/testing/harness.ts`):
  `boot(overrides)`, real app, real state directory, scripted runtime, ephemeral port.
  Spread `repository()` in if the test runs work, or every run is refused
  `workspace_not_configured`.
- **A surface the browser touches** — `pnpm build`, then
  `pnpm --filter @plotroom/web e2e`, or the existing harness
  (`apps/web/e2e/server-harness.ts`) for a one-off.
- **Anything you would only believe by clicking** — run it and drive it.

## Running it, on your own port and your own state

```sh
PLOTROOM_STATE_DIR=$(mktemp -d) PLOTROOM_PORT=4610 pnpm dev
```

The page is on **`PLOTROOM_PORT + 1`** — 4611 here, not 4610. Other sessions are on
4600/4601, so take a pair of your own; Vite silently slides to the next free port, so a
renderer that came up unexpectedly is proxying to somebody else's server.

Before any run will start, the product needs a repository to branch from
(`PLOTROOM_WORKSPACE_REPO`, pointed at a **scratch** repo — PlotRoom makes real
worktrees, and pointing it at this checkout puts them beside other agents') and a
runtime that can enforce permissions. To drive runs with no model, use
`PLOTROOM_RUNTIME=scripted` **and** `PLOTROOM_RUNTIME_SCRIPT=<file>` — the scripted
runtime refuses a run with no script, and `MILESTONE_SCRIPT` in
`apps/web/e2e/server-harness.ts` is the shape to copy.

Drive the browser with the `browser` tool against that port rather than describing what
you would click. Take one screenshot of the state that proves it, and read the server's
log for the refusal you expected to _not_ see.

## Report

- **What you ran** — the exact command and environment.
- **What you did** — the gesture, in order.
- **What you saw** — the observed result, quoted or screenshotted, not paraphrased.
- **What you could not check**, and why. A gap named is worth more than a claim.

If it did not work, that is the finding: say what happened, not what should have.
