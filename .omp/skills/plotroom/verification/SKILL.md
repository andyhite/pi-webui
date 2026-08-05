---
name: verification
description: The PlotRoom verification ladder — cheapest-first feedback while implementing (LSP diagnostics, per-file lint, single test files), package-scoped checks after a slice, and the full pre-PR gate (pnpm verify + e2e). Read before running checks so you run the smallest thing that answers the question.
---

# Verification — run the smallest thing that answers the question

Three rungs. Climb only when the current rung is green; never open with the
full suite.

## Rung 1 — while implementing (seconds)

Per file, after each edit:

- **Types:** LSP diagnostics on the touched files (`lsp` tool,
  `diagnostics` with a path or glob). This is typecheck-grade feedback with no
  build — prefer it over running `tsc` mid-loop.
- **Lint:** `pnpm --filter <pkg> exec eslint <file>`
- **One test file:** `pnpm --filter <pkg> exec vitest run <path/to/file.test.ts>`
  — in `apps/session-host`, `bun test <path>` instead.

TDD shape: write the test, watch it fail for the right reason, implement,
watch it pass. A test that never failed proves nothing.

Do **not** run e2e, whole-package suites, or repo-wide anything on this rung.

## Rung 2 — after a slice (a minute or two)

When a coherent step of the plan is done, check the affected package(s) in one
turbo invocation so the graph orders build/typecheck correctly:

```sh
pnpm check --filter=@plotroom/<pkg>   # typecheck + lint + test, deps built first
```

Never run `build` and `typecheck` concurrently in one package by hand — both
are `tsc -b` over the same `dist/` and they tear it. One turbo invocation, or
one at a time.

## Rung 3 — the pre-PR gate (before every PR, after every review fix)

1. `pnpm format` on touched files (pre-commit runs `format:check` over the
   whole repo and will refuse otherwise).
2. `pnpm verify` — format check, full `pnpm check`, and `check:scripts`. Fix
   what it finds; do not scope it down at this rung.
3. **E2E when it applies:** if `@plotroom/web` is in the affected graph (it is
   for nearly any change to `server`, `core`, `db`, `ui`, `toolkit`,
   `session-host`, or the plugins):

   ```sh
   pnpm exec turbo run build --filter=@plotroom/web
   pnpm --filter @plotroom/web e2e
   ```

   First run on a machine: `pnpm --filter @plotroom/web exec playwright install --with-deps chromium`.

4. **Exercise the change.** Green `pnpm verify` shows nothing broke — not that
   what you built works. Run the actual surface: `pnpm dev` plus the browser
   tool for UI, a real invocation for APIs and CLIs, the repro steps for a bug
   fix. The observed behavior is the proof; name it in your report.

## CI expectations

- `ci.yml` mirrors rung 3 scoped by `turbo --affected`; e2e runs when
  `@plotroom/web` is affected. A skipped gated job counts as success.
- `checks.yml` (formatting, commitlint, history shape) runs on **every**
  change, including docs-shaped ones.
- Playwright is `retries: 0` by design: a red e2e is signal, never re-run it
  to make it green — download the failure artifact (trace + accessibility
  snapshot) _before_ re-running, GitHub keeps only the latest attempt's
  artifacts.
