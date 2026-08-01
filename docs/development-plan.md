# PlotRoom — Development Plan

**Status:** Working plan v1 · derived from [`product-spec.md`](product-spec.md) (North Star v1)
**Purpose:** sequence the ground-up rebuild as phases → epics → tasks. This document describes _order and scope of work_; behavior remains defined solely by the product spec. When this plan and the spec disagree, the spec wins.

Conventions used below:

- **Phase** — a milestone with a demonstrable outcome ("exit criteria").
- **Epic** — a coherent body of work inside a phase, sized for one topic branch or a small series of them. Suggested scope names (for Conventional Commit scopes) are given per epic.
- **Task** — a unit of work small enough to be one or a few commits.
- Spec references (`§n`) point at the product spec. The four **§15 invariants** are called out wherever they constrain a task; they are schema-shaped and must be right in Phase 1, not retrofitted.

Dependency rule of thumb: each phase depends on the previous ones, but epics within a phase are mostly parallelizable. Where a cross-phase dependency exists it is stated.

---

## Phase 0 — Foundation (complete / in flight)

**Goal:** a monorepo where every later phase has a home, with enforcement wired so conventions cannot drift.

**Exit criteria:** `pnpm verify` green in CI; all packages build with project references; hooks enforce branch/commit rules.

### Epic 0.1 — Workspace scaffolding (`build`, `ci`) — _done_

- [x] pnpm workspaces + Turborepo layout (`apps/desktop`, `apps/web`, `apps/server`, `packages/core`, `packages/db`, `packages/plugin-sdk`, `packages/ui`)
- [x] TypeScript strict, project references, per-package `dist/.tsbuildinfo`
- [x] ESLint + Prettier, Vitest, commitlint + husky
- [x] CI: format, typecheck, lint, test, commitlint, merge-commit rejection

### Epic 0.2 — Persistence bootstrap (`db`) — _done_

- [x] SQLite client + Drizzle wiring, migration runner, DB file location strategy (§12: single portable file)
- [x] Blob store for large content — transcripts, assembled content, diffs — kept out of hot rows (AGENTS.md persistence notes; decision: hybrid blob store, recorded in AGENTS.md)
- [x] FTS5 search scaffolding (§6.8)
- [x] Unit test harness for schema/migrations

---

## Phase 1 — The model: schema and core domain

**Goal:** the data model that everything else renders. This is where the four §15 invariants land; nothing user-visible yet.

**Exit criteria:** `@plotroom/core` exposes a typed API over objects, versions, edges, workstreams, runs, and sessions, fully unit-tested; the schema satisfies all four §15 invariants by construction (asserted in tests, e.g. `NOT NULL` author on edges).

### Epic 1.1 — Objects, content, and versions (`graph`) — _done_

- [x] Object table: first-class concepts as one generic object kind — ticket, PR, review, document, diff, commit, note, transcript, collection (§3.1); external identity that survives re-reads (reconcile, never duplicate)
- [x] Three renderings contract per object: card, compact summary, agent-ready content (§3.2) — stored/derivable, supplied by the producer
- [x] Version model: every content change is a new version; deltas ("what's new") expressible per kind, full content as fallback (§3.2)
- [x] **§15-3: retention metadata on versions** — run-referenced flag, compaction window, pin propagation — so the compaction rule is implementable from day one (§3.2, §4.4)
- [x] Scope: world vs local objects; promote-to-world as a first-class operation (§3.2)
- [x] Last-known content survives source loss/restart, bounded to placed objects (§3.2)

_Landed as `@plotroom/core` object/version/rendering types plus `ObjectStore` in
`@plotroom/db`. The compaction rule is a pure predicate (`isCompactable`) so it
can be asserted directly; the store applies the same rule in SQL. Deferred: the
`collection` kind has a type but no membership model yet — it lands with the
collection expand/prune gesture (Epic 3.3)._

### Epic 1.2 — Edges and authorship (`graph`) — _done_

- [x] Context edges: ordered inputs into a command or running session (§3.5, §3.7)
- [x] **§15-2: `edges.author_id NOT NULL`**, distinguishing human vs session authors (§3.7, principle 1)
- [x] Provenance edges: recorded automatically with meaning — command → session, session → created object, sibling/fork/handoff relations (§3.7); never authored
- [x] Legal-connection rules as a core predicate: content → command, content → running session, nothing else (§3.7) — one function the canvas, the API, and agent tools all call
- [x] Command-topology acyclicity check (transitive; sessions exempt) (§3.7)
- [x] Lineage model: initiation chains, ancestor/descendant queries — the enforcement substrate for principle 1's reflexivity rule (§2.1, §2.8)

_Predicates (`checkConnection`, `wouldCycle`, `checkAuthoring`) live in
`@plotroom/core`; `GraphStore` in `@plotroom/db` calls them and adds duplicate
refusal and soft delete. Authorship is enforced twice: the predicate refuses,
and the schema cannot represent an unattributed context edge. Deferred: cycle
detection rebuilds the command graph per insert — fine at current scale,
revisit if a board gets large (Phase 2)._

### Epic 1.3 — Workstreams (`workstreams`) — _done_

- [x] Workstream entity: subject (authored, optional), lifecycle (active/done/abandoned/archived — authored, with product _suggestions_ never auto-transitions), containment of commands/sessions/local objects (§3.3)
- [x] Scope rule enforcement: objects cross boundaries as world objects; commands and sessions never do (§3.3)
- [x] Attention rollup aggregation model (computed, stored where needed for the card) (§3.3, §7)

_Landed as `checkLifecycleAuthoring`, `checkScope`, `suggestDone`, and
`rollupAttention` predicates in `@plotroom/core` plus `WorkstreamStore` in
`@plotroom/db`. `suggestDone` is pure and nothing calls it to transition;
authored mutations are attributed in `workstream_events` (schema-enforced, no
`system` author). Session-authored lifecycle changes are refused outright
until Phase 6 approvals land propose-and-accept._

### Epic 1.4 — Commands and runs (`commands`, `runs`) — _done_

- [x] Command definitions: instruction, model/effort, tool permissions, expected outcome, ask-points; user-editable content, duplicable, organizable (§3.5)
- [x] Command nodes: definition + wiring; parameters with confirm-only derived defaults (§3.5)
- [x] Producing vs open lifecycle; expected outcome as typed placeholder; world conditions as declared predicates (§3.5)
- [x] Output pre-wiring: typed placeholder outputs exist pre-run, bind post-run (§3.5)
- [x] Publish vs promote as two distinct verbs; pre-bind/post-bind two-state rule for cross-workstream wires (§3.5)
- [x] **§15-1: run history records full assembled content + configuration** — the exact ordered content and versions in, config, output, cost (§3.7, §4.4)
- [x] **§15-4: per-run output addressing** — `output@n` general case, `latest` derived (§4.4)
- [x] Run-history retention rule: last N per definition + pinned + window (§4.4)

_Landed as `CommandStore` and `RunStore` in `@plotroom/db` over migration 5,
calling predicates in `@plotroom/core` (`resolveParameters`, `checkPublish`,
`checkOutputCrossing`, `effectOfDeletingProducer`, `checkContentBudget`,
`checkSubmission`, `isRunCompactable`); wiring goes through `GraphStore`, so
`wouldCycle` is reused rather than restated and a placeholder wired before any
run is already part of the topology it checks. Four §3.5 rules are schema
constraints — producing⇔outcome, a proposal cannot carry a confirmation, a
bound output cannot break, and `runs.assembled_blob_id`/`config_json` are NOT
NULL — and `run_inputs.version_id` is a real foreign key, so compaction cannot
eat run history even from outside the store. There is no `latest` column
anywhere: `RunStore.resolve` orders by `runs.ordinal`. Retention defaults (last
20 runs per definition, 30-day window) are recorded in AGENTS.md per
cross-cutting rule 5. Deferred: no transactions around multi-statement writes
(`start`, `complete`, `compactRuns`, `instantiate`); a soft-deleted command is
still runnable; `complete` records an output name matching no declared
placeholder without warning._

### Epic 1.0 — Primitives (`core`) — _done_

_Small, but every later epic assumes them; idempotency and retention tests are
untestable without an injectable clock._

- [x] Id generation and branded id types (partly in place)
- [x] Injectable clock, threaded through stores (partly in place: `ObjectStore`)
- [x] Test fixtures/factories for objects, versions, workstreams, runs

_Fixtures live at `@plotroom/core/testing` (subpath export, outside the
production API). The run factory was a placeholder until Epic 1.4 landed the
schema; `makeRun` now returns the real domain `Run`, so a fixture cannot be
built without the assembled content and configuration §15-1 requires._

### Epic 1.5 — Sessions and drift (`sessions`, `graph`) — _done_

- [x] Session entity: phases, per-session launch choices, accounting fields, end states including out-of-budget as distinct from failure (§3.6)
- [x] Transcript as content: versioned, delta = new turns; bounded with recoverable release markers (§3.6, §6.1)
- [x] Live-transcript checkpoint rule: consumers drift on session end or explicit checkpoint, never per turn (§3.6)
- [x] **Interrupted** as a distinct end state for crash/restart with sessions in flight — not stopped, not failed; resumable like any session (§3.6, principle 11)
- [x] Drift derivation: consumed-version tracking; transitive, per-consumer, cross-workstream flags; drift is a state, never an action (§3.2, §4.5)
- [x] Triage verbs on attention items: acknowledge (advance baseline), snooze, mute (§4.5)
- [x] Soft-delete/recoverability for all authored state, agent deletions included (principle 10)

_Landed as `@plotroom/core`'s `sessions/` subtree: `end-states` (the closed
taxonomy — completed, ended-by-user, stopped, out-of-budget, failed,
interrupted — behind one exhaustive `endStateFacts`, so out-of-budget is the
only outcome a retry may not blindly re-run and interrupted is neither),
`session`, `accounting` (turns/elapsed/last-activity/tokens plus a cost that
names its basis and a context-window meter that says reported or estimated),
`transcript` (three renderings, delta = new turns, largest-old-first release
behind reloadable markers, export that rehydrates or reports what it could
not), `checkpoint` (the rule as `publishesVersion` — a turn returns false),
`drift` (`deriveDrift`: direct and transitive, per consumer, cross-workstream,
pure), `triage`, and `deletion`. On top of them the Epic 4.1 seam: the
`runtime` adapter surface with `classifyEnd`, a `phases` reducer folded from
the observation log (silence surfaces as health, never as a wrong phase), the
queued→delivered `injection` ledger, `fork` planning with transcript-prefix
seeding, and adapter v1 for the pi coding agent.

C6 is verified rather than asserted: pi's tool layer **enforces** PlotRoom's
per-call decision — a `tool_call` handler blocks the call and `ctx.ui.confirm`
puts the host in the path over RPC — proved end-to-end against pi 0.83.0 by
`permission-gate.spike.test.ts` (denied call, no side effect; allowed call,
side effect), opt-in via `PLOTROOM_PI_SPIKE=1` so the default run stays
hermetic. Adapter order therefore stands.

Deferred, honestly: nothing is persisted yet — the schema for sessions,
transcripts, and drift lands with the server (Phase 2), so these are domain
entities only; spawning pi (`PiConnect`) is server-owned, keeping `core` free
of transport, with `buildPiArgs` as the contract the spike exercises against
the real binary; `SessionStatus` answers phase-level attention only, so Phase
6's attention feeds must join `endStateFacts` to surface an interrupted or
out-of-budget session; and pi has been renamed to `@earendil-works/pi-coding-agent`
(0.83.0) while decision 0001 still cites the old package name._

---

## Phase 2 — Server and API

**Goal:** the Hono server as the single owner of all state, exposing the one vocabulary both UI and agents will use (principle 8).

**Exit criteria:** every Phase 1 operation reachable over HTTP; WS pushes state changes; the renderer (Phase 3) and agent tools (Phase 4) build on this API with no side channels.

### Epic 2.1 — HTTP + WS backbone (`server`) — _done_

- [x] Hono app, route structure, error shape, request validation
- [x] WebSocket state-change stream: one event vocabulary for everything the canvas and queue render live
- [x] Operator credential: optional shared secret locally; auth required for non-local binding (§12)
- [x] Loopback-only bind by default — never `0.0.0.0` without explicit opt-in plus the credential requirement (§12)
- [x] Origin/Host validation on WebSocket upgrades and state-changing requests: loopback names always trusted, anything else requires explicit allow-listing — DNS-rebinding and drive-by-page protection that also makes SSH-tunnel access (`ssh -L`, browser at `http://localhost:<port>`) work with zero config (§12)
- [x] Structured logs: consistent shape, runtime-adjustable level, redaction (§8)

_The event vocabulary (`DomainEvent`) lives in `@plotroom/core` — created/
updated carry the full entity, deleted carries only the id — so the seam Epic
2.2's mutations publish through predates the mutations themselves; a server-
side `EventBus` assigns id/seq/occurredAt and fans out to `/ws` subscribers.
Origin/Host validation (`checkOrigin`) and the operator credential
(`checkCredential`) gate both `/api/*` and `/ws` identically, checking
`Origin` first and falling back to `Host` only when `Origin` is absent, so a
rebinding page's real origin is what gets checked, never the header an
attacker controls; loopback (`localhost`, `127.0.0.0/8`, `::1`, any port) is
always trusted, anything else needs `PLOTROOM_TRUSTED_ORIGINS`.
`checkBindPolicy` refuses to start non-loopback without both
`PLOTROOM_ALLOW_NON_LOOPBACK_BIND=1` and a configured credential.
`serveRenderer` single-origin-serves whatever `apps/web` builds (SPA fallback
to `index.html`, path-traversal-safe) on the same port as `/api` and `/ws`;
until Epic 3.0 lands a build, it reports 503 with a clear reason instead of a
silent 404, and API/WS still work. All of it is covered by unit tests on the
pure predicates plus a real-server, real-`ws`-client integration suite (43
tests total). Deferred: settings-backed configuration (env vars are the only
source until Epic 8.3; `loadServerConfig` takes explicit overrides as that
store's seam); a persisted structured-log sink (today: stdout JSON lines
only). WS reconnect replay is what `GET /api/snapshot` (Epic 2.2) now
offers: a client resyncs by connecting to `/ws` first, buffering, fetching
the snapshot, and applying only what the snapshot's `seq` says it missed._

### Epic 2.2 — Graph and workstream API (`server`, `graph`) — _done_

- [x] CRUD + verbs for objects, edges, workstreams, commands, notes — every gesture as an endpoint, because agents get the same vocabulary later (principle 8)
- [x] Authorship attribution on every mutating call (human vs session identity) — feeds §15-2
- [x] Refusal of illegal edges and self-chain authoring at the API layer (principles 1, 8: enforced, not documented)
- [x] Undo/restore endpoints for destructive operations (principle 10)

_Attribution is one mechanism, applied uniformly: the `X-PlotRoom-Actor`
header (`human`, the default, or `session:<id>`), read once for every `/api`
request rather than restated per route — attribution belongs to the caller,
and the operator credential identifies the installation (§12), not the actor.
An unparseable actor is refused, so an unattributed write has no
representation in the API any more than it has in the schema. Refusals are
not written at the API layer at all: routes call the stores, the stores call
the predicates in `@plotroom/core`, and the route reports what they said —
`409` with `code: "refused"` and the predicate's own machine-readable
`details.reason` (`illegal_target`, `source_not_content`,
`session_not_running`, `would_cycle`, `duplicate`, `own_chain`,
`session_sets_lifecycle`, `already_bound`, `node_deleted`,
`provenance_not_authored`), never a 500 and never a silent no-op; an id that
names nothing is a `404` matched on `EntityNotFound` rather than on a
message's wording. Undo is a first-class pair everywhere: `DELETE`
soft-deletes, `POST .../restore` puts it back, and `GET /api/restorable`
lists what can be — including deletions a session made. Removing a node takes
its context edges with it and restores exactly those; until it is restored it
is off the board, so placing or wiring it again is refused rather than
silently resurrecting the wiring the removal took down.
Every successful mutation publishes on the Epic 2.1 bus (the vocabulary grew
a `node` entity, since placement is a gesture too), so `/ws` sees the same
shapes the REST reads return and a refused mutation publishes nothing.
Migration 6 adds `deleted_at` to objects and workstreams and widens the
workstream attribution trail to cover deletion. Two Epic 1.4 deferrals
landed alongside: command and run writes are transactional, and a
soft-deleted command is refused a run until it is restored. `GET
/api/snapshot` landed as a follow-up: one consistent read (workstreams,
live nodes and edges, live objects, command definitions, live commands, and
every output placeholder) in the same row shapes the per-entity GETs and the
WS stream already use, plus the `EventBus`'s already-monotonic `seq` so a
client that connects to `/ws` first, buffers, then fetches the snapshot can
drop buffered events with `seq <= snapshot.seq` and apply the rest. Deferred:
sessions and runs have no endpoints yet (Epics 1.5/4.2 own them, and the
lineage a session-authored refusal reads is written by the store, not by an
API); approval-gated destruction (§6.6) — an agent may delete today, and
recoverability is the answer principle 10 gives._

### Epic 2.3 — Durability and portability (`server`, `db`) — _done_

- [x] All state in the single portable store; survives restart; backup/move story (§12)
- [x] Reset and cleanup verbs: arrangement / derived state / everything — each stating what it removes first (§12)
- [x] Version compaction **job** implementing the §15-3 rule (windowed, pin-aware) — the schema and the predicate land in Epic 1.1; this epic owns only scheduling and blob sweeping

_Landed as `Maintenance` in `@plotroom/db` plus `apps/server`'s
`maintenance/`. The portability claim is tested rather than asserted:
`durability.integration.test.ts` copies `plotroom.db` and `blobs/` to a
differently-named directory, starts a second server on a different port, and
asserts the snapshot, the arrangement, and the content are identical.
`GET /api/maintenance/state` is where that story is data — it names the one
directory to back up, what is inside it, and the derived directories
deliberately **excluded** (`workspaces/`, `git-cache/`, `runtime/`), each with
its reason; a provisioned git worktree records absolute paths, so copying one
somewhere else would move something already broken.

