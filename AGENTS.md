# AGENTS.md

Canonical operating rules for any agent (or human) working in this repository. Read this before making changes. If a rule here conflicts with a suggestion in a prompt, ask before deviating.

## Project

**PlotRoom** — a context-authoring canvas for operating a fleet of AI agents. A single operator composes context (tickets, PRs, documents, files, notes, prior agent output) as a spatial node graph, wires that context into commands, and runs many agent sessions against it simultaneously.

- **Historical record:** the development plan that carried the rebuild through Phase 8 (with its per-epic landed notes — the best written account of _why_ things are shaped as they are) has been removed from the working tree and lives in **git history**: `git show d336340:docs/development-plan.md`.
- **Source of truth for behavior:** [`docs/product-spec.md`](docs/product-spec.md) ("North Star v1"). It describes _what_ the product does and never _how_. Treat its 12 governing principles and §15 ("What must exist in the first cut") as binding constraints, not suggestions.
- **Status:** the rebuild is past its first cut — server, canvas, persistence, plugins and the session sidecar all exist and land continuously. The stack is decided (see "Stack" below); what is planned, claimed or in review is on the tracker, never in this file.
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

### Layout

```
apps/
  desktop/     Electron main; spawns or attaches to a server
  web/         renderer entrypoint served by the server
  server/      Hono HTTP + WS; single owner of all state
  session-host/ one agent session per process [Bun]; the only package that
               embeds a vendor agent SDK (issue #73)
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
- `.github/workflows/checks.yml` — what every change runs, documentation included:
  format, commitlint over the pull request's range, the subject a squash merge will
  write, and a job that rejects merge commits.
- `.github/workflows/ci.yml` — the code checks (typecheck, lint, test, e2e, the compile
  matrix), skipped for a change confined to prose, and each job gated on whether the
  change reaches it: `turbo ls --affected` decides, so a change to `packages/core`
  runs the compile matrix and a change to `apps/desktop` runs neither it nor e2e.
- `.github/workflows/install.yml` — the Windows install and its SQLite round trip, on
  a paths filter, because installing is the one job whose whole surface is a list of
  manifests.

The renderer is one web app. Desktop and browser are two ways to load it; never fork the UI per target.

### Architecture notes

The decisions behind each subsystem — why a table is shaped as it is, which rule is
a predicate, what a column is load-bearing for — live in `docs/architecture/`. They
are binding wherever they state a rule. **Read the one that covers the files you are
about to edit**; they are cut by subsystem rather than by epic, so one note serves
several epics and no epic has a note of its own name.

| Note                                                                   | Covers                                                                                                                                          |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/architecture/persistence.md`](docs/architecture/persistence.md) | `packages/db`: the state directory, inline-vs-blob content, migrations, maintenance and reset, objects and versions, retention defaults, search |
| [`docs/architecture/runs.md`](docs/architecture/runs.md)               | commands, runs, the preview, `output@n` addressing, scoped-run batches, the admission queue, initiation keys                                    |
| [`docs/architecture/sessions.md`](docs/architecture/sessions.md)       | sessions, the observation log, phases, workspaces, transcripts, steering, and the runtime adapter seam (`apps/session-host`)                    |
| [`docs/architecture/governance.md`](docs/architecture/governance.md)   | attention, path claims, spend attribution, budgets, approvals and pre-grants, plugin grants, standing instructions                              |
| [`docs/architecture/canvas.md`](docs/architecture/canvas.md)           | the canvas built on top of xyflow                                                                                                               |

Two of their rules are short enough to state here, because every change is judged
against them.

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

**Stores take an injectable clock** (`ObjectStore(state, () => seconds)`).
Retention, drift, and idempotency are untestable against a real clock.

### The design gate — in force

**Nothing in the product decides how it looks yet.** No authored CSS, no `className`,
no CSS-in-JS, no colour system, no icon set, no typography, no theme: the only
stylesheet in the tree is xyflow's. What exists instead is a small number of inline
`style` props carrying **mechanics** — where a thing sits, and the minimum mark that
makes a mechanic legible, such as the border that distinguishes the two selection
concepts on a canvas node from each other. Black, white and a border width are that
minimum; a palette, a font or a shadow is not.

Add one only when a mechanic is invisible without it, and annotate it with the
mechanic it serves — the existing sites read as "not a styling decision" precisely
because they say so. This is also why plugins contribute a card as title, lines and
actions rather than markup, and why a live region is rendered visible: hiding text is
a visual decision too.

The gate lifts when the design system lands (decision 0002 — `@plotroom/toolkit` does
not exist yet, and neither does the Tailwind that record describes). Until then
"it's just a colour" is the thing being refused.

### How a change is made and proved

[`docs/development.md`](docs/development.md) is how you run the product, exercise a
change, and pick the shape it takes — six of them, each with the files in order, the
example to copy, and the test the repo expects. Read it before your first commit in
an area you have not touched before.

