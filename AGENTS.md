# PlotRoom — repository guide

PlotRoom is a **context-authoring canvas for operating a fleet of AI agents**:
an operator composes context as a spatial node graph, wires it into commands,
and runs many agent sessions against it at once. `docs/product-spec.md` is the
definitive statement of what the product is and how it behaves — every change
is judged against it, and a proposal that violates one of its governing
principles is an amendment to the thesis, not a feature.

`.omp/RULES.md` holds the hard rules. This file is the background: layout,
toolchain, conventions, and the delivery workflow. The workflow itself — the
tracker, worktrees, the dev loop, verification, the QA gate, stacked PRs — is
provided by the **foreman** extension (`/foreman:help`); read the relevant
`skill://` before acting, don't improvise from memory.

## Documentation

`docs/` is the canonical product documentation — the layer beneath the spec:
geography, state machines, derivations, and boundary contracts. Read the doc
that owns your subject before reading code; when a doc disagrees with the
tree, the doc is stale — file it.

| When you need…                                                                               | Read                           |
| -------------------------------------------------------------------------------------------- | ------------------------------ |
| What the product is and how it behaves — every change is judged against it                   | `docs/product-spec.md`         |
| Persisted records, identity, versions and retention, output addressing, deletion/recovery    | `docs/data-model.md`           |
| A rule and its predicate — actors, lineage/reflexivity, claims, approvals, budgets, legality | `docs/enforcement.md`          |
| How a session runs — launch, phases, plan, injection/questions/broadcast, end states, forks  | `docs/session-lifecycle.md`    |
| How a run happens — preview, queue admission, assembly, proof, history/pinning               | `docs/run-lifecycle.md`        |
| The attention system — feeds, ranking, triage, health alerts, outbound routing               | `docs/attention-derivation.md` |
| The session-host/runtime seam — observations, pinned tools, configuration fidelity           | `docs/runtime-boundary.md`     |
| Building or changing a plugin                                                                | `docs/plugin-authoring.md`     |
| HTTP/WS protocol, the actor header, the event stream, adding a new gesture                   | `docs/interface-contract.md`   |
| Running, configuring, or operating the product                                               | `docs/operations.md`           |
| User-facing copy — the state vocabulary and what the product never says                      | `docs/product-voice.md`        |

## Layout

| Path                  | Package                  | What it is                                                                                               |
| --------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `apps/web`            | `@plotroom/web`          | React 19 + Vite canvas UI; the Playwright e2e gate lives in `apps/web/e2e`                               |
| `apps/server`         | `@plotroom/server`       | The HTTP API server the web app and desktop shell talk to                                                |
| `apps/session-host`   | `@plotroom/session-host` | Bun sidecar embedding omp as the session runtime; tests run under `bun test`; ships as a compiled binary |
| `apps/desktop`        | `@plotroom/desktop`      | Electron desktop shell (spawn-or-attach to a local server, or a remembered remote backend)               |
| `packages/core`       | `@plotroom/core`         | Domain model and **rule predicates** — every product rule lives here once, called by every surface       |
| `packages/db`         | `@plotroom/db`           | Persistence (drizzle-orm over `bun:sqlite`); its suite runs under `bun test`                             |
| `packages/toolkit`    | `@plotroom/toolkit`      | Design tokens and theme; `theme.generated.css` is generated — never hand-edit it                         |
| `packages/ui`         | `@plotroom/ui`           | Shared UI components (panels, conversation surfaces)                                                     |
| `packages/plugin-sdk` | `@plotroom/plugin-sdk`   | SDK plugins are built against                                                                            |
| `packages/plugins/*`  | `@plotroom/plugin-*`     | Integrations (`filesystem`, `git`, `github`, `jira`) — they populate core concepts, never add new ones   |
| `scripts/`            | —                        | Repo tooling and the release script; outside the turbo graph, checked by `bun check:scripts`             |

## Toolchain and commands

Bun 1.3.14 (`packageManager` pinned, `bun.lock`), Node ≥ 22.18, turborepo,
vitest (`apps/session-host` and `packages/db` use `bun test`), oxlint
(`--type-aware`) for `lint` plus an ESLint flat config for `lint:arch`,
`tsgo` (TypeScript native preview) for typecheck, Prettier, husky +
commitlint.

| Command                              | What it does                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `bun dev`                            | Dev servers via turbo                                                         |
| `bun build`                          | Build everything (only `web`, `toolkit`, `desktop` emit artifacts)            |
| `bun check`                          | `turbo run typecheck lint lint:arch test` (add `--filter=<pkg>`)              |
| `bun check:scripts`                  | Lint + test for `scripts/`                                                    |
| `bun verify`                         | `format:check` + `check` + `check:scripts` — the pre-PR gate                  |
| `bun run --filter=@plotroom/web e2e` | The Playwright e2e gate (`bunx turbo run build --filter=@plotroom/web` first) |
| `bun compile`                        | Compile the session-host binary and run its smoke test                        |
| `bun format`                         | Prettier over the repo                                                        |