The cleanup verbs are a plan and an execution, never one call:
`GET /api/reset/plan?scope=` states what would go, and `POST /api/reset`
without `confirm: true` answers with that same plan and removes nothing — so
the plan is the contract (§12). `arrangement` clears authored positions and
touches no directory; `derived` reverts provisioned workspaces to
unprovisioned and deletes the checkouts and the mirror cache, keeping every
record; `everything` empties the store and says how many rows and blobs that
is first. Both halves — rows and directories — are reported in one answer.

Deleting a checkout is not lossless, so the plan says so rather than leaving
"re-provisioned at the next run" to imply it. Both scopes that delete one carry
an explicit destruction sentence, and the plan **asks git** about every
provisioned checkout first: each one holding uncommitted changes, untracked
files, or commits that were never pushed is named individually, with whether
this reset deletes its files or merely forgets it. A checkout whose status could
not be read is listed as unreadable — "we could not look" and "there is nothing
there" are different sentences, and only one of them is safe to act on.

The compaction job schedules the sweep and decides nothing else: the rules stay
`isCompactable` / `isRunCompactable` in `@plotroom/core`, and
`Maintenance.compact` sequences runs → versions → blob sweep in that order,
because run compaction is what releases a version's `run_referenced` flag and
version compaction is what drops blob references. Timers are injected
(`PLOTROOM_COMPACTION_INTERVAL_SECONDS`, default 6h, `0` disables the schedule
without disabling `POST /api/maintenance/compact`), the first sweep is after one
interval rather than at startup so a restart loop cannot sweep repeatedly, and a
failed sweep is logged and dropped rather than taken as a reason to stop
serving. Pinned and run-referenced content is never a candidate, asserted at
both levels.

---

## Phase 3 — Canvas MVP: authoring at rest

**Goal:** the graph as the primary surface. A human can place content, wire context into commands, and arrange the board — no sessions running yet. This de-risks the hardest UI work (rigid-body, zoom semantics, mid-drag refusal) before runtime complexity arrives.

**Exit criteria:** compose a multi-command topology with ordered context edges, notes, collections, and pre-wired outputs; arrangement survives restart; illegal edges are refused mid-drag.

### Epic 3.1 — Canvas foundation (`canvas`)

- [x] xyflow integration; nodes DOM-based (plugin renderers + a11y later, §11)
- [x] Rigid-body push: custom drag handling + collision/push solver over node extents; chains propagate; at-rest stays put (§5)
- [x] Durable placement across restarts; derived initial arrangement; "reset arrangement" as the only auto-layout verb (§5) — _server-side durability landed with Epic 2.3 (positions on `nodes`, `PATCH /api/arrangement`, `POST /api/reset` with `scope: "arrangement"`); the renderer still writes to `localStorage` until it adopts those endpoints_
- [x] Selection as the route: selected node reflected in the address; one navigation primitive for click/palette/queue/deep-link (§5)

_Landed unstyled per the design gate (fleet rule 5), against fixture data in
`apps/web`; mid-drag refusal wired through `isValidConnection` over
`checkConnection`. Epic 3.0's server-served renderer and Electron
spawn-or-attach wait for Phase 2 as planned. **Batch 2 close-out:**
`deriveInitialArrangement` (`packages/ui/src/placement/derive.ts`) is a pure
topological layering over the graph's own edges — the fallback for any node
with no stored placement, and the whole of "reset arrangement" (wired as a
command palette verb in `apps/web/src/App.tsx`) when re-run over every node.
Also landed as part of the same batch's Phase 3 polish: the additive canvas
sync effect now reconciles live deletions — a node/edge another client
deletes disappears from an already-open canvas (the Batch 1 finding),
distinguishing a confirmed-then-removed id from an optimistic local-only one
(`packages/ui/src/canvas/reconcile.ts`)._

### Epic 3.2 — Zoom, containers, and legibility (`canvas`) — _done (mechanics)_

- [x] Zoom-level renderers: workstream card → inner nodes → full detail (§5)
- [x] Collapsing workstream containers; edges draw to collapsed frames (§3.3, §5)
- [x] Minimap, legend, live counts; multi-select with contextual action bar (§5)
- [x] Off-screen attention markers with clustering (§5) — visuals now, fed by real attention in Phase 6

_Landed unstyled per the design gate (fleet rule 5), fixture-driven until
Sync 2: `zoomLevelForScale` drives per-node renderers; containers force-
collapse to one card at workstream zoom (`effectiveCollapsedContainers`) and
edges remap to the frame (`remapEdgesForCollapse`); minimap/legend/live
counts; xyflow-native marquee/shift multi-select feeding a role-filtered
action bar; off-screen markers clustered by compass sector. Deferred:
attention-marker coordinates for container children; within-container
rigid-body push._

### Epic 3.3 — Authoring gestures (`canvas`) — _done (mechanics)_

- [x] Edge drag with mid-drag refusal via `isValidConnection` over the core legality predicate (§3.7, §5)
- [x] Drag-to-empty-canvas create menu, filtered to legal targets (§5)
- [x] Ordered context inputs, rearrangeable by drag (§3.5)
- [x] One-gesture flows: definition-onto-ticket creates a workstream (workspace deferred to first run) (§3.5); collection expand/prune/drag-out (§3.1)
- [x] Notes: create, edit (new version → drift), promote (§3.8)
- [x] Undo for destructive canvas operations (§5, principle 10)

_All gestures call the core predicates (`checkConnection` for mid-drag
refusal and create-menu filtering — never a forked rule) and every authored
edge carries an author (§15-2). Notes and the one-gesture workstream flow are
fixture-layer models mirroring `@plotroom/core` shapes until the server API
lands (Sync 2). Deferred, recorded: undo of rigid-body push displacement
(§5's "restores what it pushed"); surfacing deletion/creation to the host so
props stay the source of truth; create-menu positioning in non-origin host
layouts._

### Epic 3.4 — Palette and shell basics (`ui`, `app`) — _done (mechanics)_

- [x] Palette rail: everything not yet on canvas as drag sources; ticket ordering (unblocked-first) (§5)
- [x] Command palette: navigation + verbs (§11)
- [x] Dock rail + panel registry; state persists across panel close (§11)
- [x] Graph warnings surface: legal-but-questionable topologies flagged on card and editor, machine-readable for agents later (§5)

_Landed unstyled per the design gate (fleet rule 5), against fixture data in
`apps/web` (Stage 1 — Sync 2 swaps fixtures for the live API, see below).
`deriveGraphWarnings` is a pure function in `packages/ui` over the four cases
the spec names — blocked chain, no context at all, unconsumed published
output, unreachable node — surfaced both as a per-node card marker and in a
dedicated `GraphWarningsPanel`, registered through the same `PanelRegistry`
as Notes; neither ever refuses. `PaletteRail` groups drag sources by kind
and orders tickets unblocked-first; dropping a non-command-definition entry
onto empty canvas places it via a new `onDropPaletteEntry` on `PlotCanvas`,
while command definitions keep the existing bare-ticket one-gesture drop.
`CommandPalette` (Cmd/Ctrl+K) routes every navigation item through
`onSelectNode` — the one selection-as-route primitive, never a second way to
get somewhere. `DockRail`'s panel state lives in the rail's own component
state, not the panel's, which is what makes closing cheap: the Notes panel's
`Note` itself is now panel-registry state, and reopening it after a close
hands back the exact object, edits included. **Sync 2 update:** a fifth
warning landed — content assembled beyond the model's window — using
`@plotroom/core`'s own `checkContentBudget`/`estimateTokens` over a
command's real, live-fetched context content; `GraphWarning` carries an
honest `basis` string (chars ÷ 4, the one estimator assembly and the run
preview will also use) rather than implying a real token count. Palette
entries, warning facts, and context inputs now come from the live
`GraphSnapshot` (`warningFacts`/`paletteEntries`/`contextEdges`), not
fixture-only local state. Deferred, honestly: rendering-level component
tests (this package has none yet for any component, canvas included — only
pure-logic modules are unit-tested)._

### Epic 3.0 — Web + desktop shells (`web`, `desktop`) — _do first_

_Moved ahead of 3.1–3.4: nothing in this phase is demoable without a host to
run the renderer in._

- [x] `apps/web` renderer served by the server; single renderer for both targets (never forked per target) — _joint with Track A: `apps/server`'s `serveRenderer` (Epic 2.1) serves whatever `apps/web` builds to `dist/`, with SPA fallback, on the same port as `/api`/`/ws`; verified end to end (below), not just by inspection_
- [x] **Single-origin rule:** the browser talks to exactly one origin — page, WS, and API on the same port; the client connects to same-origin paths (`/ws`) with no hardcoded host or port anywhere. In dev, the dev server serves the page and proxies WS/API to the server so dev is single-origin too. This is what makes local and tunnelled access identical (§12)
- [x] Port/instance selection knob (one setting drives server port, dev port, state dir); dev HMR follows the browser's port with an override for asymmetric tunnels
- [x] Electron main: spawn-or-attach to server (electron-builder vs forge packaging tooling still not chosen — the operator's call per AGENTS.md's open decisions, deliberately not made here)
- [ ] Remote-backend connect/remember/switch (§12) — deferred to Phase 8, as the epic allows

_Landed: `createHttpClient` (fetch wrapper, now parsing the server's
`ApiErrorBody` onto `HttpError.code`/`.reason`/`.isRefusal`) and
`createReconnectingSocket` (WS with capped exponential backoff) in
`packages/ui`, both structurally same-origin. **Sync 2:**
`createApiGraphDataSource` is the live `GraphDataSource` — `load()` is a
plain `GET /api/snapshot` read; `subscribe()` runs the documented resync
recipe (`apps/server/src/routes/snapshot.ts`: connect `/ws` first, buffer,
fetch a snapshot, drop buffered events already reflected, apply the rest)
and redoes the whole recipe on every reconnect. `createApiActions` wraps
every mutation the canvas already gestures — place, wire, create a
workstream, instantiate a command, reorder context, write a note — over the
same `/api` endpoints an agent tool will use; a 409 becomes a typed
`{ok:false, refusal}` carrying the predicate's own reason, never swallowed
and never treated as success. `apps/web/src/App.tsx` runs live by default
(`createApiGraphDataSource`), falling back to the fixture source — the
exact same `GraphSnapshot` shape — only for `VITE_USE_FIXTURES=1` (tests,
offline dev). No session actor is ever set client-side: an omitted
`X-PlotRoom-Actor` defaults to human server-side, exactly like a hand-typed
`curl`.

`PLOTROOM_PORT` is the one instance knob, meaning exactly what
`apps/server/src/config.ts` gives it — the server's own port — fixed from
an earlier, pre-real-server guess that had this backwards: the dev proxy
target is `PLOTROOM_PORT` directly and Vite's own dev port is derived one
above it (both default to matching the server's real default, 4600, so
running everything with no env var set talks to the same instance).
`PLOTROOM_HMR_CLIENT_PORT` overrides HMR's reconnect port for asymmetric
tunnels. State dir is its own setting (`PLOTROOM_STATE_DIR`, now real —
`apps/server/src/config.ts` reads it), not derived from the port knob;
`apps/desktop`'s spawned server inherits it automatically (full
`process.env` passthrough in `spawnServer`), so setting it once in the
shell that launches Electron reaches the server it spawns with no separate
plumbing needed.

`apps/desktop`'s `spawnOrAttach` (probe → attach, or spawn → poll →
re-probe once → attach-to-the-winner-or-throw) now also covers a
concurrent-launch race, and is unit-tested with a mocked probe/spawn/wait;
`main.ts` adds `app.requestSingleInstanceLock()` (a second launch quits
rather than spawning a second server for this instance) and a child
exit listener (the server we spawned crashing after we confirmed it
healthy loads a plain crash page into the window, rather than an
unresponsive one with no explanation). The health probe now hits the real
`/api/health` route Track A shipped (was `/health`, a Stage 1 guess).
Verified two ways: `spawn-or-attach.integration.test.ts` drives
`spawnServer`/`healthProbe` against the real built server (ephemeral port,
temp state dir) — the test-based fallback for a headless environment with
no display; and once, manually, headlessly under `xvfb-run` against a
built `apps/web` + `apps/server`, confirming the whole chain (spawn,
health, page load, `/ws` upgrade, `/api/snapshot`) end to end outside a
test harness too._

**⛳ Sync 2 gate: passing.** `apps/web/src/data-source/live.integration.test.ts`
spawns the real, built server and asserts `createApiGraphDataSource`
(real fetch, real WebSocket, no mocks) reflects real mutations live —
a placed node and a wired command edge both arrive over `/ws` with no
manual refetch, and an illegal wire (content → content) is refused with
the predicate's own reason and never reaches the live graph. Canvas state
= live server state.

---

## Phase 4 — Running work: sessions, workspaces, claims

**Goal:** the first agent actually runs. This phase resolves the biggest open decision — the agent runtime abstraction — and delivers workspaces with path claims.

**Exit criteria:** drop a command on a ticket, run it, watch the session stream in the Conversation panel, and see a proven completion; two sessions in one workstream cannot write the same path.

### Epic 4.1 — Session runtime abstraction (`sessions`)

- [x] **Decide and record** the runtime boundary (open decision in AGENTS.md): the interface PlotRoom owns — start, stream, inject-between-turns, stop, fork-from-point, accounting taps — vs what a runtime adapter supplies — _accepted at Sync 1: pi coding agent first, Claude Agent SDK second (docs/decisions/0001)_
- [x] First runtime adapter (one concrete agent runtime end-to-end) — _two adapters are wired behind one registry; see the landed note for what is proven end to end and what is not_
- [x] Phase derivation from observation: thinking, responding, tool-running, compacting, waiting-\* , stopped, failed, idle (§3.6; principle 7 — derived, never agent-reported)
- [x] Per-session accounting: turns, elapsed, tokens, cost, last-activity, context-window meter with thresholds (§3.6)
- [ ] Session records: live = stored; readable, resumable, forkable, deletable, always (§3.6) — _stored and readable now (records, observation log, transcript, accounting, end states, all over `/api`); resume, fork, and delete have no endpoint yet (Epic 5.4 owns resume/fork; the delete verb waits with §6.6 approvals)_

### Epic 4.2 — Context assembly and the run (`runs`)

- [x] Assembly: ordered edges → assembled content, with content-budget warnings; hard cap opt-in per command; never silent truncation (§3.5, principle 12)
- [x] Run preview: exactly what will execute + cost estimate + spend cap acceptance, before anything starts (§4.1)
- [x] Cost estimates state their basis and render as ranges — "based on N prior runs" / "no history; input size only" — never a bare number (§4.1)
- [x] Completion proof is point-in-time: proven at submission, never silently revoked; later condition regression surfaces as drift/attention on done work (§3.5, principle 3) — _proof is written once at submission and nothing re-evaluates it; the drift/attention half of the sentence is Phase 6's feed_
- [x] Run-one; producing-session completion loop: submission checked against world conditions, failing condition returned as feedback, session continues within budget (§3.5, principle 3)
- [x] Open sessions: end by user; feed downstream via promote or transcript wiring (§3.5) — _end-by-user is a verb and refuses on a producing session; the transcript is a versioned object, so wiring it downstream is the ordinary context gesture, and the panel that offers it is Epic 5.1's_
- [x] Idempotent initiation: one gesture → one session/run, across retries and reconnects (principle 9)
- [x] Run history capture at run time (exercises §15-1/§15-4 written in Phase 1)

_Landed (Batch 2, stage 1 — the run spine). Migration 7 persists what Epic 1.5
and Epic 4.3 deliberately left as domain shapes: `sessions` (launch choices,
the closed end-state taxonomy as a CHECK, accounting snapshot columns),
`session_observations` — **PlotRoom's own observation records, never vendor
payloads** — `session_transcript_publications` (the checkpoint rule's output,
over `ObjectStore`, so a transcript is content like anything else),
`session_injections` (the queued→delivered ledger, with the product's own
world-condition feedback distinguished from authored steering),
`run_submissions`, `run_initiations`, and `workspaces`. `sessions.run_id` is
`ON DELETE SET NULL` on purpose: run retention may reclaim a run, and a session
record is readable always (§3.6).

Phases and accounting are **folded from the log** by `@plotroom/core`'s reducer
and snapshotted on the row, so the row is a cache and the log is the record;
`SessionStore.observationState` recomputes either at any time. Two adapters sit
behind one registry over core's seam: the **pi coding agent** (the server owns
the process, writes the permission-gate extension, and hands core the
transport, since core owns no transport) and a **scripted runtime** that replays
a declared script of observations and is registered only when the operator
selects it (`PLOTROOM_RUNTIME=scripted`), so a default installation has no such
adapter to name — asserted by a test. Both run the same downstream code:
observation log → phase reducer → accounting → WS events → completion loop.

`POST /api/runs` is the §4.1 gesture: claim the client-supplied initiation key
(a retry gets the same run and session; a key reused for another command is
refused; a refused attempt frees the key), provision the workspace **at first
run** through Epic 4.3's git kind, gate on `checkReady` so not-ready blocks with
the setup step's own reason, assemble ordered context whole (warn near the
window, refuse over an opt-in hard cap, never truncate), record §15-1, then
start the session under the workstream, place its node, and record
`command_started_session` provenance. Completion is **proven, never claimed**: a
submission (the `plotroom_submit_outcome` tool a real runtime will call in Epic
4.5) is checked by a condition-check registry — `workspace_file_exists` and
`workspace_command_succeeds` ship, plugins register more (§10.1) — a failing
condition is injected back as feedback and the session continues, and a runtime
that reports "completed" for work PlotRoom never proved is recorded as a failure
that says so. Every end state is plumbed and distinct: completed(proven),
ended-by-user, stopped, out-of-budget (the enforcer's `cause: "budget"` on the
stop verb — enforcement itself is Phase 6), failed, and **interrupted**, which
is written for every in-flight session at process start (principle 11).

