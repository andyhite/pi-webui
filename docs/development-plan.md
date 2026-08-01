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

### Epic 1.4 — Commands and runs (`commands`, `runs`)

- [ ] Command definitions: instruction, model/effort, tool permissions, expected outcome, ask-points; user-editable content, duplicable, organizable (§3.5)
- [ ] Command nodes: definition + wiring; parameters with confirm-only derived defaults (§3.5)
- [ ] Producing vs open lifecycle; expected outcome as typed placeholder; world conditions as declared predicates (§3.5)
- [ ] Output pre-wiring: typed placeholder outputs exist pre-run, bind post-run (§3.5)
- [ ] Publish vs promote as two distinct verbs; pre-bind/post-bind two-state rule for cross-workstream wires (§3.5)
- [ ] **§15-1: run history records full assembled content + configuration** — the exact ordered content and versions in, config, output, cost (§3.7, §4.4)
- [ ] **§15-4: per-run output addressing** — `output@n` general case, `latest` derived (§4.4)
- [ ] Run-history retention rule: last N per definition + pinned + window (§4.4)

### Epic 1.0 — Primitives (`core`) — _done_

_Small, but every later epic assumes them; idempotency and retention tests are
untestable without an injectable clock._

- [x] Id generation and branded id types (partly in place)
- [x] Injectable clock, threaded through stores (partly in place: `ObjectStore`)
- [x] Test fixtures/factories for objects, versions, workstreams, runs

_Fixtures live at `@plotroom/core/testing` (subpath export, outside the
production API); the run factory is a placeholder carrying only what
retention/`output@n` tests need until Epic 1.4 lands the schema._

### Epic 1.5 — Sessions and drift (`sessions`, `graph`)

- [ ] Session entity: phases, per-session launch choices, accounting fields, end states including out-of-budget as distinct from failure (§3.6)
- [ ] Transcript as content: versioned, delta = new turns; bounded with recoverable release markers (§3.6, §6.1)
- [ ] Live-transcript checkpoint rule: consumers drift on session end or explicit checkpoint, never per turn (§3.6)
- [ ] **Interrupted** as a distinct end state for crash/restart with sessions in flight — not stopped, not failed; resumable like any session (§3.6, principle 11)
- [ ] Drift derivation: consumed-version tracking; transitive, per-consumer, cross-workstream flags; drift is a state, never an action (§3.2, §4.5)
- [ ] Triage verbs on attention items: acknowledge (advance baseline), snooze, mute (§4.5)
- [ ] Soft-delete/recoverability for all authored state, agent deletions included (principle 10)

---

## Phase 2 — Server and API

**Goal:** the Hono server as the single owner of all state, exposing the one vocabulary both UI and agents will use (principle 8).

**Exit criteria:** every Phase 1 operation reachable over HTTP; WS pushes state changes; the renderer (Phase 3) and agent tools (Phase 4) build on this API with no side channels.

### Epic 2.1 — HTTP + WS backbone (`server`)

- [ ] Hono app, route structure, error shape, request validation
- [ ] WebSocket state-change stream: one event vocabulary for everything the canvas and queue render live
- [ ] Operator credential: optional shared secret locally; auth required for non-local binding (§12)
- [ ] Loopback-only bind by default — never `0.0.0.0` without explicit opt-in plus the credential requirement (§12)
- [ ] Origin/Host validation on WebSocket upgrades and state-changing requests: loopback names always trusted, anything else requires explicit allow-listing — DNS-rebinding and drive-by-page protection that also makes SSH-tunnel access (`ssh -L`, browser at `http://localhost:<port>`) work with zero config (§12)
- [ ] Structured logs: consistent shape, runtime-adjustable level, redaction (§8)

### Epic 2.2 — Graph and workstream API (`server`, `graph`)

- [ ] CRUD + verbs for objects, edges, workstreams, commands, notes — every gesture as an endpoint, because agents get the same vocabulary later (principle 8)
- [ ] Authorship attribution on every mutating call (human vs session identity) — feeds §15-2
- [ ] Refusal of illegal edges and self-chain authoring at the API layer (principles 1, 8: enforced, not documented)
- [ ] Undo/restore endpoints for destructive operations (principle 10)

