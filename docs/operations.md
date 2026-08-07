# PlotRoom — Operations

**Scope.** What runs on a machine, how it is configured, where its state lives, and what an operator can do to it (spec §8, §11, §12). The records behind the state directory live in [data-model](data-model.md). Where the product is not built yet, this says so and names the open issue rather than describing an intention as if it shipped.

---

## 1. Processes

PlotRoom is one server plus however many surfaces talk to it. Nothing here is started by a scheduler — every process on this list starts because a human launched it or because a running process spawned a documented child (product-spec principle 2).

| Process              | Package                  | What it does                                                                                    | Started by                                                                                                                                                                                                                                      |
| -------------------- | ------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server               | `@plotroom/server`       | The HTTP API and WebSocket endpoint; the single owner of all state (`apps/server/src/index.ts`) | The operator directly (`bun run dev` in `apps/server`, or `bun dev` at the repo root), or the compiled binary the desktop shell spawns as a sidecar (§6)                                                                                        |
| Web                  | `@plotroom/web`          | The React canvas UI                                                                             | In production it is static assets the server serves single-origin alongside `/api` and `/ws` (`apps/server/src/static/serve.ts`); in dev, its own Vite dev server (`apps/web/vite.config.ts`) proxies `/api`/`/ws` to the server's dev listener |
| Desktop              | `@plotroom/desktop`      | The Tauri v2 shell window (a thin Rust main; no product logic)                                  | The operator, launching the packaged app or `apps/desktop`'s `dev` script (`cargo tauri dev`)                                                                                                                                                   |
| Session-host sidecar | `@plotroom/session-host` | One omp-embedding process per running agent session                                             | The server, per session launch (`apps/server/src/runtime/omp.ts`), via `bun` (or a compiled binary, §6)                                                                                                                                         |

**Who starts what, concretely:**

- The **server** is the one process every other surface depends on. It owns the SQLite database, the workspaces, the run spine, and every schedule (§3). It never starts itself from a trigger — it is asked to start by a human command or by the desktop shell's spawn-or-attach (§6).
- The **web app** is not a separate running process in production: `configureApp` serves whatever `apps/web` built from `config.staticDir`, and 404s to a JSON error rather than a blank page if the build is missing (`apps/server/src/app.ts:504-527`). In dev, Vite runs as its own process and proxies API/WS calls through — never a second source of truth for state.
- The **desktop shell** does not run the product's logic itself — #316's Rust-main scope fence is strictly window lifecycle, spawn-or-attach, sidecar lifecycle, and single-instance enforcement, nothing else. It connects this window to a _local_ server (spawn-or-attach, §6.1) and hosts the OS chrome; the Electron shell's remote-backend switching was not carried into the Tauri v2 port (§6.2).
- Each **session-host sidecar** is a child of the server, one per running agent session, spawned with its own process group and framed IPC over fd 3 (`apps/server/src/runtime/omp.ts`). The server owns its whole lifecycle: it is the thing that spawns it, feeds it, reads its observation stream, and can signal its process group to abort it. Nothing about a sidecar is itself schedulable — it exists only because a run was initiated (§4.1).

---

## 2. Configuration

The configuration surface is `apps/server/src/config.ts`. Its own header states the rule this section documents: **environment variables only supply defaults** (spec §11) — until a value is overridden through the settings store, `PLOTROOM_*` is what a fresh install runs under; once a setting is written, the stored value wins on every subsequent boot, and removing the override reverts to exactly what the environment produced (`apps/server/src/settings/boot.ts`).

### 2.1 Environment variables and their shipped defaults