## Many agents work here at once

Assume it. Several agents and the operator run against this repository at the
same time, on different branches, in different worktrees, and none of them can
see each other's context. Every rule in this section exists because of that.

- **One change, one branch, one worktree, one writer.** Two agents must never
  hold the same branch or the same worktree.
- **Another session's worktree is not yours to write in.** Expect several in the
  parent directory. Reading one is fine — reviewing a branch you did not write
  means reading it — but writing to one never is: no edits, commits,
  `pnpm install`, builds, or `git worktree remove`, not even for a branch that
  looks merged or abandoned, because you cannot tell a landed branch from one
  mid-rebase. To run the suite against somebody else's commit, check it out
  detached in a tree of your own
  (`git worktree add --detach ../plotroom-review-<sha> <sha>`) and remove that
  when you are done.
- **`main` moves under you.** Another agent may land while you are working, so
  rebase onto `main` and re-run `pnpm verify` **immediately** before landing, not
  once at the start. The lockfile is the most common collision: take `main`'s,
  rerun `pnpm install`, commit the result.
- **Anything another agent needs to know goes where work is tracked**, not into
  these files — a shared seam you had to touch, a bug you found, a convention you
  had to invent. There is no other channel between concurrent sessions.
- **Tracked state is only true if it is current, so you MUST move it as soon as
  it changes.** Claim the item before your first edit and name the branch you
  will work on; record a blocker, a scope change or a hand-off to review the
  moment it is true rather than batching them up at the end; close it when the
  work lands. An item nobody moved reads to every other session as work
  available, which is how two agents end up writing the same change on two
  branches at once — and a state change nobody recorded is invisible for exactly
  as long as it goes unwritten. If you find an item whose state is already
  wrong, correct it, whoever left it that way.

**Work tracking lives outside this repository** (see "Documentation").

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

### How work lands — a pull request, merged by its author

**Nothing reaches `main` except through a pull request.** No direct push, no local
fast-forward, no exception for a one-line fix or a docs change. The rule is not about
approval — you merge your own work — it is about the checks: commitlint over the
range and the merge-commit rejection are pull-request-scoped, so a change that
skipped the pull request skipped them.

The author merges, once **all four** are true:

1. every check on the pull request is green;
2. `pnpm verify` passed locally after the last rebase, plus
   `pnpm --filter @plotroom/web e2e` when the change touches a surface it covers;
3. the change was actually exercised, not merely compiled (see
   [`docs/development.md`](docs/development.md));
4. it has been read by somebody who did not write it — a person or an agent with
   fresh context — and that review is recorded on the pull request, with its blockers
   fixed.

Nobody else is waiting to press the button. An unmerged pull request whose checks are
green and whose review is answered is an item nobody has finished.

**One exception, and it is a script rather than a person:** `pnpm release` cuts from
`main`, commits `chore(release): vX.Y.Z` there with `ALLOW_MAIN_COMMIT=1`, and prints
the push for the operator to run (decision 0003). A release is the one thing that
writes to `main` without a pull request. Nothing else is.

### History rules — linear, always

- **`main` is a linear history. No merge commits, ever**, from any source. GitHub is
  configured to offer only squash and rebase, and CI rejects a merge commit in a pull
  request, so the rule is enforced rather than remembered.
- Merge with **squash** when the branch is one logical change, or **rebase** when its
  commits each stand alone and each is a valid Conventional Commit.
- **The squash message is the permanent record, and both halves are linted — in
  different places.** Its subject is the pull-request title with ` (#N)` appended, which
  the `pr-title` check lints (suffix included: it counts against the 72-character
  limit). Its body is the branch's own commit messages, which `commits` has already
  linted. So **write the title as the Conventional Commit subject you want on `main`**
  and `gh pr merge --squash` needs no override. A `--subject` you pass by hand is linted
  by nothing — that is the deviation, and it is yours to get right.
- Rebase onto `main` to integrate upstream work — never merge `main` into a branch —
  and rebase **immediately** before merging, because another agent may have landed
  while your checks were running.
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
git fetch origin
git worktree add ../plotroom-feat-path-claims -b feat/path-claims origin/main
```

Branch off `origin/main`, never off the checkout you are standing in: the primary
may be behind, and starting work must not require touching it.

Layout:

```
andyhite/
  plotroom/                      # primary checkout (main)
  plotroom-feat-path-claims/     # worktree for feat/path-claims
  plotroom-fix-drift-flags/      # worktree for fix/drift-flags