### Epic 2.3 — Durability and portability (`server`, `db`)

- [ ] All state in the single portable store; survives restart; backup/move story (§12)
- [ ] Reset and cleanup verbs: arrangement / derived state / everything — each stating what it removes first (§12)
- [ ] Version compaction **job** implementing the §15-3 rule (windowed, pin-aware) — the schema and the predicate land in Epic 1.1; this epic owns only scheduling and blob sweeping

---

## Phase 3 — Canvas MVP: authoring at rest

**Goal:** the graph as the primary surface. A human can place content, wire context into commands, and arrange the board — no sessions running yet. This de-risks the hardest UI work (rigid-body, zoom semantics, mid-drag refusal) before runtime complexity arrives.

**Exit criteria:** compose a multi-command topology with ordered context edges, notes, collections, and pre-wired outputs; arrangement survives restart; illegal edges are refused mid-drag.

### Epic 3.1 — Canvas foundation (`canvas`)

- [x] xyflow integration; nodes DOM-based (plugin renderers + a11y later, §11)
- [x] Rigid-body push: custom drag handling + collision/push solver over node extents; chains propagate; at-rest stays put (§5)
- [ ] Durable placement across restarts; derived initial arrangement; "reset arrangement" as the only auto-layout verb (§5) — _placement persistence landed behind a storage interface (localStorage until the server exists); derived initial arrangement and the reset verb remain_
- [x] Selection as the route: selected node reflected in the address; one navigation primitive for click/palette/queue/deep-link (§5)

_Landed unstyled per the design gate (fleet rule 5), against fixture data in
`apps/web`; mid-drag refusal wired through `isValidConnection` over
`checkConnection`. Epic 3.0's server-served renderer and Electron
spawn-or-attach wait for Phase 2 as planned._

### Epic 3.2 — Zoom, containers, and legibility (`canvas`)

- [ ] Zoom-level renderers: workstream card → inner nodes → full detail (§5)
- [ ] Collapsing workstream containers; edges draw to collapsed frames (§3.3, §5)
- [ ] Minimap, legend, live counts; multi-select with contextual action bar (§5)
- [ ] Off-screen attention markers with clustering (§5) — visuals now, fed by real attention in Phase 6

### Epic 3.3 — Authoring gestures (`canvas`)

- [ ] Edge drag with mid-drag refusal via `isValidConnection` over the core legality predicate (§3.7, §5)
- [ ] Drag-to-empty-canvas create menu, filtered to legal targets (§5)
- [ ] Ordered context inputs, rearrangeable by drag (§3.5)
- [ ] One-gesture flows: definition-onto-ticket creates a workstream (workspace deferred to first run) (§3.5); collection expand/prune/drag-out (§3.1)
- [ ] Notes: create, edit (new version → drift), promote (§3.8)
- [ ] Undo for destructive canvas operations (§5, principle 10)

### Epic 3.4 — Palette and shell basics (`ui`, `app`)

- [ ] Palette rail: everything not yet on canvas as drag sources; ticket ordering (unblocked-first) (§5)
- [ ] Command palette: navigation + verbs (§11)
- [ ] Dock rail + panel registry; state persists across panel close (§11)
- [ ] Graph warnings surface: legal-but-questionable topologies flagged on card and editor, machine-readable for agents later (§5)

### Epic 3.0 — Web + desktop shells (`web`, `desktop`) — _do first_

_Moved ahead of 3.1–3.4: nothing in this phase is demoable without a host to
run the renderer in._

- [ ] `apps/web` renderer served by the server; single renderer for both targets (never forked per target)
- [ ] **Single-origin rule:** the browser talks to exactly one origin — page, WS, and API on the same port; the client connects to same-origin paths (`/ws`) with no hardcoded host or port anywhere. In dev, the dev server serves the page and proxies WS/API to the server so dev is single-origin too. This is what makes local and tunnelled access identical (§12)
- [ ] Port/instance selection knob (one setting drives server port, dev port, state dir); dev HMR follows the browser's port with an override for asymmetric tunnels
- [ ] Electron main: spawn-or-attach to server; packaging decision (electron-builder vs forge — record in AGENTS.md)
- [ ] Remote-backend connect/remember/switch (§12) — can land late in this epic or slip to Phase 8