The event vocabulary grew two entities — `session_observation` (one appended
record, stamped per session) and `session_transcript` (a published version) —
and a `session` event now carries its derived status beside the record.

Deferred, honestly: a session has no `resume`/`fork`/`delete` endpoint;
injection as a human gesture is Epic 5.2 (the ledger exists and only the
completion loop writes to it); a session's cost basis is `runtime-reported` or
nothing, because there is no pricing table until Epic 6.2; the workspace
repository is configured (`PLOTROOM_WORKSPACE_REPO`) rather than discovered, and
the in-repository setup declaration still has no reader, so the settings
override is the only source; and no test runs a real pi session through the
server — pi's adapter is unit tested in `core` and its permission gate is
spike-verified against pi 0.83.0, but the end-to-end spine proof is the scripted
runtime._

_Landed (Batch 2, stage 2 — the preview). `RunStore.plan` is the one description
of what a run would be: ordered inputs, the assembled bytes, the configuration,
and every refusal **collected rather than thrown**. `start()` reads that same
plan and refuses on the first blocker, so "exactly what will execute" is
literal — a test asserts the preview's body is byte-identical to what §15-1 then
records — and a preview cannot say a run is ready while the run refuses.
`GET /api/commands/:id/preview` is a read in the strong sense: it provisions no
workspace, starts no runtime, records nothing, and needs no repository
configured. It reports the workspace's readiness from the record (including
"the first run will provision one") rather than by touching git, and it is the
endpoint that answers "why can't I run this".

`estimateRunCost` in `@plotroom/core` is the estimate, and a bare number has no
representation in its type: there is a basis, a range, and a sentence.
`prior-runs` prices from this **definition's** own priced history — which is
what §15-1 pays off, and per definition because the same recipe run in two
workstreams is the same evidence — and a run whose runtime reported no cost
contributes nothing rather than averaging a zero in. With no priced history the
basis is `input-size-only`, the range is `null` (not zero), and the description
says so. The suggested spend cap is the most expensive prior run, and there is
no suggestion at all when there is no history. `POST /api/runs` takes
`spendCapMicros`, recorded on the run beside what it then cost (migration 8);
enforcement remains Phase 6's.

Also in stage 2: **durable placement**. Node positions are columns on `nodes`
(migration 8), `PATCH /api/nodes/:id/position` and `PATCH /api/arrangement`
move one or a whole selection in one transaction, the snapshot and every `node`
event carry `position` (null meaning "no authored position", which is what
`deriveInitialArrangement` fills in), and an arrangement survives both a restart
and a state-directory move. Track B still stores placement in `localStorage`;
switching it to these endpoints is its own change and is deliberately not made
here. Deferred: nothing renders the preview yet (Track B), and continue-vs-fresh
preview is Batch 3 (§4.3)._

### Epic 4.3 — Workspaces (`workspaces`) — _done (domain + git kind)_

- [x] Workspace kind abstraction: boundary guaranteed by product, mechanism per kind (§3.4) — git kind first
- [x] Git provisioning: branch from configurable template; existing branches taken as-is from remote; provision at first run, not workstream creation (§3.4, §3.5)
- [x] Readiness: declared per-repo setup step gates runs; not-ready blocks with visible reason; setup output inspectable; failures reported (§3.4)
- [x] Live status (branch, uncommitted, ahead/behind) reflecting terminal-made changes too; divergence detection for continuation gating (§3.4, §4.3)
- [x] Discovery: scan configured search paths; discovered ≠ placed (§3.4, principle 6); create/attach/remove/force-remove; protected primary checkout + default branch
- [x] Provisioning cost awareness: shared caches where possible, cost reported (§3.4)
- [x] Host-auth invariant: workspace git operations use the host machine's own git/SSH config; app credentials are never used for workspace git and never written into workspace git config or remotes; clone-from-PR fails honestly when the host cannot authenticate (§3.4, §9.3) — enforced with a test, not a convention

_Landed as `@plotroom/core`'s `workspaces/` subtree, split along §3.4's own
sentence: the boundary is the product's (`checkWorkspaceBoundary`,
`checkRootOwnership`, `checkReady`, `checkRemoval`, `deriveDivergence` /
`checkContinuation`) and asks no kind anything; `kind.ts` is the mechanism
contract and `git/` is the first implementation of it. Status, fingerprints,
and provisioning results are per-root lists and kind configuration is a JSON
record the kind validates itself, so a multi-root kind (§13) and a
plugin-supplied one behind a worker boundary (§10.1) fit without a new concept.
Provisioning is an operation the run path calls — creating a workspace record
provisions nothing — and prefers `git worktree` over the primary checkout,
falling back to a clone against a shared mirror cache; cost reports strategy,
cache hit, elapsed, and disk (null when unmeasurable, never zero).

The host-auth invariant is mechanism, not convention: `runGit` takes no
environment argument and builds the child's from a host allowlist, credential
vocabulary is confined to `git/host-auth.ts` (asserted by scanning the layer's
own declarations), credentialed remote URLs are refused inbound, the
provisioned workspace's `--local` config is read back and checked outbound, and
a clone the host cannot authenticate ends as `host_auth` with git's own reason
and no second attempt. `git.integration.test.ts` runs the real binary against
temp repositories — no network — and asserts what lands on disk.

Persistence and the provisioning call landed with Epic 4.2's run spine:
migration 7's `workspaces` table stores this record shape verbatim, and
`POST /api/runs` provisions at first run and gates on `checkReady`.

Deferred, honestly: `commits-added` forces
fresh conservatively because attributing a commit to a holder needs Epic 4.4's
claims, which is also what will narrow hand-edit divergence from "reported" to
"per path a session read"; setup declarations are resolved from values handed
in, with no reader for the in-repository file yet; discovery walks with a
directory-listing seam and no watch; and clone-from-a-PR-card is the same
`clone` path with a UI that does not exist until §9.4._

### Epic 4.4 — Path claims (`claims`) — _done (domain Batch 2; server wiring landed in Batch 3)_

- [x] Claim model: per-path leases; root claim per workstream; every claim a subdivision of a held claim (§3.4)
- [x] Hierarchical conflict (ancestor/descendant paths, not-yet-existing paths covered)
- [x] Grant authority follows path hierarchy; human may grant/revoke/force-release anything
- [x] Pre-granted claim policies (allow/deny patterns per subtree)
- [x] Lease expiry + activity renewal; automatic release on session end
- [x] Waitlists as visible state; wait-for-cycle deadlock detection refusing the newest claim with an actionable message
- [x] Claim-precise divergence: stale iff a read path was written by a different holder (§3.4)
- [x] Operator as implicit claim holder: hand edits are their own divergence class, staling a session only for paths it read (§3.4)
- [x] Session tools: request, yield, inspect — decision functions in `core` (`ClaimManager`); the endpoints that expose them are Track A's, tracked in Epic 4.5's carry-over below (principle 4) — _mounted in Batch 3; see the server note below_

_Landed as `@plotroom/core`'s `claims/` subtree: `paths` (canonicalization stated
and tested — case-folded, separators and `..` normalized, escapes refused — plus
the hierarchical conflict rule, over names rather than files, which is why
not-yet-existing paths are ordinary), `policy` (pre-granted allow/deny per
subtree with a small auditable glob; **deny wins at any depth**), `model` (the
records, the effects Track A persists, and the invariants as predicates:
`violatesGrantExtent`, `violatesSingleWriter`), `deadlock` (the wait-for graph
over sessions — the operator is never a node, so force-release is always
available), `manager` (pure decision functions with an injected clock and id
factory), and `divergence` (claim-precise staleness).

The shape worth knowing: **grant authority is `authorityFor`**, the deepest claim
covering a path, so "whoever holds a path may grant inside it" and "who may write
it" are one lookup and cannot disagree; a claim that merely encloses the path is
the authority rather than contention, and the operator never blocks. A **wait has
two independent gates** — availability (`blockedByClaimIds`) and authorization
(`authorizedAt`) — so a policy-allowed waiter is granted the instant the path
frees instead of queueing for a second approval, and §6.6's approval is raised at
request time rather than after the wait. Releasing a claim **reattaches** its
sub-claims to its own grantor (the capability came from the root grant; a wedged
intermediary should not punish its children); cascade is the operator's explicit
revoke. Invariants are asserted over pseudo-random operation sequences
(`invariants.test.ts`), not just examples.

Retention-style default decided: **claim leases lapse after 15 minutes of
inactivity** (`DEFAULT_CLAIM_LEASE_SECONDS`), renewed by activity in the claimed
path — long enough to survive a slow tool call, short enough that a wedged holder
frees its paths without the operator. Claim waits past **5 minutes** are marked
for §7.2's alert; the data (position, since-when, blocked-on-human vs
blocked-on-session, overlapping waitlisted paths) is exposed now, the alerts land
with Phase 6.

Deferred, honestly: nothing is persisted — `ClaimState` plus the `ClaimEffect`
list is the persistence contract Track A implements, and the claim endpoints are
`pending` in the tool catalog until it does; the write ledger
(`PathWrite`/`PathRead`) is a shape, and who records reads and writes during a run
lands with Epic 4.2's run path; and `checkClaimContinuation` keeps Epic 4.3's
conservative verdict whenever the ledger is not complete for the interval, so
narrowing only takes effect once run-time recording exists._