| Variable                               | Config field                 | Default                                                  | Notes                                                                                                                               |
| -------------------------------------- | ---------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `PLOTROOM_HOST`                        | `host`                       | `127.0.0.1` (`DEFAULT_HOST`)                             | Loopback unless `PLOTROOM_ALLOW_NON_LOOPBACK_BIND` is also set (§4).                                                                |
| `PLOTROOM_PORT`                        | `port`                       | `4600` (`DEFAULT_PORT`)                                  | Must be a whole number 1–65535 (`PORT_BOUND`); malformed values throw at boot rather than becoming `NaN`.                           |
| `PLOTROOM_STATE_DIR`                   | `stateDir`                   | `~/.plotroom`                                            | Holds `plotroom.db` and `blobs/` — see §4.                                                                                          |
| `PLOTROOM_CREDENTIAL`                  | `credential`                 | `null` (none configured)                                 | Optional while bound to loopback, required for non-loopback (§8).                                                                   |
| `PLOTROOM_ALLOW_NON_LOOPBACK_BIND`     | `allowNonLoopbackBind`       | `false`                                                  | Explicit two-part opt-in with a credential; never implied by `host` alone.                                                          |
| `PLOTROOM_TRUSTED_ORIGINS`             | `trustedOrigins`             | `[]`                                                     | Comma-separated exact origins trusted beyond loopback (reverse-proxied/tunnelled setups).                                           |
| `PLOTROOM_STATIC_DIR`                  | `staticDir`                  | `apps/web/dist` (resolved relative to `config.ts`)       | The built renderer served single-origin.                                                                                            |
| `PLOTROOM_LOG_LEVEL`                   | `logLevel`                   | `info`                                                   | One of `debug`, `info`, `warn`, `error`; malformed values fall back to `info` rather than throwing.                                 |
| `PLOTROOM_COMPACTION_INTERVAL_SECONDS` | `compactionIntervalSeconds`  | `21600` (6 hours, `DEFAULT_COMPACTION_INTERVAL_SECONDS`) | `0` disables the schedule; the on-demand endpoint still works.                                                                      |
| `PLOTROOM_CONCURRENCY_LIMIT`           | `concurrencyLimit`           | `4` (`DEFAULT_CONCURRENCY_LIMIT`)                        | Must be a whole number ≥ 1 (`CONCURRENCY_LIMIT_BOUND`); `0` is refused, not treated as "unlimited."                                 |
| `PLOTROOM_ATTENTION_TICK_SECONDS`      | `attentionTickSeconds`       | `30` (`DEFAULT_ATTENTION_TICK_SECONDS`)                  | `0` disables the clock-driven re-derivation; the queue still re-derives on every observed change.                                   |
| `PLOTROOM_INTEGRATION_TICK_SECONDS`    | `integrationTickSeconds`     | `30` (`DEFAULT_INTEGRATION_TICK_SECONDS`)                | `0` disables scheduled refresh checks; on-demand refresh stays available.                                                           |
| `PLOTROOM_PLUGINS_DIR`                 | `pluginsDirectory`           | `null` (none)                                            | A directory of installable plugins beyond the in-box set.                                                                           |
| `PLOTROOM_RUNTIME`                     | `runtime.adapterId`          | `omp-session-host` (`DEFAULT_RUNTIME_ADAPTER`)           | `scripted` is opt-in and never available in a default install.                                                                      |
| `PLOTROOM_SESSION_HOST`                | `runtime.sessionHostProgram` | `null`                                                   | A whole compiled binary to run instead of this build's bundled entry (issue [#92](https://github.com/plotroom/plotroom/issues/92)). |
| `PLOTROOM_SESSION_HOST_BUN`            | `runtime.sessionHostBun`     | `"bun"`                                                  | The `bun` program used to run the bundled session-host entry when no whole binary is configured.                                    |
| `PLOTROOM_RUNTIME_SCRIPT`              | `runtime.scriptPath`         | `null`                                                   | A script the `scripted` runtime replays; irrelevant unless that adapter is selected.                                                |
| `PLOTROOM_WORKSPACE_KIND`              | `workspace.kind`             | `"git"`                                                  | Which workspace mechanism provisions new workstreams.                                                                               |
| `PLOTROOM_WORKSPACE_REPO`              | `workspace.repositoryPath`   | `null`                                                   | An existing checkout to branch from, shared via `git worktree`.                                                                     |
| `PLOTROOM_WORKSPACE_REMOTE`            | `workspace.remoteUrl`        | `null`                                                   | Cloned from when there is no local checkout to share.                                                                               |
| `PLOTROOM_WORKSPACE_DIR`               | `workspace.directory`        | `<stateDir>/workspaces`                                  | Where provisioned workspaces live.                                                                                                  |
| `PLOTROOM_WORKSPACE_BRANCH_TEMPLATE`   | `workspace.branchTemplate`   | `DEFAULT_BRANCH_TEMPLATE` (`@plotroom/core`)             | Branch-name template for new workspaces.                                                                                            |
| `PLOTROOM_WORKSPACE_BASE_REF`          | `workspace.baseRef`          | `null`                                                   | The ref new branches are cut from, when not the remote default.                                                                     |
| `PLOTROOM_WORKSPACE_SETUP`             | `workspace.setup`            | `null`                                                   | JSON object naming a post-checkout setup program; malformed JSON or a missing `program` throws at boot.                             |