---

## Phase 4 — Running work: sessions, workspaces, claims

**Goal:** the first agent actually runs. This phase resolves the biggest open decision — the agent runtime abstraction — and delivers workspaces with path claims.

**Exit criteria:** drop a command on a ticket, run it, watch the session stream in the Conversation panel, and see a proven completion; two sessions in one workstream cannot write the same path.

### Epic 4.1 — Session runtime abstraction (`sessions`)

- [x] **Decide and record** the runtime boundary (open decision in AGENTS.md): the interface PlotRoom owns — start, stream, inject-between-turns, stop, fork-from-point, accounting taps — vs what a runtime adapter supplies — _accepted at Sync 1: pi coding agent first, Claude Agent SDK second (docs/decisions/0001)_
- [ ] First runtime adapter (one concrete agent runtime end-to-end)
- [ ] Phase derivation from observation: thinking, responding, tool-running, compacting, waiting-* , stopped, failed, idle (§3.6; principle 7 — derived, never agent-reported)
- [ ] Per-session accounting: turns, elapsed, tokens, cost, last-activity, context-window meter with thresholds (§3.6)
- [ ] Session records: live = stored; readable, resumable, forkable, deletable, always (§3.6)

### Epic 4.2 — Context assembly and the run (`runs`)

- [ ] Assembly: ordered edges → assembled content, with content-budget warnings; hard cap opt-in per command; never silent truncation (§3.5, principle 12)
- [ ] Run preview: exactly what will execute + cost estimate + spend cap acceptance, before anything starts (§4.1)
- [ ] Cost estimates state their basis and render as ranges — "based on N prior runs" / "no history; input size only" — never a bare number (§4.1)
- [ ] Completion proof is point-in-time: proven at submission, never silently revoked; later condition regression surfaces as drift/attention on done work (§3.5, principle 3)
- [ ] Run-one; producing-session completion loop: submission checked against world conditions, failing condition returned as feedback, session continues within budget (§3.5, principle 3)
- [ ] Open sessions: end by user; feed downstream via promote or transcript wiring (§3.5)
- [ ] Idempotent initiation: one gesture → one session/run, across retries and reconnects (principle 9)
- [ ] Run history capture at run time (exercises §15-1/§15-4 written in Phase 1)

### Epic 4.3 — Workspaces (`workspaces`)

- [ ] Workspace kind abstraction: boundary guaranteed by product, mechanism per kind (§3.4) — git kind first
- [ ] Git provisioning: branch from configurable template; existing branches taken as-is from remote; provision at first run, not workstream creation (§3.4, §3.5)
- [ ] Readiness: declared per-repo setup step gates runs; not-ready blocks with visible reason; setup output inspectable; failures reported (§3.4)
- [ ] Live status (branch, uncommitted, ahead/behind) reflecting terminal-made changes too; divergence detection for continuation gating (§3.4, §4.3)
- [ ] Discovery: scan configured search paths; discovered ≠ placed (§3.4, principle 6); create/attach/remove/force-remove; protected primary checkout + default branch
- [ ] Provisioning cost awareness: shared caches where possible, cost reported (§3.4)
- [ ] Host-auth invariant: workspace git operations use the host machine's own git/SSH config; app credentials are never used for workspace git and never written into workspace git config or remotes; clone-from-PR fails honestly when the host cannot authenticate (§3.4, §9.3) — enforced with a test, not a convention

### Epic 4.4 — Path claims (`claims`)

- [ ] Claim model: per-path leases; root claim per workstream; every claim a subdivision of a held claim (§3.4)
- [ ] Hierarchical conflict (ancestor/descendant paths, not-yet-existing paths covered)
- [ ] Grant authority follows path hierarchy; human may grant/revoke/force-release anything
- [ ] Pre-granted claim policies (allow/deny patterns per subtree)
- [ ] Lease expiry + activity renewal; automatic release on session end
- [ ] Waitlists as visible state; wait-for-cycle deadlock detection refusing the newest claim with an actionable message
- [ ] Claim-precise divergence: stale iff a read path was written by a different holder (§3.4)
- [ ] Operator as implicit claim holder: hand edits are their own divergence class, staling a session only for paths it read (§3.4)
- [ ] Session tools: request, yield, inspect (enforced server-side, not by convention — principle 4)