**Server wiring landed (Batch 3, Track A).** Migration 11 is `ClaimState` at rest
(`claims` / `claim_waits` / `claim_policies`) plus the ledger (`path_writes` /
`path_reads`), and `ClaimStore` applies the `ClaimEffect` list — nothing outside the
claim manager decides anything, which is why a store that re-derived "is this path
held" would have been the second implementation principle 8 exists to prevent. Rows
are retired rather than deleted, so a release and an expiry stay different events;
two schema CHECKs make an unrepresentable state unrepresentable rather than merely
refused (a holder with no session id, and a non-root claim with no lease — only the
operator's root claim is immortal). `ClaimService` sweeps lapsed leases **before
every decision**, as the contract requires, and turns effects into events on the one
vocabulary: `claim`, `claim_wait`, and `claim_policy` are entities on the same stream
as nodes and sessions, because a waitlist a surface has to poll for is the invisible
stall §3.4 is about. All eight declared endpoints are mounted (`routes/claims.ts`)
plus `DELETE /api/claim-waits/:id`, and the two operator-only ones are enforced by
the request's **actor** rather than by the catalog's `humanOnly` flag — a flag
describes, and the route is the gate.

**Enforcement, which is the part that matters.** The first session in a workstream
is granted the root claim by the operator at provisioning (§3.4's single-writer
default, and the reason principle 1 holds rather than looks held: every claim
downstream subdivides a human's reach). Every runtime write then passes
`decideToolPermission` before it runs, through one seam for both adapters: the
scripted runtime raises the same `tool-permission` request pi's tool layer does,
waits unbounded for PlotRoom's answer, and **does not touch the disk when the answer
is no** — so claim enforcement is provable without a model, and it is proved
(`claims.integration.test.ts` asserts a second session's write is refused and the
file is not there). A driver with no gate wired **denies**; an adapter with no
declaration gets `UNKNOWN_WRITE_INTENTS`, under which every write raises an approval
rather than being allowed because nothing recognised it. Waiting on a claim is the
session phase core already modelled, fed from the wait rows so the card, the queue,
and blocked-on accounting cannot disagree. Claims are released on session end
automatically, before anything about the run is decided.

_Still deferred: **`PathRead` capture has no source.** `WriteIntentDeclaration`
declares write extents and says nothing about reads, so there is nothing to attribute
a read to yet — `recordRead` exists and the table is there, but only writes accrue.
`checkClaimContinuation` therefore still keeps Epic 4.3's conservative verdict, and
will keep it until an adapter declares read extents. Approvals are raised as log
lines and the `blockedOnHuman` fact on the wait event; the §6.6 approval surface is
Phase 6's._

**Adversarial review round (post-landing).** Three defects reached `main`-ready
state with 164 tests passing, which is worth recording because each one hid in a
place tests were not looking:

- **A deny policy let the operator's grant stomp a live holder.** The evaluation
  returned `denied` before blockers were computed, and `grant` — which
  legitimately overrides a deny — never saw them. Availability is now decided
  before policy is consulted at all, and no evaluation variant hides its
  blockers.
- **Deadlock was endured when the cycle formed by churn.** Cycle detection ran
  only at wait insertion, so a promotion that moved one waiter's blockers onto a
  freshly granted holder closed a loop nobody requested. `findAnyWaitCycle` plus
  a sweep after every blocker-set update refuses the newest wait, same rule as
  insertion; the invariants suite asserts the wait graph is acyclic every step.
- **Waitlist grants were immortal.** An unspecified lease was stored as null and
  passed through at grant time, where null means never-expires. Unspecified and
  explicit are now different types, `makeClaim` has no value meaning forever, and
  `violatesLeasePolicy` states that only the root claim is immortal.

Two safety-adjacent fixes rode along: `checkWrite` is **lapse-aware** (an unswept
expired claim authorizes nothing) with `request`/`grant` sweeping before they
grant, so a stale row can never sit beside a new claim; and canonicalization
**normalizes to NFC before folding case**, because macOS hands over decomposed
filenames while everything else composes them — two byte strings that print
identically would otherwise have been two claims on one physical file.

Follow-up, recorded rather than done: **audit attribution for an ancestor-policy
carve-out.** When a grant is authorized by a policy an _ancestor_ declared, the
claim records `grantedBy` as the immediate authority's holder and does not name
which policy allowed it, so an audit cannot reconstruct why a sub-claim inside
someone's subtree was legitimate without re-evaluating the whole chain. The
verdict is correct today (deny wins at any depth, and the extent check bounds
it); what is missing is provenance. Non-blocking — it lands with whichever epic
first needs a claim audit trail._

### Epic 4.5 — Agent tool surface (`tools`) — _done (domain Batch 2; server mounting landed in Batch 3)_

- [x] Every human gesture exposed as an agent tool over the same API vocabulary (principle 8) — one catalog in `core`, pinned to the server's mounted routes by a test in both directions
- [x] Reflexivity enforcement: no session authors context/capabilities/budget into its own initiation chain; propose-and-accept path for self-touching targets (principle 1) — `checkToolCall` over the Phase 1 lineage model, called by the bridge before any request is built. _Carry-over resolved in the tool layer: the bridge is constructed with the session it serves, sets `X-PlotRoom-Actor` from that binding, and refuses an actor-shaped input rather than stripping it — a session has no way to say who it is. The server-side half (mount the bridge's transport, keep the header caller-supplied only for the operator) is Track A's._
- [x] Delegation: child sessions visible on the graph with provenance; spend attributed up the initiating chain (§3.6, principle 2) — `planDelegation` records the `session_delegated` provenance edge and `attributeSpend` writes one ledger row per session in the chain; enforcement lands with Phase 6 — _wired in Batch 3: `POST /api/runs` with a session actor is the delegation, and the server records both halves (see the note below)_ budgets
- [x] Graph warnings readable by agents (§5) — in the catalog as `graph_warnings_read`, `pending` until the warnings endpoint exists

_Landed as `@plotroom/core`'s `sessions/tools/` subtree: `catalog` (the single
declaration of the vocabulary — name, gesture it mirrors, method, endpoint,
input schema, and what it requires: a claim, an approval, a lineage class, or the
operator), `reflexivity` (principle 1 as a refusal, plus `ToolProposal` and a
human-only `decideProposal`), `bridge` (request building with the actor set from
the binding; a refused call never reaches the transport), `gate` (per-call
permission decisions where claims answer, with an undeclared write extent treated
as unbounded and therefore approval-raising), and `delegation` (provenance plus
the spend-attribution rows). `adapters/pi/write-intents.ts` declares what pi's
tools write — today only that `bash` is unbounded, verified by the C6 spike — and
treats every undeclared tool as unbounded rather than as harmless.

`catalog.test.ts` reads `apps/server/src/routes/` and compares both directions,
expanding templated route registrations rather than wildcarding them, so a new
endpoint without a tool fails and a `pending` tool whose endpoint appeared fails
too.

Deferred, honestly: the endpoints for claims, sessions/dispatch, proposals, and
graph warnings are `pending` — Track A mounts them and flips the flag (the test
says which); `ToolTargetIndex` is a seam — resolving which sessions a command node
feeds is the graph's answer, so Track A supplies the implementation; tool input
_field_ names are declarations checked by review rather than pinned, because the
request schemas live in `apps/server` (zod) and `core` cannot import them — when
those schemas move into `core`, the catalog derives from them; and the propose‑
and‑accept records are shapes until proposals are persisted._

**Server mounting landed (Batch 3, Track A).** The claim tools are `live` (see Epic
4.4's server note), and the catalog gained entries for the endpoints this batch
added: `run_scope_preview`, `run_scope`, `run_queue_read`, `run_queue_cancel`,
`run_queue_confirm`, `run_batch_read`, `run_batch_resume`, `workspace_diff_read`,
`session_spend_read`, `workstream_spend_read`, `fleet_spend_read`, and
`claim_wait_withdraw`. The catalog test earned its keep again: every one of those
existed because it failed the moment the route did, which is principle 8 drifting in
the direction nobody notices.

**Delegation is mounted, and `ToolTargetIndex` is implemented** (`runs/delegation.ts`).
The resolution the catalog carries as the mounting contract is the resolution the
server uses, including the part written in capitals: a `run_one` target resolves to
the sessions the command has **already** run and never to the one the run is about to
create, or delegation itself would be refused. A session actor on `POST /api/runs`
therefore does three things — `checkToolCall` refuses a run inside the caller's own
chain before anything is recorded (so the initiation key is still free afterwards),
`planDelegation` records the `session_delegated` provenance edge (recorded, never
authored: it passes through no authoring check), and `attributeSpend` charges every
session in the chain. Attribution rows are unique per (charged session, spender) and
**replace** rather than accumulate, because the accounting total is folded from the
observation log and the same spend observed twice must be charged once. Totals are
readable per session, per workstream, and fleet-wide; `own` rows only for the latter
two, since summing `descendant` rows would count a delegated dollar once per
ancestor. Enforcement stays Phase 6's — nothing refuses on money yet.

_Still deferred: proposals, graph warnings, and the §6.6 approval surface have no
endpoints, so `proposal_create`, `proposal_accept`, and `graph_warnings_read` remain
`pending`._

**Review round additions.** `session_dispatch` was declared reflexivity `none`,
which made §4.1's rule — a session may not run, resume, or re-run work inside its
own initiation chain — inexpressible. It is lineage-checked now, and the
resolution that makes delegation and §4.1 both true is carried as data:
`requires.targetResolution` states per tool how `sessionsAffected` must resolve,
the catalog test refuses a lineage-checked tool that leaves it unsaid, and the
claim tools carry §3.4's exemption verbatim (**never** the waiting session, or the
parent-to-child grant the claim model is built on would be refused).

**Track A's run-spine needs, folded in** (all three in `core/src/sessions/`):

- **World-condition feedback** is its own `TranscriptEntry` kind rather than an
  `injection` with a system author: nobody authored it, and widening `Author`
  would have let an unattributed _context_ edge typecheck everywhere — the schema
  reserves `system` for provenance edges and forbids it on context edges. It names
  the failed condition ids, counts toward the size budget, is never a release
  candidate, and changes nothing about the checkpoint rule.
- **Proven completion is a core rule**: `EndClassificationContext` carries
  `CompletionEvidence` and `checkProvenCompletion` is the predicate both the run
  loop and `classifyEnd` read. Absent evidence is not proof — a reported
  completion with none is recorded as a failure that says so, because silence
  would mark unchecked work as done (principle 3). **Track A must pass evidence
  to record a completion.**
- **`ended-by-user` carries an author**, set by `classifyEnd` from PlotRoom's
  context (the runtime only sees its input close). Optional, defaulting to the
  operator through `endedBy`, because requiring it would break an `apps/web`
  fixture this track does not own.

The run spine landing mid-review made the catalog test earn its keep twice: it
failed the moment twelve `runs`/`sessions` endpoints existed without tools, which
is principle 8 drifting in the direction nobody notices (the UI gains a gesture an
agent does not). Those tools are in the catalog now — and `session_dispatch` is
gone rather than pending, because `POST /api/runs` with a session actor _is_
delegation and a second way to start a session is what principle 5 forbids. What
makes a run a delegation is therefore the actor: **Track A records the
`session_delegated` provenance edge and attributes the child's spend up the
initiating chain from it** (`planDelegation`, `attributeSpend`).

Also aligned with main rather than re-litigated: an **open** session's `completed`
claim is refused as a failure, matching the decision already landed in the run
driver (`fix(sessions): refuse any unproven completion claim`) — an open session
has no declared outcome, so the claim is more unfounded rather than less. The rule
now lives in `checkProvenCompletion`, so the driver's own conversion can be
deleted in favour of passing `CompletionEvidence`.

Cross-track follow-ups this created, for the orchestrator to schedule: **Track B**
should render the new `feedback` entry kind (`buildTurnItems` in
`packages/ui/src/sessions/transcript-view.ts` switches without a default, so
feedback is currently dropped from the view — their own principle-12 comment says
it should not be), and may tighten `ended-by-user`'s author to required with a
one-line fixture change._

---

## Phase 5 — Steering in flight

**Goal:** the originating problem — many sessions at once, answerable in seconds. Everything the transcript, injection, and question machinery needs.

**Exit criteria:** run several sessions; inject content mid-flight and see it as a graph edge; answer a structured question from a bubble without opening a panel; stop at all three scopes.

### Epic 5.1 — Conversation surface (`panels`, `sessions`) — _live, Stage 2 of 2 — W10 milestone gate passed_

- [x] Conversation panel: streaming transcript, reasoning distinct from output, tool calls with I/O, message-level actions, export (§6.1, §11)
- [x] Bounded transcript with recoverable release: largest old tool outputs first, visible markers, reload, complete export (§6.1)
- [x] Drafts and prompt history persisted per session (§6.2)
- [x] Diff panel (read-only file tree + patches) (§11)

_Stage 1 (Batch 2, Weeks 8–10) landed the mechanics fixture-fed, against
`@plotroom/core`'s real session/transcript types, ahead of Track A's run
spine. **Stage 2** (same weeks, once the run spine merged) wires it all
live:_

_`createApiSessionDataSource` (`sessions/data-source.ts`) replaces the fixture
as the default, over Track A's real endpoints — `GET /api/sessions(/:id,
/transcript)` plus `/ws` — reusing `createApiGraphDataSource`'s exact resync
recipe (connect first, buffer, a seq-stamped `/api/snapshot`, drop what it
already reflects, apply the rest) for the live session list/status;
transcript reads have no snapshot-level `seq` of their own, so
`subscribeTranscript` instead refetches the already-coalesced, idempotent
`GET /transcript` on every relevant `/ws` event — a deliberately simpler rule
than the board's, reasoned about in the module's own doc comment. Stage 1's
parallel `SessionListEvent`/`TranscriptEvent` envelope is gone, replaced by
`SessionDetail` derived straight from `@plotroom/core`'s `session`/
`session_observation`/`session_transcript` `DomainEvent` variants (one
vocabulary, not two, per the Stage 1 review). `ConversationPanel` now takes
only a `sessionId` and derives everything else live; the board
(`board-state.ts`/`build-snapshot.ts`) tracks `sessions`/`runs` too, so a
session or command node's label and running state come from the live
record, never the placed node's own (write-once) `running` flag — including
a node already on the canvas before that data arrived (`PlotCanvas`'s
additive sync effect only ever seeds a label/running state once; a second
sync effect now keeps it current). A minimal "run" affordance renders on a
command node (`onRunCommand` → `POST /api/runs` with a generated,
idempotent initiation key, principle 9); this is not Epic 5.5's fuller run
affordance (subgraphs, a queue, re-run-drifted) — that epic is still open._

_Composer send is honestly disabled with a reason: injection has no server
endpoint yet (§6.5 is Batch 3 scope); "wire as context" stays a placeholder
hook. `DiffPanel` stays fixture-fed — no workspace/diff read API exists yet._

_**The diff read landed in Batch 3** (Track A): `GET /api/workstreams/:id/diff`
answers the panel's own `WorkspaceDiff` shape — a flat file list with a status, a
patch, and pre-split hunks per file — so the fixture can be replaced by the real
thing. Every git invocation behind it is a read through `runGit`, so a diff cannot
become the one place an app credential reaches a workspace (§3.4). What "changes"
means is stated rather than assumed: the merge-base with the configured base ref
where there is one, so the diff still shows the work after a session commits, and
`HEAD` where there is not — with the response saying which, because a diff whose base
is a guess is a wrong answer with no evidence. Untracked files are included, since a
session that wrote a new file changed the workspace. Three not-ready states are
answers rather than empty successes: no workspace, a record with nothing checked out,
and a checkout git cannot read (§3.4's visible reason). **Track B replaces the
fixture** — cross-track follow-up._

_**THE W10 MILESTONE GATE**: `apps/web/e2e/milestone.spec.ts` (Playwright,
run via `pnpm --filter @plotroom/web e2e`, not part of `pnpm verify` or
turbo's `test` — spawns a real server + a real local git repository) proves,
against the actually-served page in a real browser tab: dropping a command
definition onto a bare ticket creates a workstream and a wired command node
(the one-gesture flow, §3.5); clicking "run" starts a real session under the
scripted runtime (`PLOTROOM_RUNTIME=scripted`); the Conversation panel
streams its transcript live — reasoning distinct from output, then (after a
first submission the declared world condition fails, so the session
continues into a second turn) a tool call with its input and output; and
proven completion shows on both the session (`end: completed`) and the
command node's own label (`run: completed`) once the second attempt's
tool call actually satisfies the condition._

_**Batch 3 (Weeks 11–14) finish**, alongside Epic 5.3: bounded rendering
(`sessions/windowing.ts`) caps the Conversation panel to a live tail window
of turns — "load earlier turns" grows it one step at a time — so a
long-running session's DOM stays bounded the way its transcript bytes
already do (§6.1's release rule). The human half of the transcript
checkpoint gesture (§3.6) is wired live: `ConversationPanel`'s
"checkpoint transcript" button calls `checkpointTranscript`
(`data-source/actions.ts`) over `POST /api/sessions/:id/checkpoint`, which
turned out to already be live on `main` (Track A/C shipped it ahead of this
rebase) — the agent-side half (a session checkpointing its own transcript
through the tool catalog) is still Epic 5.2/Track C territory. `DiffPanel`
moved behind a `DiffDataSource` seam (`diff/data-source.ts`) the same
"fixture behind the real interface" shape as `SessionDataSource`; no
workspace/diff server endpoint had landed on `main` as of this rebase, so
`createFixtureDiffDataSource` is still the only implementation — the seam's
own doc comment states the exact swap point for `GET
/api/workstreams/:id/diff`._

_**Live steering wiring (Batch 3, Weeks 11–14, Stage 2 of this track's own
two stages)**, once Track A's Epic 5.2/5.4 steering endpoints merged to
`main`: the composer's send now calls `injectIntoSession` (`POST
/sessions/:id/inject`) instead of rendering permanently disabled, with the
ledger's queued/delivered state read live via a new `SessionDataSource.
subscribeInjections` (the same refetch-on-relevant-event recipe
`subscribeTranscript` already used, except delivery rides the session's own
`updated` event rather than `session_observation` — the driver's
`markDelivered` changes derived status, never the observation log).
`DiffPanel` is live by default too: `createApiDiffDataSource` reads `GET
/api/workstreams/:id/diff` (now merged), addressed by workstream id rather
than workspace id, with `WorkspaceDiff`'s shape corrected to match the real
response (`state`/`reason`/`base`, not just a flat file list) and every
not-ready state rendered honestly instead of folding into "no changes".
Resume-vs-fork (§6.3) is mechanics-complete: once a session has ended,
`ConversationPanel` replaces its whole composer — not merely disables it —
with exactly two choices, `resumeSession`/`forkSession` over Track A's
`POST /sessions/:id/(resume|fork)`; there is no third path back to typing
into an ended session. Handoff and continue-vs-fresh's own UI (a brief
draft/review flow, a side-by-side cost preview) are deliberately deferred —
not gate-tested, and the two gestures landed here already cover what §6.3's
"never implicit on typing" needs proven._

_**A real bug the W14 gate found, not a fixture:** every bubble subscription
(session sayings, tool-in-flight, the injection ledger, structured
questions) was keyed by a session's own id where it needed the canvas
node's id — the two coincide in every fixture (`sessionCanvasNode` sets
both to `session.id`), which is exactly what let this go unnoticed through
an entire window of fixture-fed unit tests. Only a real server, whose node
ids are generated separately from the session ids they stand for,
disagreed. Fixed as `{ nodeId, sessionId }` pairs kept explicit rather than
one list read two ways (`App.tsx`)._

_**THE W14 MILESTONE GATE**: `apps/web/e2e/steering.spec.ts` (Playwright,
same harness convention as W10, extended with a per-run `runtime.script`
and a raised concurrency limit so five sessions start at once) proves,
against the actually-served page: injecting mid-flight from the composer,
delivered on both the injection list and the canvas bubble, with a real
graph content node behind the ledger row; a structured question's bubble
answered **inline from the bubble**, never the panel, after which the
blocked act resumes; and stop at three scopes — one session, a workstream
of two (no confirmation), then everything running (confirmed) — every
stopped session proven via a direct API read to have ended `stopped`. Not
asserted: a `queued` window on the injection ledger, because the scripted
runtime's own `inject()` delivers immediately rather than modeling pi's
real between-turn queueing (a genuine discovery, documented in the gate's
own file, not an oversight); and an "ends itself as completed" claim, tried
for the ask leg and refused server-side (an `open` lifecycle session has no
outcome to prove `completed` against, §3.5 principle 3) — "resumes and
completes" is proven instead as the post-answer turn actually playing on.
Break-verified for the question-bubble leg (temporarily disabling
`question-source.ts`'s `session_question` WS branch made the bubble
genuinely time out; restored and reran clean); 5 consecutive clean runs
recorded._

### Epic 5.2 — Injection, questions, broadcast (`sessions`) — _done_

- [x] Injection as new turn + permanent graph content wired to the session (§6.5, principle 5); queued → delivered states for between-turn delivery — `planInjection` produces the content node, the authored context edge, and the ledger entry; the pi adapter's real between-turn delivery is verified against a live pi
- [x] Session-to-session injection with attribution (peer gesture, lineage rule applies) — the same plan with a session author, refused into its own chain by `checkInjection`
- [x] Transcript checkpoint gesture (human and agent) feeding the Epic 1.5 checkpoint rule (§3.6) — `checkpointEvent` / `previewCheckpoint`; the endpoint and the `session_checkpoint` tool were already live
- [x] Structured questions: options as bubbles on the node, answered inline, result returned structurally, unpicked options remain visible; **no timed defaults** (§6.4, principle 2) — `questions.ts`, with the prohibition enforced structurally (a timed default is a type error, asserted); `plotroom_ask` is the pi-side tool
- [x] Human broadcast (selection / workstream / everything running) (§6.5) — `planHumanBroadcast`, unconstrained by construction
- [x] Session broadcast: scope-of-material-state only, mandatory declared category, rate-bounded per window, induced spend charged to sender's budget chain, operator-visible (§6.5) — `planSessionBroadcast` plus `attributeBroadcastSpend`, `broadcastAttention`, `broadcastActivity`
- [x] Batch gestures: one prompt to many, stop/close/archive on a multi-selection; preset prompts (§4.2) — `planBatch`'s envelope, with per-member keys derived from the batch key
- [x] Endpoints, stores, and events for all of the above — Track A's stage 2; landed, and the catalog's tools are `live` (see the server note below)

_Landed as new modules in `@plotroom/core`'s `sessions/` subtree — `injection.ts`
(extended), `questions.ts`, `broadcast.ts`, `batch.ts`, `stop.ts` — plus the pi
adapter's real between-turn injection and `plotroom_ask`._

**The shapes worth knowing.** Injection is three writes, not one: `planInjection`
returns the content object, the node, and the **context edge carrying the
injector as its author**, because "steering is authoring" (§6.5, §15-2) — a plan
that leaves no paper trail is not representable. `planSessionBroadcast` applies
every §6.5 constraint in one place, and `SessionBroadcastScope` has **no variant
that lists sessions**, so "a chosen list" is inexpressible on the session path;
the declared category rides on the content node's own title, so a broadcast
cannot masquerade as task context where a reader would find it. A session
broadcast **deliberately does not check lineage** — §6.5 says the scope rule is
what closes the collusion channel, and "excluding the sender's chain would
exclude exactly the sessions most likely affected" — and a test asserts a parent
in scope receives it. Because the scope rule is what does that work, the sender
must **stand in the scope it declares** (`senderSharesScope`, checked before the
rate bound so probing costs nothing): §6.5's scopes are deictic — "everyone in
_this_ repository," "_this_ workspace" — and a foreign workspace with one session
in it would otherwise be a recipient list of exactly one, which is the thing a
session may not write. `planBatch` is partial by design: a member that cannot take
the gesture is skipped with a reason rather than failing the twelve, and every
member's idempotency key derives from the batch key so a half-failed batch is
replayable (principle 9). Its lineage check applies to the **injecting** kind
only, decided rather than overlooked: principle 1 governs authoring intent, while
stop, close, and archive take capability away — checking them stopped a parent
from batch-stopping its own runaway child, which is the most useful batch stop
there is. §4.1's separate rule (no running, resuming, or re-running inside your own
chain) is untouched, and `authorsIntent` states the reasoning beside the branch.

**No timed defaults, enforced structurally.** §6.4's prohibition is a type-level
impossibility rather than a runtime refusal: `SessionQuestion` has no default,
fallback, or on-timeout field; `QuestionAttention.onElapsed` is the single
literal `"escalate-attention"`, so `"answer"` and `"proceed"` do not typecheck;
and an answer requires an `Author`, which has no system variant, so "answered by
the timer" cannot be written down. `questions.test.ts` asserts all three as
`@ts-expect-error` cases — if any becomes expressible, the unused directive fails
the build.

That last sentence was **false when it was first written**, and the correction is
worth recording because it is a whole class of inert test: `packages/core`'s
`tsconfig.json` excludes `src/**/*.test.ts` (it is the build, and a build must not
emit its own tests), vitest's esbuild transform strips types without checking
them, and eslint here is not type-aware — so nothing typechecked a test file, and
every `@ts-expect-error` guard in the repo's core package was decoration. Core's
`typecheck` script now also runs `tsc -p tsconfig.tests.json` (`noEmit`, tests
included, ~1s warm), which puts the guards inside `pnpm verify`. Proven by
regression rather than by assertion: adding `defaultOptionId` to `SessionQuestion`
fails `pnpm typecheck` with `TS2578: Unused '@ts-expect-error' directive`, and
removing it passes. Type-level assertions are also kept in never-invoked closures,
so a guard's only job is to not compile — one of them was silently throwing at
runtime instead. (`packages/db` and `packages/plugin-sdk` still exclude their
tests; same fix applies when someone needs it there.)

The generated `plotroom_ask` extension passes no `timeout` to pi's dialog (pi
supports one), and a test asserts the source string contains no timer of any kind;
a dismissed question returns an **error** to the model, never one of the options
nobody picked. Option **labels** must be distinct as well as ids: the label is
what a runtime's select returns and what the extension filters on, so twins would
answer for each other and erase each other from the paths not taken.

**Two decided defaults, recorded here rather than inferred:** a session may send
**3 broadcasts per hour** (`DEFAULT_SESSION_BROADCAST_POLICY` — enough for an
emergency and its correction, few enough to be useless as a channel; the
operator's own broadcasts are unbounded), and continuation needs **20% of the
model's window free** (`DEFAULT_CONTINUE_HEADROOM_FRACTION`, a fraction so it
scales with the model rather than being tuned per model).

**The pi adapter's injection was wrong, and a live spike is what proved it.** pi's
standalone `steer` command queues a message _without triggering a turn_, so an
injection into a live-but-idle session sat in the queue indefinitely — "queued"
forever, the exact failure §6.5 exists to prevent. `inject()` now sends `prompt`
with `streamingBehavior: "steer"`, which queues mid-turn and prompts when idle.
Delivery detection gained a second phase to match: an injection is delivered when
it **leaves a queue pi was seen holding it in**, or at the next `turn-started`
when pi never queued it at all, because pi emits `queue_update` for follow-up
changes too and the old one-phase diff would have reported delivery before the
turn existed. `steering.spike.test.ts` (`PLOTROOM_PI_SPIKE=1`, hermetic and
skipped by default) runs a real pi against a mock provider and shows the
difference in pi's own events: the bare `steer` produces no request to the model,
the injection does.

**Server wiring landed (Batch 3, stage 2, Track A).** Migration 16 is the state
these planners produce at rest — `session_questions`, `broadcasts` /
`broadcast_recipients` / `broadcast_sends`, `handoff_briefs` — and every decision
stays in `core`: the services are the writes, the runtime calls, and the events.

**Injection is three writes before the runtime is touched**, in that order, so an
injection a runtime refuses still left the paper trail §6.5 requires. It answers
`queued` and never `delivered`: delivery is the separate observed fact the driver
already folds, which is what lets a surface show one against the other rather than
inferring it from acceptance. A live runtime that is not attached records the
injection as **refused** rather than leaving it queued for ever — the content stays
on the graph, because somebody authored it, and the ledger says it never arrived.

**Questions needed a driver fix, not only a store.** Every `request-raised`
observation went through the write gate, and that gate's own words are "this gate
answers tool permissions; a question is answered by a human" — so a structured
question from a runtime was denied the instant it was asked. A question is now
raised and left open, keyed by the blocked request so answering settles _that_
call, and the scripted runtime can raise one (`{ "ask": { … } }`), where the act
stops until PlotRoom answers because that is what asking is. No timeout exists
anywhere on the path: the endpoint accepts `escalateAfterSeconds` and passes it to
`escalateAfter`, whose only outcome is `escalate-attention`.

**Broadcast supplies the two things core deliberately does not own.** The world is
built from live sessions plus their workspace records, and **a repository's identity
is its configured source** — a worktree and the checkout it branched from resolve to
one id, which is exactly the fact "everyone in _this_ repository" is about, and it
means two workspaces agree without a registry table (`sessions/world.ts` states the
rule, and `GET /api/broadcast-world` is where a wrong join would be visibly wrong
rather than silently widening what a session may declare). The rate window is rows
rather than a counter, because a counter cannot answer "how many in the last hour"
after a restart. Induced spend is charged from the session stream with **the grain
stated**: the recipient's spend between delivery and the next time its accounting
moved, charged once, with the baseline in a column so a restart between the two does
not lose it — and a delivery the runtime never received is excluded outright, since an
injection that induced no turn must not bill the sender for work their broadcast did
not cause. Charging the recipient's whole session would bill the sender for work
it never caused; charging nothing would be the hole §6.5 names.

One place the server **departs from a core shape, deliberately**: `InjectionContent`
declares `scope: "local"`, which is right for an injection and wrong for a
broadcast, whose one content object is wired into sessions across workstreams — and
§3.3 refuses a local object outside its own. A broadcast's content is therefore
world-scoped. `InjectionContent` carries no workstream at all, so there is no single
workstream it could belong to; §3.2's promotion is the same idea.

**Every steering gesture replays; none of them refuse a retry.** Injection, broadcast,
resume, fork, and handoff all answer a repeated key with what the first attempt
produced (principle 9). Broadcast briefly refused instead, with `already_sent`, and
the divergence was accidental rather than argued: a caller retrying after a dropped
response would have been told its broadcast failed when it had landed, which is the
failure principle 9 exists to prevent. A replayed broadcast is reconstructed from its
recipient rows rather than re-planned, because re-planning would evaluate the scope
against the world _now_ and a session that started since would appear as a recipient
the first send never reached.

The idempotency that makes those replays safe is **id-stable writes**, and two of them
had to become so: `GraphStore.addContextEdge` returns the existing edge when the
caller supplies an id that already exists — short-circuiting every legality check,
because the gesture already happened and was already judged legal, and re-judging it
refuses the retry as a duplicate of itself — and `recordProvenance` is idempotent in
the fact it states, since a fork recorded twice does not make two forks, it draws one
relationship twice.

**A key names one gesture, not one command** (migration 18). Comparing the command
alone let a key be reused across kinds: a run of command X and a fork of one of that
command's sessions both named X, so the second was handed the first one's answer and
called it a retry. The kind is compared too now, and each gesture checks that what the
settled key produced is what _this_ call is about — resume compares the session id,
and fork checks the provenance edge, because two sessions of one command share a
command id and the command comparison alone would hand a fork key the other fork.

_Deferred, honestly: §7.3's per-workstream activity is a **query** over
`broadcast_recipients` (the workstream is on the row) rather than a second table,
which means it is readable but has no endpoint of its own until Phase 6's
what-changed-while-away surface needs one; the `broadcast` event carries both the
attention row and the activity entries, so a subscriber has them now. Preset prompts
(§4.2) are not implemented — `presetPrompt` exists in core and nothing stores a
preset yet. And a batch `archive` archives the member's **workstream**, which is
where §6.8's archive verb lives; archiving one session out of several in a
workstream has no representation, and that is worth a decision rather than a guess._

### Epic 5.3 — Speech bubbles on canvas (`canvas`) — _mechanics landed Batch 3 (Weeks 11–14); live by Stage 2 of the same window (see below)_

- [x] Attributed bubbles per sender node; tool-in-flight chips (§5)
- [x] Constraints: never obscure minimap/controls, width-capped, collapse to counts unfocused, global cap on simultaneous bubbles (§5)

_Landed per the design gate (fleet rule 5): unstyled DOM, mechanics only.
`bubbles/placement.ts` is the pure placement engine — attaches every bubble
to its sender node's current extent, caps width to exactly that node's
width, collapses every source on an unfocused node (focus defined here as
selection or hover, documented at the one call site that decides it,
`PlotCanvas`) to a count badge, and enforces a global cap (default six,
`bubbleCap` prop) with deterministic priority — attention-wanting first,
then recency, then id — folding anything past the cap into its node's
collapsed badge. "Never obscure the minimap" is enforced, not flagged: a
candidate rect that would overlap a `ReservedRegion` (the unstyled
`<MiniMap>`'s own default footprint today; `<Controls>` is not yet rendered
in this codebase) is tried at its opposite anchor, and collapses rather
than draws if neither anchor is clear. `bubbles/derive-sources.ts` feeds
real streams into that engine: a command's dispatched prompt from the live
`GraphSnapshot.warningFacts` assembled-content already flowing to the
canvas, and a session's latest saying / a distinct tool-in-flight chip from
the live `SessionDataSource` (`subscribeTranscript`/`subscribeSession`,
wired per session-role node in `apps/web/src/App.tsx`). Two sources stayed
fixture-fed at first landing, both for the same reason — no stream in the
codebase carried them yet: structured questions and injection queued/
delivered states. **Both went live in the same window** (Batch 3's Stage 2,
once Track A's steering endpoints merged): `createApiQuestionDataSource`
(`bubbles/question-source.ts`) bootstraps every session's questions once
and keeps current off the `/ws` `session_question` entity;
`deriveInjectionBubbleSources` now reads each session's live ledger via the
new `SessionDataSource.subscribeInjections`. Offline/fixture mode
(`VITE_USE_FIXTURES=1`) still falls back to the fixtures — the same swap
`createApiSessionDataSource` already did for its own fixture, now exercised
rather than only promised. Proven end to end by the W14 gate (Epic 5.1's
own landed-note), which also found and fixed a real bug this swap exposed:
every bubble subscription was keyed by session id where it needed the
canvas node id, invisible through fixtures where the two always coincide._

_**Post-landing review fixes** (same window): a node inside a workstream
container — the normal case for a session or command once a workstream
exists, not an edge case — rendered no bubble at all, not even a collapsed
count, because the extent computation only ever looked at top-level nodes
and xyflow reports a contained node's position parent-relative rather than
absolute. `canvas/node-extents.ts` (pure, tested) now resolves every
visible node's absolute position first — a workstream frame is always
top-level in this canvas (§3.3), so a child's absolute position is exactly
its parent's position plus its own — and a source matching no node extent
at all folds into one deterministic `UNATTACHED_BUBBLE_NODE_ID` badge
rather than vanishing (principle 12). Three smaller fixes landed
alongside: the minimap's reserved region is now fed by a
ResizeObserver-backed container size instead of a memo that only
recomputed on pan/zoom, so a window resize with the viewport otherwise
unchanged no longer leaves it stale; every bubble timestamp is epoch
seconds throughout (`BubbleSource.updatedAt`'s doc comment states the
rule) — `SessionBubbleInput.now` (silently milliseconds) is renamed to
`nowSeconds`, and the command-prompt bubble no longer hardcodes `0`, both
of which previously broke the global cap's recency ordering under cap
pressure; and a rendered bubble's height is capped (scroll, not clip) to
exactly the rect `placement.ts` collision-checked, so DOM text wrapping
taller than the `measureLines` estimate can no longer spill into a region
the engine proved clear._

_**Second-look correction:** the contained-node fix above landed inert at
its own call site. `PlotCanvas` built `computeAbsoluteScreenExtents`'s
input by filtering to box nodes first, so every container — the very
thing a contained node's absolute position is computed *against* — never
reached the lookup; the parent id still resolved to something (a
plausible-looking result), found no entry, and silently fell back to no
offset, so every contained node's bubble kept rendering at its bare
parent-relative position, offset by exactly its workstream frame's own
position. `canvas/node-extents.ts` now also exports `toExtentAwareNodes`,
the exact wiring `PlotCanvas` calls — handed the *entire* node array,
containers included, with no filter in front of it — and a call-site-shaped
test (`toExtentAwareNodes` piped straight into
`computeAbsoluteScreenExtents`, exactly as `PlotCanvas` does) asserts a
contained node's position lands at parent.position + child.position; it
fails if a type filter is reintroduced anywhere in that pipeline. The gap
is closed now, where the first pass only closed it on paper._

### Epic 5.4 — Resume, fork, handoff (`sessions`) — _done_

- [x] Explicit resume-vs-fork choice, never implicit on typing (§6.3) — `dispositionOfTypedInput` returns `choice-required` for an ended session, and `SessionContinuation` has no third variant
- [x] Fork from any point → own workstream + workspace; outside-world touchpoints marked (fed by §9.2 reversibility declarations) for fork cleanliness (§6.3, §6.6) — `planSessionFork` plus `outside-world.ts`; the pi adapter's real fork is verified against a live pi
- [x] Handoff: source-written brief, human-edited before send (§6.3) — `draftHandoffBrief` → `reviewHandoffBrief` → `planHandoff`, where sending an unreviewed brief is a type error
- [x] Continue-vs-fresh on re-run: side-by-side cost preview; window-fit gate; divergence forces fresh (§4.3) — `compareContinueVsFresh`, which describes the option it refused as well as the one it allows
- [x] Stop at three scopes with counts and widest-scope confirm (§6.7) — `resolveStop`
- [x] Endpoints for all of the above — Track A's stage 2; landed (see the server note below). _Track B's UI: resume-vs-fork and stop-at-three-scopes mechanics landed Batch 3 Weeks 11–14 (see Epic 5.1's own landed-note and the W14 gate); handoff's brief draft/review flow and continue-vs-fresh's side-by-side preview UI are deliberately deferred — not gate-tested, and neither has UI mechanics yet._

_Landed as `continuation.ts`, `handoff.ts`, `outside-world.ts`, and additions to
`fork.ts`, plus the pi adapter's real fork._

**Typing is not a continuation.** §6.3's "never an implicit consequence of typing
into it" is `dispositionOfTypedInput`: a live session takes text as an injection,
and an ended one has **no disposition at all** until somebody names resume or
fork. `SessionContinuation` is those two variants and nothing else.

**Handoff's order is a type, not a checklist.** `planHandoff` accepts a
`ReviewedHandoffBrief`, and the only producer of one is `reviewHandoffBrief`,
which refuses a session author — so "the user edits before sending" cannot be
skipped, and a test asserts that passing a draft is a compile error. A brief the
session never wrote can be _derived_ from the log (`deriveHandoffBrief`), labelled
as derived and paraphrasing nothing, because there is no model in `core`; §13's
summarised continuation stays a recorded intention.

**Fork cleanliness comes from declarations, and says when it cannot be sure.**
§6.6 names the source of truth ("the same declarations are what mark where a
session touched the outside world... so fork-cleanliness comes from the source of
truth rather than a heuristic"), so `ToolWorldDeclaration` is `local` or
`outside-world` with a reversibility — and an **undeclared** tool produces a third
answer rather than being read as harmless. `ForkCleanliness.state` is
`clean | dirty | unknown`, not a boolean plus a caveat: a boolean `clean` was a
trap, because anything reading it alone turned "nobody declared anything" into
"nothing happened", which is principle 7 exactly backwards. `unknown` is what an
undeclared call up to the point produces, `isCleanForkPoint` is the only thing that
answers yes, and a dirty point that also has undeclared calls says "at least N
writes" because the known count is a floor. A declared write that merely _started_
counts as a touch, because a merge that returned an error may still have merged and
"we are not sure" must never render as "clean". `planSessionFork` **requires**
markers for the same reason: they were optional, and omitting them produced a plan
claiming clean with nothing examined — the caller least likely to derive markers got
the most reassuring answer. A caller with no observation log passes
`NO_OUTSIDE_WORLD_MARKERS` and says so.

**Continue-vs-fresh compares tokens, not invented money.** `estimateRunCost`
prices per _definition_, so both modes inherit the same range and scaling it by a
token ratio would invent precision; the comparison therefore states
`basis: "input-tokens"` and carries each mode's own estimate with its basis
beside it. Continuing a live session is the cheap path; continuing a completed one
brings `historyTokens` back, which is how fresh ends up cheaper. Both gates
collect rather than short-circuit, and the refused option is still fully
described — a preview that hides what it rejected cannot be argued with.

**pi's fork arithmetic was off by one turn, and the spike caught that too.** pi
forks _from_ a user message, so its new branch begins there; PlotRoom forks
_inclusively_ (§6.3: "inherits the conversation up to that point"). The entry to
fork from is therefore the one that opens turn `n + 1`, and at the tip there is no
command to send at all — `pi --fork <ref>` has already produced a session holding
the whole conversation (`resolvePiForkTarget` returns `inherited`). Two other real
defects went with it: a fork an extension cancelled answers `success: true` and
says so only in `data.cancelled`, which the old code read as success; and an
unreachable point raises `PiForkUnavailable` with the half-forked pi process
aborted, rather than leaving one running that nothing drives. The live spike proves
the prefix: a fork at turn 1 of a two-turn session sends the model turn 1 and not
turn 2.

**The adapter does not substitute a seeded fork for a native one.** It briefly did,
which sounds generous and is not: the caller decided `native` from `planFork` and
writes `runtime.mode` from that decision, so a silently seeded session got stored
as a native fork — and a seeded fork is not bit-identical to a native one, which is
the entire reason the two are distinguished. Reporting the substitution back would
have been the second-best fix; not making it is better, because the false mode
stops being _representable_ instead of becoming something the caller must remember
to re-read. So `fork()` either does what it was asked or raises, seeding is the
caller's own `start({ seedTranscript })` branch, and whichever branch ran is the
mode recorded (the contract table's Fork row spells out the two lines).

**Contract for Track A (stage 2).** Everything below is a pure function in
`@plotroom/core`; the server owns persistence, transport, and events.

| Gesture           | Endpoint (catalog `pending`)                                 | Core call                                                  | Effects to persist                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inject            | `POST /api/sessions/:id/inject`                              | `planInjection`                                            | object + version (note), node, **context edge with `author`**, `session_injections` row via `SessionStore.queueInjection` (origin `steering`), then `handle.inject()` → `markDelivered` on the observed `injection-delivered` (the driver already does this) |
| Ask               | `POST /api/sessions/:id/questions`                           | `raiseQuestion`                                            | question record (`SessionQuestion`); a runtime-raised one arrives as `request-raised` and is keyed by `requestId`                                                                                                                                            |
| Answer            | `POST /api/questions/:id/answer`                             | `answerQuestion` + `questionOutcome`                       | answer on the record, then `handle.respond(requestId, outcome)`; `encodeQuestionAnswer` is the structural payload                                                                                                                                            |
| Broadcast         | `POST /api/broadcasts`                                       | `planHumanBroadcast` / `planSessionBroadcast`              | one content object + node, **one context edge per recipient**, one ledger row per recipient, one `BroadcastSend` for the rate window, `attributeBroadcastSpend` rows as recipients spend                                                                     |
| Batch             | `POST /api/batches`                                          | `planBatch`                                                | the member gestures, each keyed by `memberKey`; report `skipped` back verbatim                                                                                                                                                                               |
| Stop              | `POST /api/stops`                                            | `resolveStop`                                              | refuse an unconfirmed `everything`; `count` and `enabled` are the button's own state                                                                                                                                                                         |
| Resume            | `POST /api/sessions/:id/resume`                              | `planResume`                                               | `adapter.resume(runtime.ref, ...)`, then `firstTurn` as a normal injection if present                                                                                                                                                                        |
| Fork              | `POST /api/sessions/:id/fork`                                | `planSessionFork` (+ `planFork` inside it)                 | new workstream, new workspace, new session, `session_forked_from` provenance; `adapter.fork` for `mode: "native"`, `adapter.start({ seedTranscript })` for `mode: "seeded"`                                                                                  |
| Handoff           | `POST /api/sessions/:id/handoff-brief`, `POST /api/handoffs` | `draftHandoffBrief` / `reviewHandoffBrief` / `planHandoff` | brief record, then content + node + **context edge authored by the reviewer** + `session_handoff` provenance                                                                                                                                                 |
| Continue-vs-fresh | in `GET /api/commands/:id/preview`                           | `compareContinueVsFresh`                                   | nothing; render both options, `forcedFresh`, and each `blocks[]` reason                                                                                                                                                                                      |

What Track A must supply that core deliberately does not own: `BroadcastMember`
rows (the graph and workspace records know which repository and workspace a
session stands in — `RepositoryId` exists in `workspaces/ids.ts` and is unused
until this), the `ToolWorldDeclaration` map (integration write actions declare it
per §9.2; until Phase 7 there are none, so cleanliness reports `certain: false`
wherever a session called an undeclared tool), `ToolTargetIndex` resolutions for
the six new lineage-checked tools (each states its required resolution in
`requires.targetResolution`), and two additions to the event vocabulary:
`BroadcastAttention` for the queue and `BroadcastActivityEntry` per recipient
workstream (§7.3). Ids are the caller's throughout, so a retried gesture writes
the same rows.

Deferred, honestly: nothing here is persisted or reachable — the endpoints are
`pending` in the catalog and its test fails the moment one appears without a tool
(or a tool stays `pending` after its endpoint lands); questions have no store, so
`SessionQuestion` is a shape until Track A gives it a table; the rate-limit window
is a query over sends Track A records; and the pi fork mapping assumes pi's k-th
forkable user message opens PlotRoom's k-th turn — true for how PlotRoom drives pi
(one user message per turn, injections included) and now demonstrated by the
spike, but a pi release that changes what `get_fork_messages` lists would break it
quietly, so that spike is the thing to run against a new pi. One shape is knowingly
left loose: `senderSharesScope` reads membership from the `BroadcastWorld` Track A
builds, so a wrong `repositoryIds` join would widen what a session may declare — the
rule is stated once and enforced once, but its inputs are the server's to get right.

**Server wiring landed (Batch 3, stage 2, Track A).** The contract table above is
implemented row for row, and the fork row's two lines are the part worth reading
twice: a `native` verdict calls `adapter.fork`, `PiForkUnavailable` is **caught by
the caller** and re-run as `start({ seedTranscript })`, and whichever branch ran is
the mode recorded (migration 16 adds `sessions.runtime_mode`). The adapter's refusal
to substitute one for the other is what makes that column trustworthy.

**Both §6.3 gestures enforce §4.1's lineage rule, and the handoff enforces its own
`humanOnly`.** `session_resume` and `session_fork` declare `target-session`
reflexivity and briefly enforced nothing, which let a child resume or fork its own
ancestor — principle 1 bypassed with money behind it. Both call `checkRunGesture`
before anything is recorded, and before the idempotency lookup: a caller that may not
make the gesture may not retry it either, and a retry is not a way to launder one. The
fork's check sees the **source** and never the descendant it is about to create, which
is what the catalog's own resolution says in capitals. `session_handoff` declares
`humanOnly` and now refuses a session actor at the service, for the same reason the
review step does: the brief exists because a human decided this work should move, and
a session sending it is that decision not being made. `log_level_get` / `log_level_set`
declare it too and are gated the same way — what a session would do with it is the
point, since turning the log down is how you make your own behaviour harder to see (§8).

Resume reopens **the same record**, which is the whole difference from a fork, and
two things about it were only discovered by testing it. The previous handle's pump
has an end still to record — a stop writes the outcome before it touches the runtime,
so the `session-ended` observation is always behind it — and a record reopened
underneath it inherits that end, reporting a running session as finished. So the old
pump is drained (bounded) and let go of before anything is reopened. And a resumed
session's **node** has to go back to running: §3.7 only lets content wire into a
running session, so a node left marked otherwise refuses the very first turn the
resume delivers. Idempotency is checked **before** `planResume`, because once a
resumption has happened the session is running and `planResume` would answer
`already_running` — the right answer to a new gesture and the wrong one to a retry of
the same one (principle 9).

Continue-versus-fresh is its own read (`GET /api/commands/:id/continuation`) rather
than a field on the run preview: it needs the workspace fingerprinted and the prior
session's transcript measured, and the run preview is a cheap read that provisions
nothing. Both required inputs are real — the window comes from the command's declared
model window, and the divergence from the workspace as it stands.

A handoff's completion is **part of its settled state**, not a step after it. The
brief's graph writes and `markSent` used to run only on the first attempt, which left a
crash window with teeth: the session is started and its key settled inside
`startHandoffSession`, so a process that died between that and the writes made every
retry take the replay path and skip them **permanently** — a handoff whose brief was
never wired into the session it seeded, and a brief still marked unsent and therefore
re-sendable. They run on every attempt now, each idempotent in an id the plan supplied,
and `markSent` is last so a crash before it leaves the brief re-sendable rather than
sent with nothing to show for it. The `already_sent` refusal is checked **after** the
key, so it still refuses a second gesture and no longer refuses a retry of the first.

**The integration harnesses take their ports from the OS.** Every server-side suite
used a static per-band counter, and a band is still a guess: a leaked server from an
earlier run, another suite, or anything else on the machine can already hold a port in
it — and the failure is not always a clean `EADDRINUSE`. It can be requests landing on
_the other server_, which surfaces far away as an unrelated refusal, which is exactly
how the last round's initiation-key mystery presented. `ephemeralPort` (a throwaway
bind to port 0, read back, closed) is shared from `testing/harness.ts` and used by all
five suites; the two synchronous ones reserve a pool up front so their call sites stay
synchronous without keeping the guess. There is a narrow window between closing the
probe and the child binding — acceptable for test tooling, and strictly safer than a
counter. `apps/server` cannot simply bind 0 itself: `startServer` reports the
_configured_ port, so a caller asking for 0 would not learn which one it got.

_Deferred, honestly: a command definition carries **no** default continuation mode
yet, so the comparison uses the shipped default and says so rather than guessing per
command — the field is a definition change nobody has needed yet. `ToolWorldDeclaration`
is empty, so fork cleanliness answers `unknown` wherever a session called an
undeclared tool, which is the honest answer and not a defect (§9.2 fills it in Phase
7). A handoff's new session is `open` and metered against a default window, because
no command definition stands behind it; the meter is labelled estimated either way.
And `dispositionOfTypedInput` has no endpoint: the choice is explicit in the API's
shape — two endpoints and no third — rather than a thing a client asks about._

### Epic 5.5 — Scoped runs and the queue of work (`runs`) — _done_

- [x] Run subgraph (dependency order; pauses on failure/out-of-budget; stop aborts remainder) (§4.1)
- [x] Run what's missing: never-disabled run affordance; "waiting on…" with reveal-and-run-upstream, asked once (§4.1) — _the server half: the scoped preview names what each blocked command is waiting on and the scope that would unblock it, and one confirmation covers the chain. The affordance that renders it is Track B's_
- [x] Re-run all drifted: per-workstream and fleet-wide (§4.1)
- [x] Global concurrency limit with visible, cancellable queue; **preview is the contract** — drifted inputs re-ask instead of silently running (§4.1)

_Landed as `apps/server/src/runs/{scopes,queue,drift}.ts` over migrations 13 and
14, plus `routes/run-queue.ts`. Five things about it are load-bearing:_

- **A scope resolves to an ordered list of commands and nothing else.** The
  dependency relation is read off the graph (a command depends on another when one
  of its context inputs is that command's output placeholder, or the object the
  placeholder bound to) rather than declared anywhere, so there is no second notion
  of "depends on" to disagree with the canvas. Ordering is Kahn's algorithm over the
  scope with a deterministic tie-break; a leftover cycle is appended rather than
  dropped, because silently losing a command from a scope the operator confirmed is
  worse than an imperfect order.
- **Drift is derived, never stored, and never acted on.** `deriveBoardDrift` builds
  `@plotroom/core`'s `DriftGraph` from what each command's **newest** run consumed
  (every historical run consumed something older, so counting them all would report
  every command as permanently drifted) and asks `deriveDrift`. "Re-run all drifted"
  reads the `attention` half, so acknowledged/snoozed/muted drift is not re-run
  (§4.5), and a scope with nothing drifted is refused as `empty_scope` rather than
  producing an empty batch.
- **THE PREVIEW IS THE CONTRACT, as a hash.** Every queue entry records
  `sha256(configuration + every input's version and content hash, in assembly
order)`. At admission the preview is taken again and compared; a mismatch does not
  run — the entry becomes `needs_reask` with a sentence naming which inputs moved,
  and only `POST /api/run-queue/:id/confirm` (which replaces the contract with the
  current one) queues it again. Configuration alone would miss an edited input;
  versions alone would miss an edit that produced identical bytes; the ordinals are
  what make "assembly order is edge order" (§3.5) part of what was agreed rather
  than an accident of it.

- **The in-batch rule, decided.** A subgraph or what's-missing scope is one gesture
  over a chain the operator previewed **as a chain**: they were shown that the
  downstream command consumes the upstream command's output. So when the upstream
  runs and binds that output, the downstream's input appearing is **the contract
  executing, not the contract drifting**. Inputs produced by another command in the
  same batch are therefore excluded from that entry's hash, and so is `runnable`,
  whose flip from false to true is caused by exactly that binding. Without the rule
  a batch of two could never finish: it would stop halfway to ask the operator to
  confirm the thing they had just confirmed. Two details make it hold rather than
  half-hold — the exclusion set is derived from the batch's own command list (stable
  for the batch's life, so the set computed at enqueue and at admission cannot
  disagree), and it covers both spellings of a produced input, the output
  placeholder and the object it later bound to, because a downstream input node
  points at the first before and the second after. **Drift from outside the batch is
  untouched**: an input the batch does not produce is exactly as binding as before,
  and re-asks. The second half of the same rule is an admission gate: an entry whose
  in-batch producer has not finished is not admitted at all, so it waits rather than
  being run and refused for an input nothing had produced yet.

  The gate asks three questions, not one, because asking only "is the producer
  done?" stranded the downstream for ever the moment a producer failed, was
  cancelled, or was interrupted — **"not done" and "not finished yet" are different
  facts**, and a run waiting on a settled producer is waiting for something that is
  not coming. So: a producer still to run means **wait** (the entry stays queued); a
  producer that settled without producing, where the output is still unbound, means
  **this can never run** — the entry is settled `cancelled` with a reason naming the
  producer, at the queue rather than down the run path, which would have provisioned
  a workspace before refusing and recorded the refusal as this command _failing_
  when it never started; and a producer that settled while the output arrived
  anyway means **ready** — the ordinary contract check then re-asks, because
  somebody supplying that input another way is a change to what this would assemble.
  Abandonment is decided before waiting: one dead producer makes an entry unviable
  however long its other producers take. Cancelling an entry drains for the same
  reason — the entry it just made unviable should hear about it from the gesture that
  caused it, not from whatever unrelated session ends next.

- **The queue is admission, and it has no timer.** It subscribes to the session
  event stream and drains when a session ends — including a session that never went
  through it, since an ordinary run under the limit holds a slot too. Nothing the
  product decides can enqueue (principle 2).

  Three things keep that loop honest, each of which was a defect first. Draining is
  serialized by a flag _and_ re-runs when a drain arrives during one, because two
  overlapping drains would each see the same free slot while a swallowed one leaves
  a slot free with nobody to notice. The loop never considers an entry twice in a
  pass, and the admission path always moves the row it declines: either brace alone
  leaves a hung server one forgotten branch away, and a queue that spins is worse
  than a queue that refuses. And a session that ends _before_ the row naming it is
  written — a scripted or instantly-failing run gets there while `runOne` is still
  returning — is settled by looking at what already happened right after the
  binding, because the event that would have settled it found no entry to settle.

  **At boot the queue is reconciled and drained once.** An entry it believes is
  running has a session whose outcome nothing applied, so it is settled from that
  session's real end state — `interrupted` where that is what happened, which is
  neither `done` nor `failed` (principle 11), and which pauses the batch so a human
  addresses it. An entry admitted but never bound to a session goes back to
  `queued`, where its contract is re-checked like any other rather than assumed
  still true. Then one drain: every entry it admits was already initiated by a
  gesture, and a restart does not un-initiate one, so admitting it is §4.1's "the
  system is only deciding _when_, never _whether_". Refusing to admit at boot would
  mean a restart silently dropped work somebody asked for.

- **The limit bounds initiation, not one endpoint.** `POST /api/runs` goes through
  the same admission: **201 `{run, session, status}`** when a slot was free
  (unchanged, and what the W10 gate still gets under the shipped default of four),
  **202 `{queued, run: null, session: null}`** when it was admitted and is waiting.
  A caller reading `session.id` unconditionally fails loudly on a 202 rather than
  proceeding with a session that does not exist yet. Migration 14 carries the
  runtime the caller named on the entry, because running the same content on a
  different runtime is a different run. **Track B's run affordance should render the
  queued position for the 202 case** (cross-track follow-up).

_A batch pauses on a failed, out-of-budget, or interrupted session and is resumable
by a human gesture only; a user stop **aborts** the remainder and an aborted batch is
refused a resume, because stopped means stopped. The switch from a session end to an
entry outcome is exhaustive by assertion — `end satisfies never` in the default
branch — so a seventh end kind fails to compile rather than being quietly recorded as
success, which is exactly how an interrupted run used to be reported as done. The
assertion is the whole mechanism and not decoration: a `switch` of bare `return`s
over a union compiles happily with a case missing, so "no `default`" on its own
proves nothing, which an earlier version of this note claimed it did. `GET /api/run-batches/:id` returns every entry
including settled ones, because a paused batch's failed run is precisely what
"address it and resume" is about._

_Confirming a re-ask answers to the **batch**, not only to the entry: into a paused
batch the contract is accepted and the entry parked, so the operator's answer is kept
and resuming remains the separate gesture that starts the remainder; into an aborted
or completed one it is refused, because there is nothing left for a confirmation to
start. Resuming settles the batch if the resume found nothing to do — a batch of one
whose run a restart interrupted has nothing left, and resuming it is exactly what the
pause instructs, so the remedy must not be how the batch gets stuck at "running" with
nothing running. Admission order across batches is gesture order first (`enqueued_at`) with the
scope's dependency order as the tie-break, so a batch admitted this minute cannot
overtake one admitted an hour ago just because both have a position 1._

_Deferred, honestly: the scoped estimate aggregates the per-command ones and says so
in its own sentence — a scope where only some commands have priced history has an
incomplete range, and the range is `null` rather than zero when none of them do;
`unblockWith` is always `missing` because that is the only unblocking scope §4.1
names; and the spend cap is recorded per run in the scope and enforced by Phase 6,
not here._

_**Two known defects in the record rather than in the code**, because fixing either
means editing something that must not be edited or making a decision that is not this
epic's:_

- _`spend_attributions.session_id` **cascades** on a deleted session, while the
  migration's own comment beside it says the row survives. The cascade is the
  behaviour — deleting a session deletes what it was charged — and the comment is
  wrong. It is left wrong on purpose: migrations are append-only, and a comment inside
  a migration's SQL is part of that migration. Correcting it means a new migration,
  which needs the decision the comment is really about — what a spend total means once
  its spender is gone (§8 with principle 10). Recorded here, which is where a reader
  looks, rather than silently rewritten where they will not._
- _**The in-batch exclusion has an edge it does not cover.** An input excluded because
  the batch produces it stops being watched for the rest of that entry's wait, so if a
  human edits the produced object after the upstream bound it and before the
  downstream is admitted, the downstream does **not** re-ask — it runs against the
  edited content. Nothing silently wrong happens (the run records exactly what it
  assembled, §15-1), and the window is the seconds between one command finishing and
  the next starting, but it is a real hole in "the preview is the contract" and it is
  the price of the rule: telling a hand edit apart from the upstream's own write needs
  the claim ledger's authorship (§3.4), which knows who wrote a **path** and not who
  wrote an **object**. It closes when object writes carry the same attribution
  workspace writes already do._

---

## Phase 6 — Attention, accounting, budgets

**Goal:** the control-tower half: one attention derivation rendered everywhere, and spend that makes agent-initiated work safe.

**Exit criteria:** the queue answers questions/approvals/drift without opening anything; budgets bind transitively; a capped session ends as out-of-budget, not failed.

### Epic 6.1 — Attention system (`attention`) — _UI surfaces landed, Stage 1 of 2 (Batch 4, Weeks 15–18); fixture-fed — derivation and outbound routing are Track A's Stage 2_

- [x] One derivation, many surfaces: node state, off-screen marker, header, window title, badge, system notification (§7)
- [x] The queue: single ranked keyboard-driven list; rows answerable in place; selection navigates the canvas (§7.1)
- [x] Feeds: questions, approvals, drift, health alerts, completions — each with acknowledge/snooze/mute (§7.1, §4.5)
- [ ] Health alerts from observation only: idle, spinning, conflict-predicted (cross-workstream path overlap + intra-workstream waitlist overlap), unanswered, blocked-on-you with claim-wait thresholds (§7.2)
- [x] What-changed-while-away: capped per-workstream event history, entries route to targets and tolerate their absence (§7.3)
- [ ] Outbound notification routing: state-attached routes (push/webhook), edge-triggered, redacted (§7.3)

_Landed as `packages/ui/src/attention/` (Track B, Batch 4 Stage 1): every
surface named above is real mechanics against `AttentionDataSource`
(`attention/types.ts`), not a mockup — ranking, traversal, and the three
triage verbs all work exactly as they will once a live source replaces the
fixture, because `createFixtureAttentionDataSource` is the one
implementation of the exact interface a server-side one will satisfy 1:1
(the contract is recorded in `docs/attention-contract.md` for Track A).
Health-alert derivation (§7.2, from observation) and outbound notification
routing (§7.3, push/webhook) are explicitly out of this stage — both need
Track A's Stage 2 backend (session health signals, a routes store) that does
not exist yet; their in-app-surface halves (a `health` feed item and its
rendering, an edge-triggered in-app system notification) are landed and
waiting for real items to flow through them. Six feeds, not five: a
`broadcast` row (§6.5's "a session-originated broadcast appears in the
queue") was added in review, alongside a normative fix making
hide-while-snoozed/muted explicitly the *data source's* job (never a
surface re-filtering with its own ledger — `queue.ts#rankAttentionItems`
is what a surface calls; `visibleAttentionItems` is what a conforming
source calls over its own real ledger before it ever emits). The queue's
j/k traversal (plus Enter to navigate the highlight, and 1–9/a/d to answer
it in place), the edge-triggered/batched notification decision, and the
what-changed capped history with its honest tombstone are all pure and
unit-tested (`attention/*.test.ts`, 38 tests — `off-screen.test.ts`'s own 5
predate this stage and are not counted here)._

