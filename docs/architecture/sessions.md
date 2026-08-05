# Sessions, steering, and the runtime seam

How PlotRoom records a session, steers one, and talks to an agent runtime. The observation log is the record and everything else about a session is folded from it; the runtime boundary's non-negotiables are at the end and are binding.

**Steering** lives in `session_questions`, `broadcasts` / `broadcast_recipients` /
`broadcast_sends`, and `handoff_briefs` (migration 16). Every rule is
`@plotroom/core`'s; these are what its planners produced. Three shapes are worth
knowing: a question **outlives the call it blocks** (a surface that asked the runtime
what was asked would have nothing to show once the call settled, and "unpicked
options remain visible" needs the options remembered), the broadcast **rate window is
rows** because a counter cannot answer "how many in the last hour" after a restart,
and a broadcast's **one content object is world-scoped** even though
`InjectionContent` says local — it is wired into sessions across workstreams, which
§3.3 refuses for a local object.

A **repository's identity is its configured source** (`sessions/world.ts`), so a
worktree and the checkout it branched from are one repository — which is exactly what
§6.5's "everyone in _this_ repository" is about, and it means two workspaces agree
without a registry. Broadcast-induced spend is charged at a **stated grain**: the
recipient's spend between delivery and the next time its accounting moved, once, with
the baseline in a column so a restart between the two does not lose the charge.

**Sessions, observations, and workspaces** land in migration 7:
`sessions` / `session_observations` / `session_transcript_publications` /
`session_injections`, plus `run_submissions`, `run_initiations`, and
`workspaces`. Four things about them are load-bearing:

- the **observation log is the record** — PlotRoom's own `RuntimeObservation`
  values, never vendor payloads (decision 0001) — and the `phase_json` and
  accounting columns are a snapshot folded from it by `@plotroom/core`'s
  reducer, recomputable at any time (`SessionStore.observationState`);
- the end-state taxonomy is a CHECK, so `out-of-budget` and `interrupted` are
  representable and distinct from `failed`, and `SessionStore.end` keeps the
  **first** outcome (a doubled observation cannot rewrite one);
- `run_initiations` holds a **client-supplied initiation key**, which is what
  makes one gesture one run and one session across retries (principle 9); a
  refused attempt releases the key;
- `sessions.run_id` is `ON DELETE SET NULL`: run retention (§4.4) may reclaim a
  run, and a session record is readable _always_ (§3.6), so the link goes and
  the record stays.

The transcript is content, not a table: it is projected from the log
(`session-transcript.ts`) and versioned through `ObjectStore` when the
checkpoint rule says to (`publishesVersion` — a turn never publishes).

## The runtime seam

The runtime boundary is decided (docs/decisions/0001-session-runtime-abstraction.md,
including the amendment that makes **omp** adapter v1, embedded in a PlotRoom-owned
Bun sidecar rather than spawned as a CLI).
PlotRoom owns a `SessionRuntimeAdapter` interface in `@plotroom/core`
(`core/src/sessions/`); adapters translate one runtime's surface into a
timestamped `RuntimeObservation` stream plus start / resume / fork / inject /
respond / stop. Adapter v1 is **omp** (multi-provider, native queued→delivered
injection, near-native fork), embedded in a PlotRoom-owned Bun sidecar; the second
adapter, proving the seam, is the **Claude Agent SDK**. ACP is tracked but is not
the boundary.

**Where the sidecar lives.** `apps/session-host` is that process — the only
package in the repo that imports a vendor agent SDK — and
`core/src/sessions/adapters/omp/` owns its lifecycle and its frame protocol
while translating nothing, because the sidecar emits `RuntimeObservation`
values it is typechecked against. It is landing in tracks (issue #73), so it is
registered only when the operator selects it
(`PLOTROOM_RUNTIME=omp-session-host`): its permission gate is issue #81, and
until that lands `enforcesPermissions` is false and
`checkPermissionEnforcement` refuses every run on it. The pi adapter is the
default meanwhile and is retired in #83.

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
- **Per-call permission gating is enforced, not advised** — approvals (§6.6) and
  claims (§3.4) decide every tool call before it runs, and the gate's liveness is
  asserted at boot rather than assumed from configuration (0001's amendment).