There is no environment variable for which plugins ship in the box (`pluginsInBox`) — that is a property of the build, not the machine, so it is not part of this table.

**Desktop's own copy.** `apps/desktop/src-tauri/src/lib.rs`'s `resolve_host`/`resolve_port` read the same `PLOTROOM_HOST`/`PLOTROOM_PORT` variables to decide what to spawn-or-attach against, with the same default (`4600`, as `DEFAULT_PLOTROOM_PORT`) — duplicated rather than imported, because a Rust process cannot import `@plotroom/server` (a TypeScript package). Unlike the server's own env parsing (§2.1, `PORT_BOUND`, throws on a malformed value), the Rust side falls back to the default when a value fails to parse as a `u16` rather than erroring — a real behavioral difference from the pre-Tauri shell worth knowing if `PLOTROOM_PORT` is ever set to something invalid ahead of a desktop launch. The two defaults are still kept in step by hand; if they ever diverge, a desktop build would spawn a server it cannot then attach to, or refuse a port the server accepts.

### 2.2 Settings-over-env precedence (§11)

Spec §11 states it as a rule: **"everything configurable is a setting; environment variables only supply defaults."** In code:

1. `loadServerConfig(env, overrides)` builds a config from `process.env` (or explicit overrides, the seam tests use).
2. `applyStoredSettings` (`apps/server/src/settings/boot.ts`) layers any persisted setting rows onto that env-derived config, once at boot. A stored value for a key the catalog no longer declares, or one that would fail the same bound check a write is held to, is **skipped rather than applied** — reported back as `ignored`, never silently accepted, because a value this process is not actually running under must not appear to be in effect.
3. From then on, a settings write through `PUT /api/settings/:key` (`apps/server/src/routes/settings.ts`) is what changes the running value — for settings marked `appliesWithoutRestart: true` in the catalog (`apps/server/src/settings/catalog.ts`), the change is **live**, applied through one of `SettingsService`'s `liveAppliers` with no restart. For settings marked `false`, the write is persisted but named honestly as taking effect on the next start (`restartReason` states why — e.g. the socket is already bound, the runtime registry is already built).

`stateDir` is deliberately **not** a setting at all: the store the override would live in is located by `stateDir`, so a stored value could never relocate the very store that holds it. It stays environment/flag-only (`PLOTROOM_STATE_DIR`).

### 2.3 Which settings apply live vs. need a restart

| Group        | Setting                                                                                                              | Applies without restart?                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Network      | `host`, `port`, `allowNonLoopbackBind`                                                                               | No — bind policy and the socket are fixed at boot                 |
| Security     | `trustedOrigins`, `credential`                                                                                       | Yes                                                               |
| Application  | `staticDir`                                                                                                          | No — the renderer path is resolved once at boot                   |
| Logging      | `logLevel`                                                                                                           | Yes                                                               |
| Runs         | `concurrencyLimit`                                                                                                   | Yes                                                               |
| Maintenance  | `compactionIntervalSeconds`                                                                                          | Yes                                                               |
| Attention    | `attentionTickSeconds`                                                                                               | Yes                                                               |
| Integrations | `integrationTickSeconds`                                                                                             | Yes                                                               |
| Plugins      | `pluginsDirectory`                                                                                                   | No — plugins are scanned once at boot, no rescan gesture yet      |
| Runtime      | `runtime.adapterId`                                                                                                  | No — the runtime registry is built once at boot                   |
| Workspaces   | `workspace.kind`, `workspace.repositoryPath`, `workspace.remoteUrl`, `workspace.branchTemplate`, `workspace.baseRef` | No — read from boot configuration when a workspace is provisioned |