### Epic 6.2 — Budgets and spend (`budgets`) — _done: enforcement and data (Track A) + the two panels (Track B, Stage 1)_

- [x] Persistent spend accounting per session / workstream / fleet; totals outlive sessions (§8)
- [x] Budgets at run/batch, workstream, global scope; **shipped default global ceiling** (§8, principle 2)
- [x] Sessions can read remaining budget that binds them; near-cap defined behavior: stop cleanly, wrap up, report (§8)
- [x] Out-of-budget as its own end state everywhere it renders; retries never blindly re-run it (§3.6, §8)
- [x] Broadcast-induced and delegated spend charged up the initiating chain (§6.5, §3.6)
- [x] Fleet panel: today's total, biggest spender, running vs concurrency limit (§8, §11) — _the **data** is `GET /api/fleet`; the panel landed with Track B's Stage 1_
- [x] Session timeline panel: temporal turns/tool-calls view, works for finished sessions (§8, §11) — _the **data** is `GET /api/sessions/:id/timeline`; the panel landed with Track B's Stage 1_

_Landed (Batch 4, stage 1 — Track A). **The tightest budget that binds wins, and it
binds transitively.** `resolveEffectiveBudget` in `@plotroom/core` is the whole rule
and the only place it is stated: the pre-run refusal, the session-facing read, and the
mid-session enforcement all call it (principle 8). What binds a session is its own
run's cap, **every ancestor's** run and batch caps, each of those sessions'
workstream budgets, and the global ceiling — an ancestor's cap counts that ancestor's
attributed total, which already includes what its chain delegated, so a child cannot
spend a cap it never accepted. Nothing throws: reaching a cap is `at-cap` with the
tripped binding named, and the caller records **out-of-budget**, which is its own end
state (§3.6) — a live test delegates, lets the child accrue scripted cost against the
parent's cap, and asserts the **child** ends out-of-budget with `failed: false`,
`safeToRetryBlindly: false`, the run recorded as `out_of_budget`, and the parent told
why in words that say it did not fail.