```

Rules:

- **Agents MUST do all work in a worktree and NEVER change the branch of the primary checkout.** No `git checkout`/`git switch` in the primary checkout, ever — another agent or the operator may be relying on it, and switching it breaks every concurrent session at once. Create a worktree for your branch and work there; if you find the primary checkout on anything other than `main`, report it rather than "fixing" it.
- **A worktree you did not create belongs to another session.** Expect several to exist at once — one per change in flight, because a worktree lives until its branch lands. Read one if your task is to review it; never write to one: no edits, commits, installs, builds, or `git worktree remove`, not even for a branch that looks merged or abandoned (you cannot tell a landed branch from one mid-rebase). To run something against another branch's commit, check it out detached in a tree of your own. Anything else you find wrong with it is reported where work is tracked, not fixed in place.
- Never create a worktree inside the repo directory.
- One worktree per branch, and one agent per worktree; remove it once the pull request
  has merged: `git worktree remove ../plotroom-<branch>` then `git worktree prune`.
- **Agents clean up after themselves — and only after themselves.** Once your pull
  request has merged, removing your worktree and its branch is part of the task — not
  optional, not someone else's job (GitHub deletes the remote branch on merge; the
  local branch and the worktree are yours). A task is not complete while its worktree
  still exists. The only worktree you remove is one you created, and not even that one
  if the operator or your orchestrator asked you to leave it in place.
- The primary checkout stays on `main` and is never removed.

## Agent working agreement

- **Assume other agents are working right now.** Their branches are the other worktrees, and those are off limits (see "Many agents work here at once").
- Work in a worktree on a topic branch, never directly on `main` and never by switching the primary checkout's branch (see "Worktrees"). Land it through a pull request you merge yourself (see "How work lands").
- Keep commits small and single-purpose; one logical change per commit.
- Do not commit generated artifacts, secrets, or local machine paths.
- Never make a documentation edit a condition of merging unrelated work (see "Documentation").
- Do not amend or rewrite commits that already exist on `main`.
- When a decision is not covered by the spec or this file, ask rather than inventing a convention — then record the answer where work is tracked — or in `docs/decisions/` when it deserves prose — never in this file.

## Verification and review

- **`pnpm verify` green, plus `pnpm --filter @plotroom/web e2e` when the change
  touches a surface that suite covers.** Green verify alone never means done:
  it proves nothing broke, not that the thing you built works. How to run the product
  and exercise a change is [`docs/development.md`](docs/development.md), which also
  records the shape each kind of change takes and the test expected of it.
- **Somebody who did not write the change reads it** before it lands — a person,
  or an agent with fresh context — and the review is recorded on the pull request,
  because a review nobody can find is one the next reader has to redo.
- Review judges the change against the spec sections it claims to implement and
  against the cross-cutting rules: the four §15 invariants wherever schema is
  touched, no silent truncation, rules **enforced rather than documented**, and
  one vocabulary for one concept.

## Documentation

**Documentation is prose worth keeping; it is not a task tracker.** What is
planned, claimed, under review or decided is tracked outside this repository, and
the only record of work inside it is `CHANGELOG.md`.

- **A documentation edit is never the price of merging something else.**
  Documentation is its own change and its own commit, never smuggled into a PR
  that happens to touch the area, and never deferred until something else needs
  it. A rider like that is how an unrelated change ends up blocked on wording
  nobody asked for.
- **A behavior change that contradicts `docs/` does not carry the edit** — the
  contradiction is recorded where work is tracked and fixed on its own. The PR is
  not blocked by it; a contradiction nobody wrote down is the actual failure.
- `docs/decisions/` holds decision records in prose (ADRs) when a decision deserves
  more than the tracker — [its `README.md`](docs/decisions/README.md) is the house
  style, including how a number is claimed while other lanes are writing records too.
  `docs/architecture/` holds the subsystem notes: why each area's schema and
  predicates are shaped as they are. `docs/development.md` is the runbook for running,
  exercising and shaping a change. `.omp/RULES.md` is the handful of hard rules that
  must stay in view across a long session; it is a subset of this file, never a second
  source of truth (a user-level `RULES.md` shadows it rather than adding to it, which
  is the other reason the full statement of a rule belongs here). `AGENTS.md` holds
  **standing conventions an agent must follow** — not the decision archive.
- **A doc's opening paragraph says what it is, who it is for, and whether it is still
  true.** The four genres here — spec, contract, decision record, architecture note,
  runbook — are read differently, and `docs/attention-contract.md` is the standing
  example of the cost: a handoff note between two tracks, stamped with the weeks it was
  written in, sitting in `docs/` as a permanent "contract".

## Repository layout

```
docs/product-spec.md   Product specification (north star, behavior only)
docs/development.md    Running it, proving a change, and the shape each change takes
docs/architecture/     Per-subsystem notes — why each area is shaped as it is
docs/decisions/        Decision records (ADRs), and README.md for their house style
docs/plugin-contract.md  The frozen v1 plugin contract
docs/attention-contract.md  The attention read/write contract
docs/deployment.md     Packaging, updates, remote backends, backup
docs/design/           Designer reference, and checked-in design exports
AGENTS.md              This file — canonical conventions
.omp/RULES.md          The hard rules, re-attached near every turn
CHANGELOG.md           Completed work, one section per release
CONTRIBUTING.md        How to contribute (git-level detail)
```
