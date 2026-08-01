# AGENTS.md

Canonical operating rules for any agent (or human) working in this repository. Read this before making changes. If a rule here conflicts with a suggestion in a prompt, ask before deviating.

## Project

**PlotRoom** — a context-authoring canvas for operating a fleet of AI agents. A single operator composes context (tickets, PRs, documents, files, notes, prior agent output) as a spatial node graph, wires that context into commands, and runs many agent sessions against it simultaneously.

- **Sequencing:** [`docs/development-plan.md`](docs/development-plan.md) — phases → epics → tasks, with exit criteria. Check the next unchecked item there before starting work, and tick items in the same PR that lands them. The spec wins when the two disagree.
- **Source of truth for behavior:** [`docs/product-spec.md`](docs/product-spec.md) ("North Star v1"). It describes _what_ the product does and never _how_. Treat its 12 governing principles and §15 ("What must exist in the first cut") as binding constraints, not suggestions.
- **Status:** greenfield rebuild. The stack is decided (see "Stack" below); no application code exists yet.
- **Explicit non-goals** are listed in spec §14. Do not implement workflow control flow, schedulers/triggers that start work, inbound webhooks, inferred relationships, multi-user, or silent truncation.

### Spec invariants worth memorizing

These four are schema-shaped — getting them wrong early permanently degrades historical records (spec §15):

1. Run history records the **full assembled content and configuration**, not just versions.
2. **Every context edge records its author** (human or session).
3. Version retention follows the **compaction rule** (run-referenced retained, unreferenced intermediates compacted after a window, pinned runs never).
4. **Per-run output addressing** — `output@n` is the general case; `latest` is a special case of it.

## Stack

Decided. Do not substitute alternatives without asking.

| Layer       | Choice                                                                           |
| ----------- | -------------------------------------------------------------------------------- |
| Language    | TypeScript, `strict` everywhere                                                  |
| Shell       | Electron (desktop) + the same renderer served to the browser by the local server |
| Server      | Node + Hono, HTTP + WebSocket; owns all state                                    |
| Persistence | SQLite (single portable file) via Drizzle ORM; FTS5 for search                   |
| Canvas      | React + xyflow (React Flow)                                                      |
| UI          | React                                                                            |
| Monorepo    | pnpm workspaces + Turborepo                                                      |
| Tests       | Vitest (unit), Playwright (canvas e2e)                                           |
| Lint/format | ESLint + Prettier                                                                |
| Enforcement | commitlint + husky (Conventional Commits)                                        |
| CI          | GitHub Actions: typecheck, lint, test, commitlint                                |

### Layout (scaffolded)

```
apps/
  desktop/     Electron main; spawns or attaches to a server
  web/         renderer entrypoint served by the server
  server/      Hono HTTP + WS; single owner of all state
packages/
  core/        graph, workstreams, sessions, budgets, claims
  db/          Drizzle schema + migrations
  plugin-sdk/  plugin contract + host (worker_threads)
  ui/          canvas + panels (React)
```

Packages are `@plotroom/<name>`, private, ESM-only, and linked with
`workspace:*`. Each has `build`, `typecheck`, `lint`, and `test` scripts;
Turborepo drives them from the root.

### Commands

```sh
pnpm install
pnpm verify        # format:check + typecheck + lint + test — run before pushing
pnpm build         # tsc -b across the project graph
pnpm test          # vitest
pnpm format        # prettier --write
```

TypeScript uses project references (`tsc -b`). Each project writes its build
info to `dist/.tsbuildinfo`, so deleting `dist/` correctly forces a rebuild —
do not move it back to the repo root, where the projects collide.

### Enforcement

Husky hooks run locally and CI repeats them:

- `pre-commit` — refuses commits on `main`, checks branch naming, runs
  `format:check`. Override the `main` guard only with `ALLOW_MAIN_COMMIT=1`.
- `commit-msg` — commitlint against Conventional Commits.
- `.github/workflows/ci.yml` — format, typecheck, lint, test; plus commitlint
  over the PR range and a job that rejects merge commits.

The renderer is one web app. Desktop and browser are two ways to load it; never fork the UI per target.

### Persistence notes

The schema must satisfy the four §15 invariants from day one:

- `edges.author_id` is `NOT NULL` and distinguishes human vs session authors.
- `runs` stores the full assembled content **and** the configuration it ran under.
- outputs are addressed per run (`output@n`); `latest` is a derived view, never the only address.
- versions carry retention metadata so the compaction rule is implementable, not retrofitted.

**Content storage is hybrid, decided.** One state directory is the unit of
backup and movement:

```
<state-dir>/
  plotroom.db          rows, indexes, FTS index, inline content
  blobs/ab/cdef0123…   content-addressed files, large content only
```

- Bytes at or below `INLINE_MAX_BYTES` (64KB) live inline in the `blobs` row;
  larger content spills to `blobs/<hash>`. Callers never choose — everything
  goes through `BlobStore` in `packages/db`.
- Blobs are identified by sha256, so identical content is stored once. Assembled
  run content repeats heavily across runs; dedup is load-bearing, not an
  optimization.