**Enforcement happens where spending is observable**, not on a schedule: the pump calls
`onAccounting` when the fold's cost moves, which attributes the spend up the chain and
then asks. There is no timer anywhere in it (principle 2), and a daily period is a
**window over the ledger** taken at check time — spend rows are never zeroed, which is
what makes §8's "totals do not reset" true of a `day` budget as well. One consequence
is worth stating: attribution now happens while a session runs rather than only when it
ends, so a running session's cost appears in the fleet total — previously it did not,
and a fleet view is read precisely while work is in flight.

**The shipped default global ceiling is $25/day**, seeded as a row by migration 20 so
it is visible, raisable, and removable-for-good (recorded in AGENTS.md with the
reasoning). **Budget writes have no agent tool at all** — principle 1 forbids a session
raising the budget that binds it, and lowering one is not a gesture the spec asks for —
so `POST /api/budgets` and `DELETE /api/budgets/:id` are declared operator-only, while
`session_budget_read`, `workstream_budget_read`, `budgets_read`, and `fleet_read` are
§8's "a session can see what remains". Near a cap the session is **told once** — from a
`budget_notices` row, so a restart cannot repeat it — with the remaining figure, the
instruction to wrap up cleanly, and §8's own words that racing the budget is a failure
mode rather than a saving.