### Epic 4.5 — Agent tool surface (`tools`)

- [ ] Every human gesture exposed as an agent tool over the same API vocabulary (principle 8)
- [ ] Reflexivity enforcement: no session authors context/capabilities/budget into its own initiation chain; propose-and-accept path for self-touching targets (principle 1) — enforced at the server using the Phase 1 lineage model
- [ ] Delegation: child sessions visible on the graph with provenance; spend attributed up the initiating chain (§3.6, principle 2)
- [ ] Graph warnings readable by agents (§5)

---

## Phase 5 — Steering in flight

**Goal:** the originating problem — many sessions at once, answerable in seconds. Everything the transcript, injection, and question machinery needs.

**Exit criteria:** run several sessions; inject content mid-flight and see it as a graph edge; answer a structured question from a bubble without opening a panel; stop at all three scopes.

### Epic 5.1 — Conversation surface (`panels`, `sessions`)

- [ ] Conversation panel: streaming transcript, reasoning distinct from output, tool calls with I/O, message-level actions, export (§6.1, §11)
- [ ] Bounded transcript with recoverable release: largest old tool outputs first, visible markers, reload, complete export (§6.1)
- [ ] Drafts and prompt history persisted per session (§6.2)
- [ ] Diff panel (read-only file tree + patches) (§11)

### Epic 5.2 — Injection, questions, broadcast (`sessions`)

- [ ] Injection as new turn + permanent graph content wired to the session (§6.5, principle 5); queued → delivered states for between-turn delivery
- [ ] Session-to-session injection with attribution (peer gesture, lineage rule applies)
- [ ] Transcript checkpoint gesture (human and agent) feeding the Epic 1.5 checkpoint rule (§3.6)
- [ ] Structured questions: options as bubbles on the node, answered inline, result returned structurally, unpicked options remain visible; **no timed defaults** (§6.4, principle 2)
- [ ] Human broadcast (selection / workstream / everything running) (§6.5)
- [ ] Session broadcast: scope-of-material-state only, mandatory declared category, rate-bounded per window, induced spend charged to sender's budget chain, operator-visible (§6.5)
- [ ] Batch gestures: one prompt to many, stop/close/archive on a multi-selection; preset prompts (§4.2)

### Epic 5.3 — Speech bubbles on canvas (`canvas`)

- [ ] Attributed bubbles per sender node; tool-in-flight chips (§5)
- [ ] Constraints: never obscure minimap/controls, width-capped, collapse to counts unfocused, global cap on simultaneous bubbles (§5)

### Epic 5.4 — Resume, fork, handoff (`sessions`)

- [ ] Explicit resume-vs-fork choice, never implicit on typing (§6.3)
- [ ] Fork from any point → own workstream + workspace; outside-world touchpoints marked (fed by §9.2 reversibility declarations) for fork cleanliness (§6.3, §6.6)
- [ ] Handoff: source-written brief, human-edited before send (§6.3)
- [ ] Continue-vs-fresh on re-run: side-by-side cost preview; window-fit gate; divergence forces fresh (§4.3)
- [ ] Stop at three scopes with counts and widest-scope confirm (§6.7)

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

| Track | Work                                                                                                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A     | Epic 4.2 context assembly, run preview, run-history capture; Epic 2.3 durability + compaction job                                  |
| B     | Phase 3 polish; start Epic 5.1 Conversation + Diff panels                                                                          |
| C     | Epic 4.4 path claims (leases, waitlists, deadlock detection) in `core/src/claims/`; Epic 4.5 agent tools + reflexivity enforcement |

**🏁 Milestone (end W10):** drop command on ticket → run → streamed transcript → proven completion, end to end.

**Weeks 11–14 — Steering (Phase 5)**

| Track | Work                                                                 |
| ----- | -------------------------------------------------------------------- |
| A     | Epic 5.5 scoped runs, concurrency queue, preview-is-the-contract     |
| B     | Epic 5.1 finish; Epic 5.3 speech bubbles                             |
| C     | Epic 5.2 injection/questions/broadcast; Epic 5.4 resume/fork/handoff |

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