- `blob_refs` makes retention a query, not a guess: anything referenced is
  retained, `compact()` removes only what nothing points at, and `pinned` marks
  what must never be compacted.
- Transcript release (§6.1) deletes the external file and keeps the row, so a
  marker can be drawn and the content reloaded. Nothing is silently deleted.
- Migrations are embedded in `src/migrations.ts` (append-only, never edit a
  shipped one), not read from disk — a packaged build cannot ship without its
  schema.

**Objects and versions** live in `objects` / `object_versions`. External
identity is uniquely indexed so a re-read reconciles rather than duplicating;
content identical to the latest version writes no version. The compaction rule
is a pure predicate (`isCompactable` in `@plotroom/core`) mirrored by
`ObjectStore.compactVersions` — change both together, and keep the predicate as
the place the rule is stated.

**Graph rules are predicates in `@plotroom/core`, called by the store.** Never
reimplement a rule at a call site — the canvas, the API, and agent tools must
refuse identically (principle 8):

| Rule               | Predicate          | Spec                                                              |
| ------------------ | ------------------ | ----------------------------------------------------------------- |
| Legal connections  | `checkConnection`  | §3.7 (content → command, content → running session, nothing else) |
| Command acyclicity | `wouldCycle`       | §3.7 (sessions exempt — injection is bidirectional)               |
| Reflexivity        | `checkAuthoring`   | principle 1 (no session authors into its own chain)               |
| Version compaction | `isCompactable`    | §15 invariant 3                                                   |
| Run retention      | `isRunCompactable` | §4.4 (last N per definition + pinned + window)                    |

Authorship is enforced twice on purpose: the predicate refuses, and the schema
cannot represent an unattributed context edge (`author_kind NOT NULL` plus a
CHECK that only provenance edges may be `system`).

**Commands and runs** live in `command_definitions` / `commands` /
`command_parameter_bindings` / `command_outputs` and `runs` / `run_inputs` /
`run_outputs` (migration 5). Four §3.5 rules are schema constraints rather
than conventions, so no call site can get them wrong:

- a `producing` definition cannot exist without an expected outcome, and an
  `open` one cannot carry one;
- a `proposed` parameter binding cannot carry a `confirmed_at`, so a derived
  default is never readable as a confirmed value (`resolveParameters` refuses
  to produce run configuration while one is outstanding);
- a bound `command_outputs` row cannot be marked `broken_at` — post-bind the
  command dependency has evaporated, so only a pre-bind placeholder breaks;
