# 0000 — Historical decisions (archive)

- **Status:** Archive. Superseded only where a later record says so.
- **Relocated:** 2026-08-04

These decisions were made during the rebuild and recorded inline in `AGENTS.md`,
before decisions were tracked outside the repository and recorded here. The prose
is kept as written — each entry states what was decided and why, and several are
the only written account of a constraint the schema still enforces. Nothing new is
added here: a new decision gets its own record.

- **Deleting a session record stops the session first, and cascades no further than
  its node** (issue #42, §3.6). §3.6 says a session is "readable, resumable, forkable,
  deletable, always" and that "there is no distinction between a live session and a
  stored one", so a **live** session is deletable too — and it is stopped in the same
  gesture, through §6.7's own stop verb, because a soft-deleted record whose runtime is
  still running is exactly the invisible session the product exists to prevent. The stop
  is therefore the ordinary `stopped` end state with its ordinary event, and the response
  says `stopped: true` — announced, never a silent side effect; a restore gives back a
  stopped session, readable and resumable like any other. Refusing while live and naming
  the stop verb was rejected for making "always" false for exactly the sessions an
  operator most wants gone. What goes with the record is **its graph node and that node's
  wires, and nothing else**: the transcript object is separately authored content someone
  may have wired elsewhere, the observation log _is_ the record (decision 0001) so a
  restore that lost it would put back a session in name only, and every delegated child is
  its own record with its own provenance — one gesture destroying an unnamed subtree is not
  a recoverable gesture in any useful sense (principle 10). `session_delete` is
  destruction-class (`destroys: "session"`, the seventh kind), so a session asking for one
  raises §6.6's approval through the guard that already exists and needs no new channel
  (the deletion is attributed to the session that asked, not to the operator who agreed —
  though the stop it performs is still recorded as the operator's, which is issue #64),
  while `session_restore` is an ordinary verb like every other `_restore`. No migration:
  `sessions.deleted_at` has been there since migration 7, and there is deliberately no
  purge policy behind it (nothing in the spec says a deleted record expires).

- **A pending proposal reaches §7.1 as its own `ApprovalKind`, `standing-instruction`**
  (Epic 7.4). `ATTENTION_FEEDS` is closed at six, so a proposal is surfaced through the
  approvals channel §6.6 already owns — but as a **fifth kind**, added by the documented
  CHECK-widening rebuild (migration 27), rather than as a `tool-permission` row carrying
  the proposal id. The rejected option needed no migration and that was its only
  advantage: `ApprovalKind` is the one vocabulary every attention surface, every
  pre-grant and every outbound route reads, and a row whose kind says one thing while
  meaning another is the drift principle 8 exists to prevent, written into the schema.
  **Nothing can pre-grant one, structurally**: `preGrantable` returns `null` for the
  kind, so no call site can express a coverage check, and `declarePreGrant` refuses one
  by name — an "allow always" over proposals would apply them silently, which is the one
  thing principle 1 says a proposal must never be. `settlesAsk` therefore compares the
  ask's kind as well as its tool and target, because a write-gate raise over
  `standing_instruction_declare` would otherwise settle the proposal.
- **A plugin's enabled/disabled state is persisted** (`plugin_disablements`, migration
  28). A row means disabled and an absence means enabled — the shape `plugin_grants`
  uses for never-asked and budgets use for removed — because the registry's state is a
  running process's property, and a disable that lapsed at the next boot would be the
  operator's decision reversed with nobody behind it (the same reasoning as "removal
  stays removed").
- **Plugin distribution and permission-grant UX** (Epic 7.1). Three answers, and the
  third is the one that mattered. **Distribution v1 is in-box packages plus a
  configured plugins directory** — one subdirectory per plugin, scanned on an
  operator gesture rather than on a timer (principle 2), with the plugin's id taken
  from its manifest and never from the directory name, which the operator can
  rename. "From a source the user configures" is **deferred and recorded as
  deferred**: it needs fetching, verification, and an update path that must not
  silently widen permissions, and inventing those under a freeze would have been
  three decisions nobody reviewed. **Grants are operator-only acts**, made through
  the API or configuration at install/enable time; there is no agent tool that
  grants a permission, for the same reason there is none that raises a budget
  (principle 1). And **a plugin's runtime reach for an ungranted permission raises
  through the existing approvals channel** (§6.6) rather than through a bespoke
  plugin dialog: the host refuses the call carrying a `PermissionRaise` whose field
  names are `ApprovalAsk`'s, so the ask reaches every attention surface and the
  outbound routes that already exist, answerable without opening anything. The call
  stays **blocked** meanwhile, like a question — a refusal sent alongside the raise
  would settle it before anybody was asked — and a permission already **denied**
  raises nothing, because it was answered. Bespoke grant UX (an install-time dialog,
  a trusted-publisher tier, what an update that widens a request does) waits for the
  design package; the five questions the draft recorded are still the right
  questions. Full network/filesystem **sandboxing is future work and is documented as
  such** in `docs/plugin-contract.md`: v1 enforces credentials and core capabilities
  at the host boundary and treats network and filesystem scopes as declared trust,
  because a declaration the operator reads as a boundary when it is a promise is
  worse than no declaration.

- **Electron packaging/updater tooling: electron-builder** (with electron-updater). Decided W6–7 under the operator's standing autonomous-judgment directive; applied in Epic 8.4. Rationale: mature updater story and config-driven multi-platform targets fit Epic 8.4's "installers per platform + updater" scope with the least assembly.
- Retention policy defaults: last 20 runs per definition, 30-day version window (Epic 1.4).
- **A second, scripted session runtime ships beside the pi adapter** (Epic 4.1/4.2). It replays a declared script of observations and is registered only when the operator selects it (`PLOTROOM_RUNTIME=scripted`), so a default installation has no such adapter to name. It exists because the run spine — observation log, phase reducer, accounting, WS events, completion loop — must be provable without a model, and it exercises that exact path rather than a parallel one. The Playwright milestone gate scripts it (`apps/server/src/runtime/scripted.ts` documents the format, including the bounded `delay` step that paces a session so a streaming assertion cannot be satisfied by a refetch, and the `call` step that raises a gated tool call and **waits** for PlotRoom's answer, which is what makes §6.6's blocked-call loop provable without a model).
- **A submission is a tool call**, not a private channel, and PlotRoom answers by checking the declared world conditions itself — so completion is proven identically however it was asked for. There are two entry points into that one path, deliberately: `plotroom_submit_outcome` is what a _runtime_ calls (the scripted runtime emits it and the driver recognises it as an observation), and `session_submit` is the agent tool over `POST /api/sessions/:id/submit` in Epic 4.5's catalog. Same service call, same proof; the earlier note here claimed one shared name, which is not what landed.
- **Cost estimates are priced per definition, from priced runs only, and never rendered as a bare number** (Epic 4.2, §4.1). `estimateRunCost` returns a basis, a range, and a sentence; the range is `null` — not zero — when nothing in that definition's history recorded a cost, and a run whose runtime reported none contributes no evidence about money. The suggested spend cap is the most expensive prior run, and there is no suggestion at all without history.
- **Global concurrency limit default: 4 sessions** (`PLOTROOM_CONCURRENCY_LIMIT`).
  §4.1 says the limit is configurable and says nothing about its value. Four is
  chosen so the queue is a path an ordinary board takes rather than an unreachable
  branch — a fleet gesture over a handful of commands queues, is visible, and is
  cancellable on the first day of use — and because it is survivable on one laptop
  against one provider's rate limits. Zero is **refused** rather than read as
  "unlimited": a limit of none is spelled by setting it high, and a typo that
  silently removed the bound would be the one failure the limit exists to prevent.
  Decided in Epic 5.5. That refusal is **one statement, not one per entry point**
  (`NumericBound` in `apps/server/src/config.ts`): the environment variable, the
  settings write (§11), and boot reading a stored override back all apply the same
  bound, because a rule only the boot path knew was one a settings write walked
  around — a stored zero was accepted, persisted, and refused every admission for
  ever. Every numeric setting is bounded, `port` included: a stored port is the one
  value that can make the product **unbootable** (it beats the environment
  variable, and deleting the row needs a running server), and an interval past
  2^31-1 ms is clamped by `setInterval` to 1 ms, so “practically never” would have
  meant “every millisecond”. A stored value the catalog would refuse as a write is
  therefore **ignored and reported** at boot rather than applied — wrong type as
  well as out of bounds, judged by the one `checkSettingValue` the write path uses
  — so no persisted value **of the wrong type or outside its bound** can make the
  process unusable, and the setting’s own read carries the reason rather than
  reporting a value nothing is running under. A stored value that is legal and
  still unbindable (a port already in use, a host this machine does not have) is
  **not** covered by any bound and still fails at every boot; that needs a caught
  listen error and a fallback, and is tracked as its own issue.
- **The limit bounds initiation, not one endpoint.** `POST /api/runs` goes through
  the same admission as a scoped run: 201 with `{run, session, status}` when a slot
  was free, **202 with `{queued, run: null, session: null}`** when the gesture was
  admitted and is waiting. A 202 is not a refusal — the system is deciding _when_,
  never _whether_ (§4.1) — and a client that reads `session.id` unconditionally
  fails loudly rather than proceeding with a session that does not exist yet.
  Decided in Epic 5.5 (Batch 3), because an unbounded second entry point would make
  the limit documentation rather than enforcement.
- **Compaction interval default: 6 hours** (`PLOTROOM_COMPACTION_INTERVAL_SECONDS`), first sweep after one interval rather than at startup, and `0` disables the schedule while leaving `POST /api/maintenance/compact` available. Decided in Epic 2.3: often enough that the store does not grow unbounded between restarts, rare enough that the sweep is never what the operator notices, and a restart loop must not be able to sweep on every boot.
- **The shipped default global ceiling: $25 per day** (`DEFAULT_GLOBAL_CEILING_MICROS`, seeded as a `budgets` row by migration 20, warn threshold 0.9). §8 requires "a real number the operator can raise or remove, not an empty field with a recommendation"; this is that number, and four things about it are the decision. **Per day rather than in total**, because a lifetime global ceiling is an expiry date rather than a safety net — a number that bricks the product in its second week is a number every operator deletes on day one, which is the same as shipping none — and because "today's total" is the grain §8's fleet view already speaks in, so the ceiling and the figure beside it measure the same day (UTC; a configurable accounting timezone is Epic 8.3's). **$25**, chosen to be survivable rather than generous: an ordinary day of a few sessions never touches it, and a fan-out bug is caught while it is still an anecdote. **A seeded row, not a constant resolved when no row exists**, so the operator can see it, raise it (`POST /api/budgets`), and remove it (`DELETE /api/budgets/:id`) — and removal stays removed across restarts, which a fallback constant could never allow. **Budget writes are the operator's alone** and have no agent tool at all: principle 1 forbids a session raising the budget that binds it, and lowering one is not a gesture the spec asks for either — so the two write routes are declared operator-only in the catalog while the reads (`session_budget_read`, `budgets_read`, `workstream_budget_read`, `fleet_read`) are §8's "a session can see what remains". Decided in Epic 6.2.
