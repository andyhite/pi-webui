# PlotRoom tooling review — August 2026

**What this is:** a comprehensive review of every piece of build, check, test, run, and
packaging tooling in this monorepo, judged against current best practice, plus migration
plans for the operator's directions: **Bun as the single toolchain**, the repo's documented
workarounds **fixed at the source rather than preserved**, workspace conventions **enforced
by lint rules in a shared package** instead of the bespoke meta-test, a **faster linter**,
and a desktop shell decision now **open between Electrobun and Tauri** after the operator
put the pinned-Chromium/shell-e2e constraints on the table.

**Who it is for:** the agent (or person) implementing the recommendations. Every claim
carries a file citation or a source URL; anything not directly verified is marked
`[INFERENCE]` or "verify". Where the repo does something unusual _on purpose_, this review
maps it to the exact migration step that removes its reason — deleting a workaround before
its reason is gone reintroduces a measured failure (see `01` §9).

**Is it current:** written 2026-08-05 against `main` @ `8075bab7`. Installed tool versions
were read from `pnpm-lock.yaml`, not manifest ranges. External claims were researched
against upstream docs/repos on the same date. TypeScript 7 (native compiler) is stable as
of this date (operator-confirmed).

**One landing after the review baseline matters:** #302 (`7c0ec1eb`) rebuilt the
documentation and process layer the same day. References in this report to
`docs/development.md`, `docs/deployment.md`, `docs/decisions/*` (including 0005/0006),
`docs/architecture/*`, and the old `.omp` skills resolve only at `8075bab7` — read them
from history (`git show 8075bab7:<path>`). The decision _records_ this report builds on
(0005's Bun/Electrobun pricing, 0006's Electrobun-under-Playwright measurements) remain
true as evidence; their prose now lives in git history rather than on `main`.

## Verdict in one paragraph

This is a disciplined setup — conventions enforced by a meta-test, measured justifications
on every odd choice, layered CI gating — whose real problems are version drift (Vitest two
majors behind, dragging a second Vite major along), no type-aware linting, some dead
config, an over-invalidating `globalDependencies` pattern, and a build/typecheck duality
whose torn-output workaround (#118) exists only because packages must emit JS for Node
consumers. The plan removes the constraint instead of patching around it: **Bun everywhere**
(runtime, package manager, test runner); **packages stop building** — raw-TS exports, one
root **TypeScript 7 native** no-emit check; **bun:sqlite** behind an FTS5 platform gate;
**oxlint** as the primary linter (type-aware via tsgolint) with the custom architectural +
workspace-convention rules written once in ESLint-plugin format inside the shared config
package (retiring most of the meta-test); and a **shell decision procedure** — three cheap
spikes plus an operator constraint call — between **Electrobun+CEF** (constraints kept) and
**Tauri v2** (constraints relaxed; front-runner on governance/signing/updater/Intel-Mac,
gated on a WebKitGTK canvas spike), with e2e restructured either way toward **dual-target**:
Playwright browser engine matrix for the canvas, a thin native suite for the shell. What
must _not_ happen is deleting workarounds out of order — `01` §9 maps each to the step that
retires it safely.

## Contents

| File                                                       | Contents                                                                                                                                                                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`01-current-state.md`](01-current-state.md)               | Full inventory of the tooling as it exists, and §9: each "weird thing" with the step that **retires its reason**                                                                                      |
| [`02-assessment.md`](02-assessment.md)                     | Findings vs. best practice: strengths, prioritized issues, version-currency table, dead-config list                                                                                                   |
| [`03-recommendations-core.md`](03-recommendations-core.md) | Toolchain-agnostic changes: config packages, dep hygiene, **oxlint linter modernization**, **conventions-as-lint-rules**, verdicts table                                                              |
| [`04-bun-migration.md`](04-bun-migration.md)               | Bun-everywhere: the typecheck question answered (§4.1), phased plan A–E ending in the **no-build TS restructure**                                                                                     |
| [`05-shell-migration.md`](05-shell-migration.md)           | The shell decision procedure (constraint call + spikes S1–S3) and both plans: **5.A Electrobun+CEF**, **5.B Tauri v2**                                                                                |
| [`06-sequencing.md`](06-sequencing.md)                     | The combined roadmap: ordering, dependency graph, per-stage acceptance criteria, invariants checklist                                                                                                 |
| [`07-alternatives.md`](07-alternatives.md)                 | Decision matrices with recorded losers: shell (constraints-as-a-choice), **dual-target e2e** fidelity analysis, typechecker shape, **linter field** (oxlint/Biome/xo), meta-test replacement analysis |

## Where the work is tracked

This report is a **point-in-time record** — it describes the repository as of
`8075bab7` and the ecosystem as of 2026-08-05, and is not updated as the plan lands. The
living plan is epic **#304** ("Toolchain unification: Bun everywhere, no-build
TypeScript 7, oxlint, and a new desktop shell") with children #305–#319, which map 1:1 to
the stage table in `06-sequencing.md`; every child issue is self-contained, so the board,
not this report, is authoritative for scope and status. What this report adds over the
issues is the evidence trail: source URLs, fidelity tables, and the recorded losers in
`07-alternatives.md`.

**For the implementing agent:**

- Work the queue in #304's body; each child lands through its own worktree + PR per
  `AGENTS.md`. Never one mega-branch.
- The migrations **supersede decision 0005 parts (b) and (c)** and change the constraint
  posture behind 0006's decision context (0006 itself stays true as a measurement). The
  ADR is #309 and must merge before the coupled milestone starts.
- The shell choice requires the **operator's constraint call** plus spikes S1–S3 (#308,
  detailed in `05` §5.0) — do the spikes first; one of them is the go/no-go.
- `AGENTS.md`'s stack table, `docs/development.md`, `docs/deployment.md`, and
  `CONTRIBUTING.md` all state Node/pnpm/Electron facts that these migrations change. Per
  repo rules, those documentation edits are **their own changes** (#318), never riders on
  the implementing PRs.

## Method

Produced by one coordinating agent and thirteen parallel subagents: four read-only repo
scouts (root tooling, apps, packages, CI+docs) and nine librarians (Electrobun, Bun
monorepo toolchain, Bun SQLite/Drizzle, Turborepo/TS/Vitest/ESLint practices; a second
round on operator pushback: typechecking-without-tsc/TS 7, Bun-friendly e2e, Tauri vs
Electrobun; a third round: the 2026 linter field, browser-matrix e2e fidelity). All
load-bearing scout claims used in the recommendations were spot-verified against the
actual files; two scout errors were caught and corrected (`apps/server/tsconfig.json` does
**not** set `types: ["bun"]`; `.prettierignore` line numbers). Verified directly: the
ESLint config's lack of typed linting, the absence of `vi.mock`/jsdom across the tree,
installed versions from the lockfile. No file in the primary checkout or any other
worktree was modified; no builds, installs, or test suites were run.