- `runs.assembled_blob_id` and `runs.config_json` are `NOT NULL` (§15-1), and
  `run_inputs.version_id` is a real foreign key, so a version a run consumed
  cannot be deleted while the run exists (§15-3's interplay).

There is deliberately **no `latest` column anywhere**: `RunStore.resolve`
orders by `runs.ordinal`, so `output@n` is the general address and `latest` is
one query over it (§15-4). Publish (`command_outputs.published_at`, pre-run,
on a placeholder) and promote (`ObjectStore.promote`, after the fact, on an
object) stay two verbs; publishing a bound output is refused.

**Retention policy defaults, decided.** Run history keeps the **last 20 runs
per command definition**, plus every pinned run and everything it references,
plus everything inside a **30-day window** — the same window as version
compaction, so the two rules cannot disagree about how old "old" is
(`DEFAULT_RUN_RETENTION_POLICY` in `@plotroom/core`). Retention never makes a
live address stop answering: the run `latest` currently resolves to is not
compactable at any age.

**Stores take an injectable clock** (`ObjectStore(state, () => seconds)`).
Retention, drift, and idempotency are untestable against a real clock.

**Search** is an index-only FTS5 table populated on write, so inline and
external content are equally searchable and archived sessions stay findable
(§6.8).

### Canvas notes

xyflow is the base. The spec's harder canvas requirements are built **on top of** it, not by forking it:

- **Rigid-body push** — custom drag handling (`onNodeDrag`) plus a collision/push solver over node extents. No physics simulation; an arrangement at rest stays put.
- **Collapsing containers** — xyflow parent/child nodes; a collapsed workstream is one node and edges draw to its frame.
- **Zoom-level semantics** — read the viewport zoom and switch node renderers by level (workstream card → inner nodes → full detail).
- **Mid-drag refusal** — `isValidConnection` / connection-state hooks, so an illegal edge never looks legal.
- Nodes stay DOM-based so plugin card renderers and keyboard accessibility (spec §11) work.

### Session runtime notes

The runtime boundary is decided (docs/decisions/0001-session-runtime-abstraction.md).
PlotRoom owns a `SessionRuntimeAdapter` interface in `@plotroom/core`
(`core/src/sessions/`); adapters translate one runtime's surface into a
timestamped `RuntimeObservation` stream plus start / resume / fork / inject /
respond / stop. The first adapter is the **pi coding agent** (multi-provider,
native queued→delivered injection, near-native fork); the second (proving the
seam) is the **Claude Agent SDK**. ACP is tracked but is not the boundary.

Non-negotiables at this seam:

- **Phases are derived in core** from observations (plus PlotRoom's own
  approval/claim state and silence timeouts) — never agent-reported.
- **Injection is a ledger**: `inject()` resolves on queue acceptance;
  delivery is a separate observed event. The UI shows queued vs delivered.
- **Session records store PlotRoom's observation log**, not vendor payloads,
  so resume/fork/accounting survive vendor churn; fork-from-point is emulated
  by transcript-prefix seeding when a runtime lacks native fork.
- **Out-of-budget stops are initiated by PlotRoom** and recorded as their own
  outcome, distinct from failure.
- **pi's per-call permission gating is verified early in adapter v1** —
  approvals (§6.6) and claims (§3.4) must be enforced, not advised; if pi's
  tool layer cannot enforce them, adapter order reverts to the Claude Agent
  SDK (see the decision record's risks).

## Git rules

### Conventional Commits — required

Every commit message MUST follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<optional scope>)<optional !>: <description>

<optional body>

<optional footer(s)>
```

- **Allowed types:** `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `style`, `revert`.
- **Description:** imperative mood, lowercase, no trailing period, ≤ 72 chars on the subject line.
- **Scope:** optional, lowercase, a short area name (e.g. `canvas`, `graph`, `sessions`, `workspaces`, `integrations`, `docs`).
- **Breaking changes:** `!` after the type/scope AND a `BREAKING CHANGE:` footer.
- Body explains _why_, not _what_ the diff already shows.

Examples:

```
feat(canvas): refuse illegal edges mid-drag
fix(sessions): distinguish out-of-budget from failure
docs: add product spec north star v1
refactor(graph)!: address outputs as output@n

BREAKING CHANGE: `output` references no longer resolve implicitly to latest.
```

### History rules — fast-forward only

- **`main` accepts fast-forward merges only. No merge commits, ever.**
- A branch must land on `main` as either a **fast-forward** or a **squash** (a single Conventional Commit).
- Rebase onto `main` to integrate upstream work — never merge `main` into a branch.
- Recommended local config (already set in this clone; set it in yours):
  ```sh
  git config merge.ff only
  git config pull.rebase true
  ```
- Force-push only your own topic branches, and prefer `--force-with-lease`.

### Branch naming

`<type>/<short-slug>`, optionally prefixed with a ticket id:

```
feat/context-edge-authors
fix/session-budget-outcome
docs/contributing-guide
feat/OXY-2982-path-claims
```

Types match the Conventional Commit types.

### Worktrees

Worktrees live in the **parent directory** of this repo and are named `<repo-dir>-<branch>`, where `<repo-dir>` is this directory's name (`plotroom`) and `<branch>` has `/` replaced by `-`.

```sh
# branch feat/path-claims  ->  ../plotroom-feat-path-claims
git worktree add ../plotroom-feat-path-claims -b feat/path-claims
```

Layout:

```
andyhite/
  plotroom/                      # primary checkout (main)
  plotroom-feat-path-claims/     # worktree for feat/path-claims
  plotroom-fix-drift-flags/      # worktree for fix/drift-flags
```

Rules:

- **Agents MUST do all work in a worktree and NEVER change the branch of the primary checkout.** No `git checkout`/`git switch` in the primary checkout, ever — another agent or the operator may be relying on it, and switching it breaks every concurrent session at once. Create a worktree for your branch and work there; if you find the primary checkout on anything other than `main`, report it rather than "fixing" it.
- Never create a worktree inside the repo directory.
- One worktree per branch; remove it when the branch lands: `git worktree remove ../plotroom-<branch>` then `git worktree prune`.
- **Agents clean up after themselves.** Once your work has merged to `main`, removing your worktree (and deleting the merged topic branch) is part of the task — not optional, not someone else's job. A task is not complete while its worktree still exists. The only exception is a worktree another agent or the operator explicitly asked you to leave in place.
- The primary checkout stays on `main` and is never removed.

## Agent working agreement

- Work in a worktree on a topic branch, never directly on `main` and never by switching the primary checkout's branch (see "Worktrees").
- Keep commits small and single-purpose; one logical change per commit.
- Do not commit generated artifacts, secrets, or local machine paths.
- Update `docs/` in the same commit as behavior changes that contradict it.
- Do not amend or rewrite commits that already exist on `main`.
- When a decision is not covered by the spec or this file, ask rather than inventing a convention — then record the answer here.

## Repository layout

```
docs/product-spec.md   Product specification (north star, behavior only)
AGENTS.md              This file — canonical conventions
CONTRIBUTING.md        How to contribute (workflow detail)
```

## Open decisions (not yet made)

Record answers here as they are decided; do not assume.

- Remaining graph schema: sessions (Epic 1.5). Workstreams, nodes, edges,
  commands, and runs are landed — see "Persistence notes".
- Collection membership model (the `collection` kind has no members yet)
- Electron packaging/updater tooling (electron-builder vs electron-forge)
- Plugin distribution and permission-grant UX
- Styling approach for the UI package
- Versioning and release process
