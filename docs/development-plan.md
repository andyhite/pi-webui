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

### Epic 4.4 — Path claims (`claims`) — _done (domain; server wiring pending Track A)_

- [x] Claim model: per-path leases; root claim per workstream; every claim a subdivision of a held claim (§3.4)
- [x] Hierarchical conflict (ancestor/descendant paths, not-yet-existing paths covered)
- [x] Grant authority follows path hierarchy; human may grant/revoke/force-release anything
- [x] Pre-granted claim policies (allow/deny patterns per subtree)
- [x] Lease expiry + activity renewal; automatic release on session end
- [x] Waitlists as visible state; wait-for-cycle deadlock detection refusing the newest claim with an actionable message
- [x] Claim-precise divergence: stale iff a read path was written by a different holder (§3.4)
- [x] Operator as implicit claim holder: hand edits are their own divergence class, staling a session only for paths it read (§3.4)
- [x] Session tools: request, yield, inspect — decision functions in `core` (`ClaimManager`); the endpoints that expose them are Track A's, tracked in Epic 4.5's carry-over below (principle 4)

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

### Epic 4.5 — Agent tool surface (`tools`) — _done (domain; server mounting pending Track A)_

- [x] Every human gesture exposed as an agent tool over the same API vocabulary (principle 8) — one catalog in `core`, pinned to the server's mounted routes by a test in both directions
- [x] Reflexivity enforcement: no session authors context/capabilities/budget into its own initiation chain; propose-and-accept path for self-touching targets (principle 1) — `checkToolCall` over the Phase 1 lineage model, called by the bridge before any request is built. _Carry-over resolved in the tool layer: the bridge is constructed with the session it serves, sets `X-PlotRoom-Actor` from that binding, and refuses an actor-shaped input rather than stripping it — a session has no way to say who it is. The server-side half (mount the bridge's transport, keep the header caller-supplied only for the operator) is Track A's._
- [x] Delegation: child sessions visible on the graph with provenance; spend attributed up the initiating chain (§3.6, principle 2) — `planDelegation` records the `session_delegated` provenance edge and `attributeSpend` writes one ledger row per session in the chain; enforcement lands with Phase 6 budgets
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

### Epic 5.2 — Injection, questions, broadcast (`sessions`)
### Epic 5.2 — Injection, questions, broadcast (`sessions`) — _domain done (server wiring pending Track A stage 2)_

- [x] Injection as new turn + permanent graph content wired to the session (§6.5, principle 5); queued → delivered states for between-turn delivery — `planInjection` produces the content node, the authored context edge, and the ledger entry; the pi adapter's real between-turn delivery is verified against a live pi
- [x] Session-to-session injection with attribution (peer gesture, lineage rule applies) — the same plan with a session author, refused into its own chain by `checkInjection`
- [x] Transcript checkpoint gesture (human and agent) feeding the Epic 1.5 checkpoint rule (§3.6) — `checkpointEvent` / `previewCheckpoint`; the endpoint and the `session_checkpoint` tool were already live
- [x] Structured questions: options as bubbles on the node, answered inline, result returned structurally, unpicked options remain visible; **no timed defaults** (§6.4, principle 2) — `questions.ts`, with the prohibition enforced structurally (a timed default is a type error, asserted); `plotroom_ask` is the pi-side tool
- [x] Human broadcast (selection / workstream / everything running) (§6.5) — `planHumanBroadcast`, unconstrained by construction
- [x] Session broadcast: scope-of-material-state only, mandatory declared category, rate-bounded per window, induced spend charged to sender's budget chain, operator-visible (§6.5) — `planSessionBroadcast` plus `attributeBroadcastSpend`, `broadcastAttention`, `broadcastActivity`
- [x] Batch gestures: one prompt to many, stop/close/archive on a multi-selection; preset prompts (§4.2) — `planBatch`'s envelope, with per-member keys derived from the batch key
- [ ] Endpoints, stores, and events for all of the above — Track A's stage 2; the tools are `pending` in the catalog until they exist

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
in scope receives it. `planBatch` is partial by design: a member that cannot take
the gesture is skipped with a reason rather than failing the twelve, and every
member's idempotency key derives from the batch key so a half-failed batch is
replayable (principle 9).

**No timed defaults, enforced structurally.** §6.4's prohibition is a type-level
impossibility rather than a runtime refusal: `SessionQuestion` has no default,
fallback, or on-timeout field; `QuestionAttention.onElapsed` is the single
literal `"escalate-attention"`, so `"answer"` and `"proceed"` do not typecheck;
and an answer requires an `Author`, which has no system variant, so "answered by
the timer" cannot be written down. `questions.test.ts` asserts all three as
`@ts-expect-error` cases — if any becomes expressible, the unused directive fails
the build. The generated `plotroom_ask` extension passes no `timeout` to pi's
dialog (pi supports one), and a test asserts the source string contains no timer
of any kind; a dismissed question returns an **error** to the model, never one of
the options nobody picked.

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

### Epic 5.3 — Speech bubbles on canvas (`canvas`) — _mechanics landed Batch 3 (Weeks 11–14), fixture-fed where noted below_

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
wired per session-role node in `apps/web/src/App.tsx`). Two sources stay
fixture-fed, both for the same reason — no stream in the codebase carries
them yet: structured questions (§6.4, `bubbles/question-source.ts`'s
`QuestionDataSource`, answerable inline via `onAnswerQuestion` — no server
endpoint exists, and `SessionStatus` exposes only the derived
`waiting-input` phase, never the `RuntimeRequest` behind it) and injection
queued/delivered states (§6.5, `bubbles/derive-sources.ts`'s
`deriveInjectionBubbleSources` over core's real `InjectionLedger` shape,
fed by a fixture ledger since Epic 5.2's injection endpoint has not landed).
Both are ready to be joined by a live source without changing shape — the
same swap `createApiSessionDataSource` already did for its own fixture._

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

### Epic 5.4 — Resume, fork, handoff (`sessions`) — _domain done (server wiring pending Track A stage 2)_

- [x] Explicit resume-vs-fork choice, never implicit on typing (§6.3) — `dispositionOfTypedInput` returns `choice-required` for an ended session, and `SessionContinuation` has no third variant
- [x] Fork from any point → own workstream + workspace; outside-world touchpoints marked (fed by §9.2 reversibility declarations) for fork cleanliness (§6.3, §6.6) — `planSessionFork` plus `outside-world.ts`; the pi adapter's real fork is verified against a live pi
- [x] Handoff: source-written brief, human-edited before send (§6.3) — `draftHandoffBrief` → `reviewHandoffBrief` → `planHandoff`, where sending an unreviewed brief is a type error
- [x] Continue-vs-fresh on re-run: side-by-side cost preview; window-fit gate; divergence forces fresh (§4.3) — `compareContinueVsFresh`, which describes the option it refused as well as the one it allows
- [x] Stop at three scopes with counts and widest-scope confirm (§6.7) — `resolveStop`
- [ ] Endpoints and UI for all of the above — Track A's stage 2 and Track B's panels

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
`outside-world` with a reversibility — and an **undeclared** tool is a third,
visible state that costs `certain` rather than being read as harmless. A declared
write that merely _started_ counts as a touch, because a merge that returned an
error may still have merged and "we are not sure" must never render as "clean".

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
unreachable point now falls back to a **seeded** session from PlotRoom's own
transcript (`PiForkUnavailable` → `start({ seedTranscript })`) instead of throwing,
with the half-forked process aborted first. The live spike proves the prefix: a
fork at turn 1 of a two-turn session sends the model turn 1 and not turn 2.

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
quietly, so that spike is the thing to run against a new pi.

### Epic 5.5 — Scoped runs and the queue of work (`runs`)

- [ ] Run subgraph (dependency order; pauses on failure/out-of-budget; stop aborts remainder) (§4.1)
- [ ] Run what's missing: never-disabled run affordance; "waiting on…" with reveal-and-run-upstream, asked once (§4.1)
- [ ] Re-run all drifted: per-workstream and fleet-wide (§4.1)
- [ ] Global concurrency limit with visible, cancellable queue; **preview is the contract** — drifted inputs re-ask instead of silently running (§4.1)

---

## Phase 6 — Attention, accounting, budgets

**Goal:** the control-tower half: one attention derivation rendered everywhere, and spend that makes agent-initiated work safe.

**Exit criteria:** the queue answers questions/approvals/drift without opening anything; budgets bind transitively; a capped session ends as out-of-budget, not failed.

### Epic 6.1 — Attention system (`attention`)

- [ ] One derivation, many surfaces: node state, off-screen marker, header, window title, badge, system notification (§7)
- [ ] The queue: single ranked keyboard-driven list; rows answerable in place; selection navigates the canvas (§7.1)
- [ ] Feeds: questions, approvals, drift, health alerts, completions — each with acknowledge/snooze/mute (§7.1, §4.5)
- [ ] Health alerts from observation only: idle, spinning, conflict-predicted (cross-workstream path overlap + intra-workstream waitlist overlap), unanswered, blocked-on-you with claim-wait thresholds (§7.2)
- [ ] What-changed-while-away: capped per-workstream event history, entries route to targets and tolerate their absence (§7.3)
- [ ] Outbound notification routing: state-attached routes (push/webhook), edge-triggered, redacted (§7.3)

### Epic 6.2 — Budgets and spend (`budgets`)

- [ ] Persistent spend accounting per session / workstream / fleet; totals outlive sessions (§8)
- [ ] Budgets at run/batch, workstream, global scope; **shipped default global ceiling** (§8, principle 2)
- [ ] Sessions can read remaining budget that binds them; near-cap defined behavior: stop cleanly, wrap up, report (§8)
- [ ] Out-of-budget as its own end state everywhere it renders; retries never blindly re-run it (§3.6, §8)
- [ ] Broadcast-induced and delegated spend charged up the initiating chain (§6.5, §3.6)
- [ ] Fleet panel: today's total, biggest spender, running vs concurrency limit (§8, §11)
- [ ] Session timeline panel: temporal turns/tool-calls view, works for finished sessions (§8, §11)

### Epic 6.3 — Approvals (`approvals`)

- [ ] Approval raise/answer flow, on every attention surface, answerable without opening the session (§6.6)
- [ ] Pre-grants per session / per workstream (§6.6)
- [ ] Irreversibility pierces pre-grants: irreversible integration writes always ask (§6.6, §9.2)
- [ ] Agent-requested destruction of authored state routes through approvals; recoverable regardless (§6.6, principle 10)

### Epic 6.4 — Run comparison and cross-run outcomes (`runs`)

- [ ] Pin/unpin runs; downstream follows newest by default, pinnable to `output@n` (§4.4)
- [ ] Compare two runs: inputs, outputs, model, cost (§4.4) — pays off §15-1
- [ ] Cross-run aggregates per definition: attempts, typical failures, cost (§4.4)

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

1. **§15 first.** Any schema touching runs, edges, versions, or outputs is reviewed against the four invariants before merge.
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

| Track | Work                                                                                      |
| ----- | ----------------------------------------------------------------------------------------- |
| A     | Epic 5.5 scoped runs, concurrency queue, preview-is-the-contract                          |
| B     | Epic 5.1 finished ahead of schedule (done at the W10 gate above); Epic 5.3 speech bubbles |
| C     | Epic 5.2 injection/questions/broadcast; Epic 5.4 resume/fork/handoff                      |

**🏁 Milestone (end W14):** the originating-problem demo — many sessions, inject mid-flight, answer a question from a bubble, stop at three scopes.

**Weeks 15–18 — Attention & money (Phase 6)**

| Track | Work                                                                                                        |
| ----- | ----------------------------------------------------------------------------------------------------------- |
| A     | Epic 6.2 budgets/spend/fleet panel; Epic 6.4 run comparison                                                 |
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