Every entry in the catalog today is `humanOnly` — a session cannot read or write any of them (§8's reflexivity asymmetry), and `SettingsService` asserts at construction that a setting's `appliesWithoutRestart` claim matches an actually-wired live applier, so a mismatch is a boot-time programming error rather than a surface that lies about whether a write took effect.

---

## 3. Shipped budget defaults (§8)

A fresh install ships with **one budget row already present**: the global daily ceiling. It is not a constant resolved at read time — it is a real row, seeded by the initial migration (`packages/db/src/migrations.ts`):

```sql
INSERT INTO budgets (id, scope, workstream_id, limit_micros, period, warn_fraction, origin, ...)
VALUES ('budget_global_default', 'global', NULL, 25000000, 'day', 0.9, 'shipped-default', ...);
```

`25_000_000` micros is **$25.00/day** — `DEFAULT_GLOBAL_CEILING_MICROS` in `packages/core/src/budgets.ts`. Being a row means the operator can see it (`GET /api/budgets` — it is present on every fresh install, not conjured only when asked), raise it, or remove it (`DELETE`), and the change persists across restarts exactly like a budget the operator authored from nothing. The `origin` column (`shipped-default` vs. `authored`) is how the product tells its own number from one the operator set — an operator who raised the ceiling can always tell which is which.

The warn fraction ships at `0.9` (`DEFAULT_BUDGET_WARN_FRACTION`) — 90% of the ceiling is where "near a cap" starts, and the product's own guidance to a session nearing it is to wrap up cleanly rather than race the budget (`BUDGET_GUIDANCE`).

Writing or removing a budget — at either scope — is the operator's alone: there is no budget-writing tool in the session catalog, and both routes are declared operator-only (`apps/server/src/routes/budgets.ts`) rather than left for a permission check to argue case by case (principle 1).

---

## 4. Data

### 4.1 Where it lives

Everything is under one directory, `PLOTROOM_STATE_DIR` (default `~/.plotroom`), laid out by `packages/db/src/paths.ts`:

- `<stateDir>/plotroom.db` — the SQLite database: every object, version, workstream, run, session, budget, setting, and log-adjacent record.
- `<stateDir>/blobs/` — content-addressed blob storage (inline and external), referenced from the database by hash.

For what each table holds, see [data-model](data-model.md).

### 4.2 Backup and portability

The backup and move story is data, not a runbook — `GET /api/maintenance/state` answers it directly (`apps/server/src/routes/maintenance.ts`):

- **The portable unit is the state directory itself.** Copy it and you have moved everything: it includes the database file and the blobs directory.
- **Deliberately excluded**, because each is either rebuilt on demand or would carry something already broken to a new machine:
  - the provisioned-workspaces directory — checkouts re-provisioned at the next run;
  - the shared git mirror cache — rebuilt on demand;
  - the runtime directory (`<stateDir>/runtime/session-host`) — generated fresh at every start, and holds the SDK's own session files, which are derived state (the record PlotRoom itself keeps is the observation log, not this directory).

Copying the state directory while the server is stopped is a complete, working backup. There is no separate export/import format — the directory _is_ the format.

### 4.3 Compaction: scheduled vs. on demand

Compaction is one sweep (`Maintenance.compact` in `packages/db/src/maintenance.ts`), reachable two ways that call the exact same code:

- **On a schedule** — `PLOTROOM_COMPACTION_INTERVAL_SECONDS` (default 6 hours; `0` disables it), started as `startCompactionJob` and rescheduled live by a settings write with no restart.
- **On demand** — `POST /api/maintenance/compact`, the operator's own gesture (a session cannot call it), running the sweep immediately outside the schedule.

Either way, the sweep does exactly three things, in this order, because each step's output is what makes the next step's cleanup safe:

1. **Compacts runs** — drops the `run_referenced` flag from versions no run history entry still points at, per the retention policy (§4.4 of the product spec: last N runs per definition, plus every pinned run and everything it references, plus a configurable window).
2. **Compacts object versions** — removes unreferenced intermediate versions now that run-compaction has freed them, never touching a version a retained run still references.
3. **Sweeps blobs** — deletes blob rows (and their on-disk files) nothing points at any more, now that the version graph has finished shrinking.

Nothing here decides _what_ is compactable — the pure retention predicates in `@plotroom/core` do; the schedule and the endpoint only ever ask the same question at a different time. A pinned run and everything it references is never a candidate, regardless of which path triggered the sweep.

---

## 5. Reset and maintenance routes (§12)

All of §12's durability endpoints are mounted under `/api` by `maintenanceRoutes` (`apps/server/src/routes/maintenance.ts`) and every one of them is the **operator's own** — a session is refused at the door (`requireOperator`), and no catalog tool names any of them, so the approvals gate never even sees a call to reach.

| Route                                                 | What it does                                                                                                                                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/maintenance/state`                          | Reads the backup-and-move inventory: row counts per table, blob byte totals, the portable unit and its includes/excludes (§4.2), and the current compaction interval. Read-only.                                   |
| `GET /api/reset/plan?scope=…`                         | States exactly what a reset of the given scope would remove and what it would keep, without removing anything. The plan and the execution compute the same counts, so what the operator confirmed is what happens. |
| `POST /api/reset` (body: `{ scope, confirm }`)        | Without `confirm: true`, returns the plan and removes nothing — the same shape as the plan read. With `confirm: true`, executes it.                                                                                |
| `POST /api/maintenance/compact`                       | Runs the compaction sweep now (§4.3).                                                                                                                                                                              |
| `POST /api/runs/:id/pin` / `DELETE /api/runs/:id/pin` | Pins or unpins a single run — the human's veto over compaction reaching anything that run references (§4.4).                                                                                                       |

**Reset has three scopes (`RESET_SCOPES` in `packages/db/src/maintenance.ts`), and each clears something different:**

- **`arrangement`** — clears only the authored position of every node; the board lays out again from scratch. **Keeps** every node, edge, object, command, run, and session — only _where things sit_ is forgotten.
- **`derived`** — deletes every provisioned workspace's checkout on disk and the shared git mirror cache; the next run re-provisions them. **This destroys anything inside those checkouts that is not committed and pushed** — uncommitted changes, untracked files, and commits that exist only locally (`WORKSPACE_DESTRUCTION_WARNING`, stated identically in both scopes that reach checkouts). **Keeps** every workspace _record_ (a workstream still owns exactly one), all run history, sessions and their observation logs, the search index, and session phase snapshots — none of it is derived from the checkout, so a reset that removed it would lose more than it reclaims.
- **`everything`** — empties every table in the store (every run, session, object, workstream, and blob — counted and named in the plan before it happens), deletes every provisioned workspace's checkout and the shared git cache, and carries the same uncommitted-work warning as `derived`. If any session is still live when this runs, the plan says so explicitly: their records go and **their runtimes are not asked to stop first**. **Keeps** only the schema itself — the store is emptied, not deleted, so the app starts clean rather than broken.

---

## 6. Desktop

### 6.1 Spawn-or-attach

On launch, the desktop shell decides what to connect to in one place — the
`.setup()` closure in `run()` (`apps/desktop/src-tauri/src/lib.rs`), calling
`spawn_or_attach` (`apps/desktop/src-tauri/src/spawn_or_attach.rs`), ported
from the deleted Electron `spawn-or-attach.ts` (#316):

1. **Probe the configured host/port first.** It health-probes
   `PLOTROOM_HOST`/`PLOTROOM_PORT` (default `127.0.0.1:4600` — §2.1's
   "Desktop's own copy") against `/api/health`. If something already
   answers healthy, it **attaches** — no process spawned, nothing killed on
   shutdown.
2. **Spawn otherwise.** It spawns the compiled server binary as a sidecar
   (`apps/desktop/src-tauri/src/sidecar.rs`) with the _same_ host/port
   passed as env vars — never a second, independently-learned "actually
   bound" address. Process-group protections guard the sidecar if this
   process dies unexpectedly: `PR_SET_PDEATHSIG(SIGKILL)` in a `pre_exec`
   hook on Linux, a portable `setpgid`-only variant elsewhere (the #308
   spike's confirmed finding — a plain spawned child is _not_ killed when
   its parent dies on Linux; it is re-parented to init and keeps running).
3. **Health-wait on that same address.** Polls `/api/health` until healthy
   or a 10-second deadline (`SpawnOrAttachError::NeverBecameHealthy`).
4. **Shutdown kills only its own child.** Tracked only when this launch
   actually spawned the sidecar (`SpawnedSidecar` in Tauri's managed state,
   never set for an attach); window-close tears the sidecar down only when
   it's the last window, and only then.

**#260/#261 closed by construction, not ported forward.** Both named bugs in
the deleted TS implementation's IPC-learned "actually bound address" path —
a second value that could diverge from what was asked for. The Rust port
has no such second value: the host/port it asks the sidecar to bind and the
host/port it probes and loads are the _same_ configured value, and every
wait here is a bounded poll against an explicit deadline rather than an
unbounded wait on something the child may never send. (The GitHub issues
themselves are not closed by this doc; the code they described no longer
exists.)

### 6.2 Remote backends — removed in the Tauri v2 port

The Electron shell could connect to a **remote backend** instead of
spawning its own server: remembering multiple backends
(`{ id, label, url, credential }`) and switching between them, with
credential injection at the network layer (`installCredentialInjection`,
rewriting outgoing requests with `Authorization: Bearer <credential>`).

**None of this exists in the Tauri v2 shell.** #316's Rust-main scope fence
is strictly window lifecycle, spawn-or-attach to a _local_ server,
sidecar lifecycle, and single-instance enforcement — no remote-backend
picker, no credential store, no network-layer request rewriting. PR #336
(the swap) explicitly records removing the Electron backend-picker module
and its tests, and nothing since has re-added the capability: it is not
named as a follow-up in #316's own comments, in epic #304's subtask list,
or in issue [#46](https://github.com/plotroom/plotroom/issues/46) (open for
desktop credential-at-rest, scoped shell-agnostically) or
[#45](https://github.com/plotroom/plotroom/issues/45) (open for remote-host
attachment verification — credential prompt and reconnect behavior — also
shell-agnostic). An operator who needs the desktop app to talk to anything
other than a local server has no supported path to do so from the shell
itself today.

### 6.3 Desktop credential storage — not applicable today

Spec §12's stated intention — "the desktop application keeps its backend
credential in the platform keychain, never in a file" — described the
Electron shell's remote-backend credential (§6.2, removed): stored as a
plain string in a JSON file, no keychain integration. That storage, and
everything it protected, is gone along with remote-backend switching: the
Tauri v2 shell holds no desktop-specific credential of any kind, because it
never talks to anything but a local, loopback server (§6.1) — credential-optional
by the rule in §8.

**Open: [#46](https://github.com/plotroom/plotroom/issues/46)** — desktop
credential-at-rest via the platform keychain. Still open, still
unimplemented, and explicitly scoped by epic #304 to run "against whichever
shell this epic lands... sequence them after child 12" — it now targets the
Tauri v2 shell, but only once (or if) remote-backend attachment
([#45](https://github.com/plotroom/plotroom/issues/45), also open) is
rebuilt on top of it. Neither issue has a shipped implementation to
describe yet.

### 6.4 Updater state — honest state

`tauri-plugin-updater` is registered
(`apps/desktop/src-tauri/src/lib.rs`) and configured in
`tauri.conf.json`'s `plugins.updater` block: one endpoint
(`http://127.0.0.1:4601/updates/{{target}}/{{arch}}/{{current_version}}`),
`dangerousInsecureTransportProtocol: true` (the flag plain `http` needs to
be allowed at all), and a `pubkey` a real signature check would use. This is
the **placeholder host** #309's ADR §6 named: real hosting, real signing
(Apple notarization, Windows Authenticode), and a channel strategy are
explicitly deferred to a follow-up issue not yet filed. Swapping to a real
host means swapping the endpoint back to `https` and removing the
insecure-transport flag — nothing else in the file changes for that swap.

**What's wired today is narrower than "the plugin is registered."** No code
in `apps/desktop/src-tauri/src` calls `check()`/`download()`/`install()` —
there is no scheduled check on launch or interval, no native update dialog,
and no `autoInstallUpdates`-style setting (all present in the deleted
Electron `updater.ts`; none ported). The renderer calls no Tauri JS API
either (#316's scope fence), so nothing on that side triggers a check.
The only place the updater flow runs at all is a dry-run integration test
(`apps/desktop/src-tauri/tests/updater_dry_run.rs`), proving the plugin's
`check()` round-trip — fetch the manifest, parse it, compare versions —
against a real local HTTP server standing in for the eventual host. It
stops at `check()` deliberately: `download()`/`install()` verify a minisign
signature against `tauri.conf.json`'s `pubkey`, which needs a real signed
artifact this deferred-signing epic does not produce.

In short: the desktop app has no operator-visible update-checking behavior
today. The plugin is proven to work against a placeholder host in a test;
nothing in the shipped app calls it yet.

---

## 7. Logs (§8)

Every log line is one JSON object: `{ time, level, msg, ...fields }` (`apps/server/src/logging/logger.ts`) — one consistent shape across the whole server, written to stdout so any process supervisor or `plotroom logs | jq` sees the same lines the in-app Logs panel reads.

- **Level is runtime-adjustable, not a restart-time flag.** `GET /api/log-level` and `PATCH /api/log-level` read and set `Logger.level` directly — both the operator's own, gated identically to a write (a session cannot even _read_ the current level). The same value is also reachable through the general settings surface (`logLevel`, marked `appliesWithoutRestart: true`).
- **Sensitive values are redacted wherever they appear, however deeply nested** — field names `credential`, `authorization`, `authorizationheader`, `password`, `secret`, and `token` are replaced with `[redacted]` before a line is ever written (`redact` in `logger.ts`).
- **The in-app Logs panel** reads a bounded, in-memory ring buffer (`LogRingBuffer`, capacity 5,000 lines by default) rather than a persisted table — an operational surface for _this run of the process_, not authored state. `GET /api/logs` supports filtering by level (at-least, never exact-only) and component, paging by `sinceSeq`, and reports `droppedTotal` on every read so a client can tell it has missed entries rather than seeing a silent gap. A restart starts a fresh buffer — the log is the operator's window into the current process, not an archive.

---

## 8. Operator credential (§12)

PlotRoom has no user system — access control is a single shared secret, not accounts or identity. The rule the code enforces (`apps/server/src/security/bind-policy.ts`, `apps/server/src/security/credential.ts`) is exactly the spec's:

- **Bound to loopback (the default): the credential is optional.** `checkBindPolicy` allows starting with no `PLOTROOM_CREDENTIAL` configured as long as `host` resolves to a loopback hostname.
- **Bound to anything else: the credential is required**, and enforced _before_ the server will even start listening — non-loopback binding needs both the explicit `PLOTROOM_ALLOW_NON_LOOPBACK_BIND` opt-in **and** a configured, non-empty credential; missing either refuses to bind at all, with the reason named.
- Once configured, the credential is checked on every `/api/*` request and the `/ws` upgrade, identically (`credentialMiddleware`), read fresh per request rather than captured once — a settings write that changes it takes effect from the very next request, no restart. It travels as `Authorization: Bearer <credential>` for ordinary calls, or a `credential` query parameter for the browser's native WebSocket constructor (which cannot set custom headers on the handshake) — both compared in constant time over a digest, so a wrong credential costs the same regardless of what was presented.
- Origin/Host validation (`originCheckMiddleware`) is the companion check, gating the same routes: loopback origins are always trusted at any port; anything else must be in the configured `trustedOrigins` list.

The desktop shell itself never needs this credential today: it only ever
spawns or attaches to a server on `127.0.0.1` (§6.1), which is loopback and
therefore credential-optional by the rule above. The Electron shell's
remote-backend credential injection (a separate seam) was not carried into
the Tauri v2 port — see §6.2/§6.3 for what that means for remote attachment
today.