Nothing but `web`, `toolkit`, and `desktop` emits a `dist/` (#315): every
other package exports raw TS, and `typecheck` is one root-scoped `tsgo` run
over the whole workspace rather than a per-package `tsc -b`. `skill://verification`
has the full ladder from per-file feedback to the pre-PR gate.

## Git conventions

- **Branches:** `<type>/<slug>`, enforced by the pre-commit hook. Types:
  `feat fix docs refactor perf test build ci chore style revert`. Issue work
  uses `<type>/<issue>-<slug>` (e.g. `fix/291-actor-identity-gate`) in a
  worktree named `plotroom-<issue>-<slug>`, a sibling of the primary checkout —
  see `skill://worktree`.
- **Commits:** Conventional Commits, enforced by commitlint — header ≤ 72
  chars, lower-case subject, no trailing period, kebab-case scope, body lines
  ≤ 100. One logical change per commit.
- **Hooks:** pre-commit refuses commits on `main` (the `ALLOW_MAIN_COMMIT=1`
  override is the operator's, never an agent's), checks the branch name, and
  runs `bun format:check` over the whole repo; commit-msg runs commitlint.
- **`main` is linear and never rewritten.** Nothing reaches it except a pull
  request, squashed or fast-forwarded after a rebase onto `origin/main`.
- **Merging is the operator's, unless the operator hands it over.** By
  default an agent opens the PR and stops: the merge is the approval, and an
  operator comment on an open PR is a change request, not a green light. When
  the operator does say to merge, merge — that instruction _is_ the approval,
  and bouncing it back is not caution, it's noise. The okay is per-request
  and never assumed: it is not implied by green CI, by the change looking
  trivial, by silence, or by having been given on an earlier PR.

## CI

- `ci.yml` — code checks scoped by `turbo --affected`: one job runs
  `bun check` + `bun check:scripts`; the e2e gate runs when `@plotroom/web`
  is affected; the session-host binary matrix runs when it is.
- `install.yml` — a frozen-lockfile install, the `@plotroom/db` suite, and the
  FTS5 probe on all three OSes; triggered by manifest/lockfile/`packages/db`
  changes.
- `spike.yml` — the omp SDK spike suite against a real model; nightly and on a
  session-host pin bump.
- `checks.yml` — formatting, commit messages, and history shape; runs on every
  change with no path filter.
- Documentation-shaped paths (`docs/**`, root `*.md`, `.omp/**`,
  `.github/**/*.md`) skip `ci.yml` entirely. Markdown anywhere else is code.

## Delivery workflow

Work is tracked in GitHub Issues on the **PlotRoom project board** (project
`#1`, statuses `Backlog → To Do → In Progress → Review → Done`, plus
`Rejected`), driven by the **foreman** extension. `skill://tracker` holds the
canonical lifecycle, label vocabulary, and the exact `gh` recipes; the board
IDs, label names, commit types, and check/verify/e2e commands foreman uses for
this repo live in `.omp/foreman.json`, written by `/foreman:init`. Treat those
two together as the single source of truth for anything tracker-shaped — and
run `/foreman:doctor` when one of them stops matching GitHub.

The shape: **ideas** (label `idea`) are recorded cheaply and groomed later into
an **epic** or a **task** — or rejected. **Tasks** are small, single-PR units;
anything bigger is an epic broken into task sub-issues. **Bugs** keep a
severity-suffixed label (`bug:sev0`–`bug:sev3`) for life and skip the idea
stage. Epics derive their status from their subtasks, and chains of dependent
subtasks ship as **stacked pull requests** (`skill://stacked-prs`) so review
never blocks the next layer.

| To…                         | Use                                                  |
| --------------------------- | ---------------------------------------------------- |
| Record an idea              | `/foreman:record <note>` — or `skill://tracker`      |
| File and triage a bug       | `/foreman:triage <report>` — or `skill://bug-triage` |
| Groom ideas and the backlog | `/foreman:groom [issue]` — `skill://grooming`        |
| Deliver a task or bug       | `/foreman:work <issue>` — `skill://dev-loop`         |
| Deliver an epic             | `/foreman:orchestrate <epic>` — `skill://epic-loop`  |
| Snapshot the board          | `/foreman:report`                                    |
| Explain any of the above    | `/foreman:help [command\|skill\|agent]`              |

Foreman agents: `planner` (read-only implementation planning), `qa` (the QA
gate — independent review plus e2e coverage), `issue-worker` (executes the
full dev loop for one issue; what the epic orchestrator dispatches).

## Working alongside others

Several agents and the operator work this repository concurrently, in separate
worktrees, none seeing the others' context. The board is the only shared
memory: claim before you edit, record blockers when they become true, close
when the work lands. A worktree you did not create belongs to another session —
read it if you are reviewing it; never edit, install, build, or remove it.