The scripted runtime needed no new step: a script accrues cost by reporting
`turn-ended.usage.costUsd`, exactly as a real adapter does, with a `delay` between
turns so enforcement lands where a runtime accepts input. That recipe is documented in
`apps/server/src/runtime/scripted.ts`. `out-of-budget` remains **not expressible** in a
script: PlotRoom initiates budget stops.

Deferred, and honest about it: the **two §11 panels are Track B's** — this landed the
data endpoints they read (`GET /api/fleet`, `GET /api/sessions/:id/timeline`) and
nothing that renders. A queue entry's `state` still records an out-of-budget run as
`failed` with `detail: "out-of-budget"`; the distinction is kept in the batch's pause
reason, the entry's detail, the session record, and the events (all asserted), and
widening `run_queue.state`'s CHECK is a migration deliberately not taken here. The
UTC day boundary is stated rather than configurable (Epic 8.3's settings). Broadcast-
induced spend is charged by Epic 5.2's existing attribution path, which these budgets
now enforce against; nothing about that path changed._

_The Fleet panel (`packages/ui/src/fleet/`) aggregates real data from what
exists on main today — `GET /api/sessions` (running vs total) and each
session's own `GET /api/sessions/:id/spend` (today's total and the biggest
spender, real per-entry timestamps) — not a fixture standing in for missing
endpoints. **One genuine gap, recorded rather than faked:** the concurrency
limit's configured *value* has no read endpoint anywhere (`apps/server/src/
config.ts` resolves it at boot and never publishes it); `createApiFleetDataSource`
takes it as a parameter defaulting to the shipped default, with a `TODO`
in `fleet/types.ts`/`fleet/data-source.ts` naming exactly what a fleet
aggregate endpoint should add. `queuedCount` counts only entries in the
`queued` state (`@plotroom/core`'s own `isQueuedRunStartable` predicate) —
`GET /api/run-queue`'s `queued` array also carries `starting`/`running`/
`needs_reask`/`paused` entries, which hold a concurrency slot or are
mid-flight rather than admitted-but-waiting, and an earlier version of this
panel counted all of them (a review-caught over-count). The Timeline panel
(`packages/ui/src/timeline/`) lays out turns and tool calls
time-proportionally from `GET /api/sessions/:id/observations`, already live
on main — no gap there. 15 tests (`fleet/derive.test.ts`,
`fleet/data-source.test.ts`, `timeline/layout.test.ts`)._

### Epic 6.3 — Approvals (`approvals`) — _domain landed; server and surfaces pending_

- [x] Approval raise/answer semantics: the record outlives the call it blocks, approve-once or deny **with a reason returned to the session structurally** (§6.6) — `approvals/approval.ts`
- [x] One payload every attention surface renders, answerable without opening the session (§6.6, §7.1) — `approvalAttention`; the queue rendering it is Track B's (below)
- [x] Pre-grants per session / per workstream (§6.6) — `approvals/pre-grants.ts`, deny-wins precedence, `humanOnly` enforced
- [x] Irreversibility pierces pre-grants: irreversible integration writes always ask (§6.6, §9.2) — structural: an irreversible ask has no pre-grantable form
- [x] Agent-requested destruction of authored state routes through approvals; recoverable regardless (§6.6, principle 10) — `decideDestruction` over catalog metadata
- [ ] Endpoints, stores, events, and the gate/claim-wait wiring — Track A's stage 2, against the contract below
- [ ] The queue row that answers one in place, and the other four surfaces (§7, §7.1) — Track B's Epic 6.1, over `ApprovalAttention`

_Landed as `@plotroom/core`'s `sessions/approvals/` subtree plus the write gate's
second axis. **One record, one evaluator.** Approvals already existed in two shapes
before this epic — a claim wait no policy covered (§3.4, `claimWaitReason`
returning `"approval"`) and a write-gate raise for a write extent nothing declared
— and they are the same event to the operator, so they are one vocabulary
(`ApprovalAsk`, four kinds) rather than two feeds that happen to look alike. Every
raise path goes through `decideApproval`; a second evaluator would be the one that
forgot §6.6's piercing rule._

**Irreversibility pierces pre-grants, structurally.** `evaluatePreGrants` does not
take an `ApprovalAsk`. It takes a `PreGrantableAsk`, whose only constructor is
`preGrantable`, which returns `null` for an irreversible ask — so a coverage verdict
for a merge is not refused at runtime, it cannot be written down.
`pre-grants.test.ts` asserts that with `@ts-expect-error` (live: core's
`tsconfig.tests.json` typechecks tests, and the guard was proven by regression —
making the call legal fails the build with `TS2578`). `WriteReversibility` gained a
third value, `"unknown"`, collapsed to irreversible by `isIrreversibleWrite`
(principle 7): a two-valued type forced a plugin author who genuinely could not tell
to pick, and the pick would have been the value that interrupts nobody.

**The gate's hole this closed.** `decideToolPermission` used to answer `allow`
immediately for a write intent of `none`. An outside-world write writes no workspace
path, so `github_merge_pr` was allowed outright — §6.6's rule could not be a branch
of the claim check, because the claim check never ran. The gate now builds the ask
from **both** axes (write extent from `WriteIntent`, world effect from
`ToolWorldDeclaration`) before it decides anything. And a pre-grant answers only
whether an approval is needed: the claim manager is still asked about every path,
because a pre-grant that pierced a claim would be a second writer on one path
(principle 4).

**Every declared external write asks; irreversibility decides whether a pre-grant
can answer for it.** The two rules are separate and both are enforced. A declared
**reversible** write to an external system raises unless a pre-grant covers it —
§6.6 lists "a write to an external system" among what a session raises an approval
for, and §9.2 makes each write action's agent tool "subject to approvals". A declared
**irreversible** one raises regardless. This was wrong when first landed: a reversible
external write with a `none` write extent was allowed as not-gated, which made every
`integration-write` pre-grant **vacuous** — with nothing left for one to authorize,
"irreversibility pierces pre-grants" pierced nothing. The fix is a distinct trigger
(`external-write`) rather than a special case at the call site, and the test asserts
the contrast: the same call raises with `preGrants: []` and is allowed with the grant,
so a pre-grant test can no longer pass by covering a call that was never gated.

**One decision stated rather than left to a reader.** An **absent** world
declaration does not raise. A tool nobody declared costs certainty about fork
cleanliness (§6.3, already reported as `unknown`) and is still bounded by its write
extent — an unbounded one raises on its own — but reading "undeclared" as
"irreversible" would raise an approval for every file read, and an operator
approving a hundred reads an hour is reading none of them. §6.6's rule is written
about _declared_ write actions, and `"unknown"` is what a declaration says when it
cannot tell. The honest cost of that, now written into the gate's own docstring:
**claims are only enforceable over declared paths**, and a tool mis-declared `none`
executes ungated. The declaration is the trust boundary — principle 7 cuts both ways,
since PlotRoom neither guesses at what a tool writes nor second-guesses an adapter
that said — which is why `UNKNOWN_WRITE_INTENTS` is the default and why each entry in
`PI_KNOWN_WRITE_EXTENTS` cites the version it was verified against.

**An answer settles the gesture it was raised for.** `settlesAsk` matches an
approval's tool and target against the ask being decided, inside `decideApproval`, so
an approved `object_delete` on `obj_1` does not authorize `object_delete` on `obj_2`
— a mismatch asks again (principle 9). It is enforced in the decision rather than
stated as a requirement Track A has to remember, which also means the destruction path
and the gate cannot each get it slightly differently.

**Two answers, and no third.** Approve-once or deny-with-a-reason. There is
deliberately no "always allow": a durable grant is a `PreGrant`, the operator's own
gesture with its own record, and folding it into an answer would have been a back
door through the piercing rule — "approve always" on a merge is exactly the covering
pre-grant the type system refuses. A denial **must** carry a reason
(`deny_needs_reason`), because deny is feedback: `encodeApprovalAnswer` returns
`disposition: "not-this-way"` and nothing marks the session failed.

**Destruction class is catalog metadata.** `requires.destroys` on the six tools that
remove authored state, pinned in both directions against `approval: "always"` by
`destruction.test.ts` — so a new destructive verb joins the class by declaring one
field, and a `DELETE` that hands capability back (`claim_yield`,
`run_queue_cancel`, the two withdrawals) is provably not in it. A destruction ask is
_reversible_ and therefore pre-grantable, which is not a loophole: every one is a
soft delete with an inverse, so the piercing rule has nothing to pierce. It still
always asks absent a pre-grant. `checkDeletion` stays the store's last line — a
call site that forgot to route through `decideDestruction` fails closed.

**Contract for Track A (stage 2).** The domain decides; the server persists and
exposes. Nothing below needs a new rule invented:

- **Store shape.** `approvals`: id, session_id, workstream_id, kind
  (`tool-permission|claim|destruction|integration-write`), `ask_json` (the whole
  `ApprovalAsk` — the record must answer "what was asked" after the call settled),
  request_id, call_id, raised_at, answered_at, answered_by (author kind + session
  id, `NOT NULL` once answered), decision, deny_reason, pierced_pre_grant_id +
  pierced_description. `pre_grants`: id, scope_kind + session_id/workstream_id,
  effect, kinds_json, tool_pattern, extents_json, granted_by, granted_at,
  withdrawn_at. Two CHECKs make illegal states unrepresentable, in the shape
  migration 11 established: a `deny` answer with no reason, and a `granted_by` that
  is not human. Retire rather than delete a withdrawn pre-grant — a withdrawal and a
  never-granted rule are different facts.
- **Endpoints.** `GET /api/approvals` (unanswered by default, `?sessionId=`),
  `POST /api/approvals/:id/answer` `{decision, reason?}` (operator-only; a session
  answering is refused by actor, not by the tool catalog's flag),
  `GET|POST /api/pre-grants`, `DELETE /api/pre-grants/:id`. The two agent-facing
  tools are `approval_inspect` (read what you are blocked on) and nothing else —
  answering and granting are both `humanOnly`, so the catalog gains one `pending`
  read tool and two operator-only mutations, exactly as the claim tools did.
- **Events.** Two entities on the one stream: `approval`
  (`created` on a raise, `updated` on an answer, no `deleted` — an approval that was
  asked stays asked) carrying the whole record plus `approvalAttention(...)`, and
  `pre_grant` (`created`, `deleted` with a reason). **`packages/core/src/events.ts`
  was deliberately not edited by this track** — Track A owns it this batch for
  budgets — so the two `DomainEventBody` variants are A's line item, and the payload
  types they carry already exist and are exported.
- **Gate integration points.** `createSessionGate` passes three new fields into
  `decideToolPermission`: `world` (the adapter's `ToolWorldDeclarations`, still
  `NO_TOOL_WORLD_DECLARATIONS` until Phase 7 declares any), `preGrants` (the
  session's plus its workstream's, live rows), and `workstreamId` (it already reads
  the session for it). Then: `decision.raisesApproval` → raise from `decision.ask`
  and `decision.piercedPreGrant`; `decision.coveredBy` → **log the silent allow**
  (§6.6 says pre-granted work proceeds, and an unlogged capability is one nobody can
  audit); an answered approval settles the blocked request with
  `approvalOutcome(...)`, and `approvedCallIds` is how the answer reaches the next
  decision for the same call. The claim path gains one line too: a wait whose
  `claimWaitReason` is `"approval"` raises one of these with `claimAsk(...)`, so the
  queue shows one kind of row instead of two. Passing an `Approval` into
  `decideApproval` needs no care about _which_ one: `settlesAsk` refuses an answer
  raised for another tool or another target, so looking one up by session is safe.

**Alignment with Track B (Epic 6.1).** `ApprovalAttention` is the payload, and it is
built in core for the reason `BroadcastAttention` is: five surfaces wording one
approval five ways is worse than no approval feed. It carries what answering needs —
`sentence` (already redacted, so it is safe on an outbound route, §7.3),
`irreversible`, `piercedPreGrant`, and `answers`, which is the two options with
`requiresReason` on the denial, so the queue renders the same buttons the panel does.
It returns `null` once answered: the feed ranks what is still asking. `isAnswered`
stays `questions.ts`'s name and approvals use `isApprovalAnswered`, because a surface
importing both from `@plotroom/core` must not have to know which one it got.

_Deferred, honestly: pre-grants match on **tool patterns, kinds, and write extents
only** — not on paths. Paths are claims' business (§3.4) and a pre-grant that also
scoped paths would be a second path-authority to keep in agreement. "A command to
run", which §6.6 lists among the things a session may request, has no ask builder
yet: the run path's own lineage and budget checks (§4.1) are what refuse it today,
and routing it through here is Epic 6.2's boundary rather than this one's._

### Epic 6.4 — Run comparison and cross-run outcomes (`runs`) — _done (endpoints; no UI)_

- [x] Pin/unpin runs; downstream follows newest by default, pinnable to `output@n` (§4.4)
- [x] Compare two runs: inputs, outputs, model, cost (§4.4) — pays off §15-1
- [x] Cross-run aggregates per definition: attempts, typical failures, cost (§4.4)

_Landed (Batch 4, stage 1 — Track A). **The comparison reads what each run recorded and
nothing else**, which is §15-1 being spent: `compareRuns` in `@plotroom/core` takes two
recorded runs and pairs their inputs by position (naming `same` / `content` /
`replaced` / `added` / `removed` from the version and hash each run stored), their
outputs by name, their configurations field by field — "which model" plus everything
else that explains a difference — and their costs. **Runs of different definitions are
refused with the reason**, because a side-by-side of two recipes invites reading a
difference in instruction as a difference in outcome; two runs of the same definition in
different command nodes are comparable, which is the grain retention and cost estimation
already use. The assembled bodies are **addressed rather than inlined**
(`/api/runs/:id/assembled` for both), so a diff is derivable without the comparison
carrying two whole contexts. `GET /api/runs/:id/compare?with=<runId>`.

`GET /api/command-definitions/:id/outcomes` is the cross-run aggregate: attempts, the
end-state histogram, how many attempts a completion typically takes, submission
attempts per run, and cost — **through the same `estimateRunCost` the run preview
shows**, so a cross-run cost and a pre-run estimate cannot disagree. The histogram
keeps `out_of_budget` and `interrupted` as their own rows: folding either into `failed`
is what would make "is delegating this kind of work actually working?" answer wrong.
With no retained runs it says nothing has been observed rather than reporting zeroes.

Pin/unpin already reached everything a run references (§15-3's tests cover it); what
landed is that it **publishes** a `run` event, because pinning changes what a run's
future is — "pinning is how a run becomes comparable forever" (§3.7) is not a state to
discover on a refetch. It stays operator-only. Deferred: nothing renders any of this
(Track B), and there is no stored diff — by design._

---

## Phase 7 — Plugin platform and integrations

**Goal:** everything outside the core model as plugins, with the in-box four proving the contract.

**Exit criteria:** GitHub, Jira, Filesystem, and Coding/git run as plugins on the public contract; a throwing plugin degrades to "unavailable," never a product that won't start.

### Epic 7.1 — Plugin contract and host (`plugin-sdk`)

- [ ] Contract: concept producers, write actions, agent tools, content renderers (incl. deltas), card renderers, panels, palette entries, workspace kinds, condition checks, notification routes, command definitions, themes (§10.1)
- [x] worker_threads host with failure isolation (throw/hang/load-fail → plugin unavailable, reported) (§10.2) — _skeleton landed early (W1–3): load/health/ping/dispose with isolation tests; the contract surface freezes here in Phase 7_
- [ ] Declared permissions granted by the user; no silent reach; credentials never exposed to sessions or other plugins (§10.2, §9.3)
- [ ] Contract versioning with refusal/warning; install/enable/disable/remove without restart; plugin health surface (§10.2)
- [ ] Enforced: plugins cannot author intent — tools act as the calling session (§10.2, principle 1)
- [ ] Distribution: in-box, from directory, from configured source (§10.2) — record permission-grant UX decision in AGENTS.md

_**A draft of the contract surface landed in Batch 4 (Track C), and nothing here is
ticked for it** — drafting is not the epic, and a checked box would say the contract
exists. It is `packages/plugin-sdk/src/draft/` (exported as `draft.*`, one runtime
value, a status string) plus [`plugin-contract-draft.md`](plugin-contract-draft.md).
`CONTRACT_VERSION` is still `0` and the host still speaks only load/ping/dispose:
nothing is wired and nothing is frozen._

_Why early: every §10.1 contribution point already has a **native implementation**,
and Epic 7.3 ports the in-box four onto the public contract. A contract drawn without
reading those implementations fails at the port — at the end of Phase 7, when the
shape is hardest to change. Each draft interface therefore names its native
counterpart (write actions ← write-intents + reversibility; workspace kinds ← core's
`workspaces/`; condition checks ← the world-condition registry), so the freeze is a
reconciliation. Three gaps are recorded in the doc rather than papered over:
`DraftCardView` is the weakest shape (§10.1's "in-canvas interactive surfaces" needs
a real renderer contribution to test it), the versioning **rule** is not drafted (only
a number to compare), and the lifecycle verbs are host-side and out of scope for a
contribution contract. The permission-grant UX stays an **open operator decision**,
with the five questions that need answers written down where they can be answered._

### Epic 7.2 — Integration substrate (`integrations`)

- [ ] Declared refresh modes: interval / on-demand / observed; manual refresh per integration and per object; **scheduled reads only, never scheduled runs** (§9.1, principle 2)
- [ ] Runtime-configurable scoping in the source's query language (§9.1)
- [ ] Refresh → version bump → drift; changes as deltas (§9.1, §3.2)
- [ ] Writes: UI action + agent tool per write, reversibility declared per action, results read back never assumed (§9.2)
- [ ] In-app connect flows; visible connection state; broken connection = health problem, never missing data (§9.3)
- [ ] Concepts present-or-absent, never degraded (§3.1)

### Epic 7.3 — In-box plugins (`integrations`)

- [ ] **Coding/git**: workspace kind, diffs, commits, branches — port Phase 4 git mechanics onto the plugin contract (§9.4)
- [ ] **GitHub**: PRs, reviews, issues-as-tickets, repo metadata, writes; clone-from-PR-card (§9.4, §3.4)
- [ ] **Filesystem**: files/directories as documents; browse and drag (§9.4)
- [ ] **Jira**: tickets, epics+children as collections, statuses/transitions, writes (§9.4)

### Epic 7.4 — Standing instructions (`graph`)

- [ ] Standing-instruction content available to every workstream that opts in (§3.8)
- [ ] Agent proposes / human accepts flow (§3.8, principle 1)

---

## Phase 8 — Application polish and platform

**Goal:** the product as an application: keyboardable, accessible, searchable, packaged, portable.

**Exit criteria:** installable desktop builds; every high-frequency verb keyboard-reachable and documented in the shortcuts overlay; search spans archives; a11y checks pass in e2e.

### Epic 8.1 — Keyboard and accessibility (`app`)

- [ ] High-frequency verb bindings (queue traversal, answer, run, stop); shortcuts overlay lists every binding — none undocumented (§11)
- [ ] Focus trap/restore, announced listboxes/comboboxes, streaming announced on start/complete, full keyboard reachability (§11)

### Epic 8.2 — Search and archive (`app`)

- [ ] FTS search over sessions incl. archived, ranked over title/location/content; archived reported as archived (§6.8)
- [ ] Archive-by-default posture: canvas holds what you placed; the rest browsable/searchable (§6.8, §3.3)

### Epic 8.3 — Settings and logs (`app`)

- [ ] Settings: grouped, searchable, applied without restart; env vars supply defaults only (§11)
- [ ] Logs panel over the structured log, filtered (§8, §11)

### Epic 8.4 — Packaging and deployment (`desktop`, `server`)

- [ ] Desktop installers per platform; updater per the packaging decision (§12)
- [ ] Local binding by default; tunnelled remote access posture; remote-backend semantics (workspaces/diffs are the backend's machine) (§12)
- [ ] Documented tunnel workflow: forward the page's loopback port only (`ssh -N -L <port>:127.0.0.1:<port>`), verified end-to-end against a cloud VM — including the desktop app attaching to the tunnelled backend
- [ ] Backup/move verification for the portable store; reset/cleanup UX finalized (§12)

### Epic 8.5 — E2E hardening (`ci`)

- [ ] Playwright canvas e2e: rigid-body, zoom semantics, mid-drag refusal, arrangement durability
- [ ] Multi-session steering e2e: inject, answer question, stop scopes, queue triage
- [ ] Invariant regression suite: the four §15 invariants, reflexivity refusal, no-silent-truncation, one-gesture-one-thing

---

## Phase 9 — Directional (§13) — not scheduled

Recorded intentions only; pull one in deliberately, never by drift:

- On-card node configuration · in-app file/document editor · summarized continuation · flakiness detection for world conditions · answer-from-outbound-route · shared task list sessions claim from

---

## Cross-cutting rules (apply to every phase)

1. **§15 first.** Any schema touching runs, edges, versions, or outputs is reviewed against the four invariants before merge — and, since Batch 3, asserted by `apps/server/src/invariants.integration.test.ts`, which runs in `pnpm test` and therefore in CI. It is named so a failure reads as what it is: an invariant breach, not a broken test. It drives the real API against the live store, because that is where an invariant can actually be violated — a unit test over a predicate cannot tell you the endpoint wrote the row. Six things: the four §15 invariants, plus reflexivity (principle 1) and never-silently-truncating (principle 12), whose failure mode is the same permanent damage.
2. **One vocabulary.** No UI capability without the matching API/agent tool, and vice versa (principle 8). PRs adding a gesture add both or state why not.
3. **Enforced, not documented.** Prohibitions (reflexivity, illegal edges, plugin intent, timed defaults) live in server-side checks with tests, never only in prompts or docs.
4. **Never silently truncate, never auto-run, never infer relationships** (principles 2, 7, 12; §14) — treated as review checklist items.
5. **Open decisions** (AGENTS.md) are resolved inside the phase that first needs them, and the answer is recorded in AGENTS.md in the same PR: graph schema + retention-policy defaults (Phase 1), runtime abstraction (Phase 4), packaging (Phase 3/8), plugin distribution + permission UX (Phase 7), UI styling (Phase 3), release process (Phase 8).

## Tracks and timeline

The phases above are sequenced for a single lane. This section maps them onto
**three parallel tracks** — people or agent worktrees — each the sole writer of
a disjoint set of packages. Calendar assumes one full-time equivalent per
track; halve the parallelism and the total roughly doubles.

### The tracks

| Track                      | Owns                                                          | Sole writer of                                                                             |
| -------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **A — Data & Server**      | schema, core domain, API, budgets/run-history backend         | `packages/core` (except C's subtrees below), `packages/db`, `apps/server`                  |
| **B — Canvas & UI**        | canvas mechanics, panels, shells, attention surfaces          | `packages/ui`, `apps/web`, `apps/desktop`                                                  |
| **C — Runtime & Platform** | session runtime, workspaces, claims, agent tools, plugin host | `packages/plugin-sdk`; from W4: `packages/core/src/sessions/`, `packages/core/src/claims/` |

### Fleet operating rules

1. **One worktree per track**, named per AGENTS.md (`../plotroom-<branch>`), one topic branch per epic.
2. **Single writer per path.** The ownership column above is a claim, not a suggestion. A track needing a change in another track's files asks that track (or the operator) — it does not edit.
3. **Lockfile protocol.** `pnpm-lock.yaml` is the one legitimately shared file. Never hand-merge it: rebase onto `main`, take `main`'s version, rerun `pnpm install`, commit the regenerated result. Tracks adding dependencies in the same window land smallest-first.
4. **Sync points are gates.** Work past a sync point does not start until the sync passes.
5. **Design gate (Track B).** Visual design is being delivered separately (Claude Design). Until the design package lands in `docs/design/`, Track B builds **mechanics only** — unstyled: xyflow interactions, the rigid-body solver, placement persistence, routing, panel plumbing. No visual styling, no component visual design, no theming, and the "styling approach" open decision stays open until the delivery format is known. When the design lands, B applies it as its own epic.
6. **The critical path is Track A**: 1.2 → 1.4 → 2.2 → 4.2 → 5.5 → 6.2. A slip in A shifts the calendar; slips in B or C absorb into their own lane until the next sync.

### Timeline

Phase 0 and Epic 1.1 are complete; week 1 starts from the current state of
`main`.

**Weeks 1–3 — Substrate**

| Track | Work                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | Epic 1.0 primitives (finish: fixtures/factories, clock threading), then Epic 1.2: edges + `NOT NULL` authorship, the edge-legality predicate, command-topology acyclicity, lineage/initiation-chain model. **Day 1: commit the legality predicate signature** so B can consume it. Overflow buffer: start Epic 1.3.                                                                                             |
| B     | Epic 3.0 minimal web shell (a dev-served renderer is enough until the server exists; Electron spawn-or-attach waits for Phase 2), then Epic 3.1 against fixture data: xyflow + React scaffolding, rigid-body push solver, durable placement, selection-as-route. Imports `@plotroom/core` types read-only. **Mechanics only — see the design gate (rule 6); no visual styling until the design package lands.** |
| C     | Epic 4.1 spike: evaluate agent runtimes, draft the adapter interface (start / stream / inject-between-turns / stop / fork-from-point / accounting taps). **Deliverable is a decision record + AGENTS.md update, not code in `core`.** Plus: plugin worker_threads host skeleton in `packages/plugin-sdk` (standalone, from Epic 7.1).                                                                           |

**⛳ Sync 1 (end W3):** schema review of edges/lineage against §15-2 and principle 1; runtime decision accepted and recorded. Nothing downstream starts until this passes.

**Weeks 4–5 — Domain fan-out**

| Track | Work                                                                                                                             |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| A     | Epic 1.3 (workstreams) → Epic 1.4 (commands, runs, run history, `output@n`)                                                      |
| B     | Epic 3.2 zoom/containers/minimap; Epic 3.3 authoring gestures with mid-drag refusal over A's legality predicate (still fixtures) |
| C     | Epic 1.5 sessions/drift entities in `core/src/sessions/` (C's subtree; types coordinated with A), then runtime adapter v1        |

**Weeks 6–7 — Server**

| Track | Work                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------- |
| A     | Epic 2.1 (Hono + WS backbone) and Epic 2.2 (graph/workstream API, server-side refusals)                                   |
| B     | Epic 3.4 (palette, command palette, dock rail); finish Epic 3.0 (renderer served by the server, Electron spawn-or-attach) |
| C     | Epic 4.3 git workspaces: provisioning, readiness gate, divergence detection                                               |

**⛳ Sync 2 (end W7):** canvas switches from fixtures to the real API + WS stream.

**Weeks 8–10 — First run**

| Track | Work                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A     | Epic 4.2 context assembly, run preview, run-history capture; Epic 2.3 durability + compaction job                                                      |
| B     | Phase 3 polish; Epic 5.1 Conversation + Diff panels — _Stage 1 fixture-fed, Stage 2 live once A's run spine merged; both stages landed in this window_ |
| C     | Epic 4.4 path claims (leases, waitlists, deadlock detection) in `core/src/claims/`; Epic 4.5 agent tools + reflexivity enforcement                     |

**🏁 Milestone (end W10) — PASSED:** drop command on ticket → run → streamed transcript → proven completion, end to end. Proven by `apps/web/e2e/milestone.spec.ts` (Playwright, against a real spawned server + a real git repository + the actually-served page) — run via `pnpm --filter @plotroom/web e2e`, deliberately not part of `pnpm verify`.

**Weeks 11–14 — Steering (Phase 5)**

| Track | Work                                                                                                                                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A     | Epic 5.5 scoped runs, concurrency queue, preview-is-the-contract — _landed, with the Epic 4.4/4.5 server carry-overs (claims persistence + enforcement, delegation attribution), the workspace diff read, and stage 2's steering endpoints (Epic 5.2/5.4 server halves)_ |
| B     | Epic 5.1 finished ahead of schedule (done at the W10 gate above); Epic 5.3 speech bubbles (mechanics, then live once A/C's steering endpoints merged); Stage 2 live steering wiring — inject, questions, diff, stop, run-queue admission, resume/fork — and the W14 gate |
| C     | Epic 5.2 injection/questions/broadcast; Epic 5.4 resume/fork/handoff                                                                                                                                                                                                     |

**🏁 Milestone (end W14) — PASSED:** the originating-problem demo — many
sessions, inject mid-flight, answer a question from a bubble, stop at three
scopes. Proven by `apps/web/e2e/steering.spec.ts` (Playwright, same
real-server/real-browser convention as W10) — run via `pnpm --filter
@plotroom/web e2e`, deliberately not part of `pnpm verify`; 5 consecutive
clean runs recorded, and the question-bubble leg break-verified (see Epic
5.1's own landed-note for both).

**Weeks 15–18 — Attention & money (Phase 6)**

| Track | Work                                                                                                        |
| ----- | ----------------------------------------------------------------------------------------------------------- |
| A     | Epic 6.2 budgets/spend + fleet and timeline **data** (the panels are B's); Epic 6.4 run comparison          |
| B     | Epic 6.1 queue + health alerts + outbound routing surfaces                                                  |
| C     | Epic 6.3 approvals/pre-grants/irreversibility; begin finalizing the 7.1 plugin contract (shapes now stable) |

**Weeks 19–23 — Plugins (Phase 7)**

| Track | Work                                                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------- |
| A     | Epic 7.2 integration substrate (refresh, scoping, writes-read-back)                                                  |
| B     | Renderer contribution points; Filesystem plugin; plugin health UI                                                    |
| C     | Epic 7.1 contract freeze + permissions; port git onto the contract; GitHub then Jira; Epic 7.4 standing instructions |

**Weeks 24–26 — Ship (Phase 8)**

| Track | Work                                                                                                 |
| ----- | ---------------------------------------------------------------------------------------------------- |
| A     | Epic 8.2 search/archive; Epic 8.3 settings/logs                                                      |
| B     | Epic 8.1 keyboard + accessibility                                                                    |
| C     | Epic 8.4 packaging/installers/remote backend                                                         |
| All   | Epic 8.5 Playwright e2e + §15 invariant regression suite (runs continuously from W11; hardened here) |

### What cannot be parallelized

- Edges/lineage (Epic 1.2) with anything that consumes them — one author, reviewed hard at Sync 1.
- Phase 5 steering before the Phase 4 runtime adapter exists — injection, fork, and questions are all adapter surface.
- Epic 7.3's git plugin before Phase 4 ships natively — a deliberate double touch that keeps Phase 4 unblocked.

## Sequencing rationale (why this order)

- **Schema before surface** (Phases 1–2): the §15 invariants are the stated reason this rebuild exists as a document; everything else is additive, these are not.
- **Canvas before runtime** (Phase 3 before 4): the hardest novel UI work (rigid-body, zoom semantics, mid-drag refusal) carries the most design risk and needs no agent to validate.
- **One session before many** (Phase 4 before 5): claims, readiness, and proven completion must be right for a single session before steering a fleet multiplies every bug.
- **Attention after there is something to attend to** (Phase 6 after 5): health alerts and the queue are only testable against real concurrent sessions.
- **Plugins after the concepts stabilize** (Phase 7): the contract freezes shapes; freezing before Phases 1–6 settle them would ossify mistakes. Git mechanics are built natively in Phase 4 and _ported onto_ the contract in Phase 7 — a deliberate double touch that keeps Phase 4 unblocked.
