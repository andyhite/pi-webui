# Development — running it, proving it, and the shapes a change takes

`AGENTS.md` says green `pnpm verify` never means done: it proves nothing broke, not
that the thing you built works. This is how you find out whether it works, and what
each kind of change looks like here.

`CONTRIBUTING.md` is the git-level view (branches, worktrees, commits, the pull
request). `docs/architecture/` is why each subsystem is shaped as it is. This file is
the mechanics between them.

## Run it

```sh
pnpm install          # once per worktree — node_modules is not shared
pnpm dev
```

`turbo`'s `dev` task is `dependsOn: ["^build"]`, so this first builds every upstream
package — `tsc -b` throughout, Bun not required — and then runs two persistent
processes:

| Process             | Port   | What it is                                          |
| ------------------- | ------ | --------------------------------------------------- |
| `apps/server` `dev` | `4600` | `tsx watch`, resolving `@plotroom/*` from TS source |
| `apps/web` `dev`    | `4601` | Vite, proxying `/api` and `/ws` to `127.0.0.1:4600` |

**Open `http://localhost:4601`.** Not 4600 — the server's own port serves the API and
the WebSocket, and returns a 503 `renderer_not_built` for a page until `apps/web` has
been built. The dev port is derived, not configured: `resolveDevPorts` in
`apps/web/src/dev/ports.ts` sets it to `PLOTROOM_PORT + 1`, and the server trusts any
loopback origin on any port, so the split needs no configuration.

Narrower loops:

```sh
pnpm --filter @plotroom/server dev                     # API + WS only
VITE_USE_FIXTURES=1 pnpm --filter @plotroom/web dev    # renderer alone, no server
pnpm build && node apps/server/dist/index.js           # single origin on 4600, as packaged
```

`VITE_USE_FIXTURES=1` is the offline renderer: every data source falls back to a
fixture and mutating gestures log why they did not apply. It is the right loop for a
pure drawing change and the wrong one for anything that must reach the server.

The desktop shell has **no `dev` script** — `pnpm dev` never starts Electron, and its
server entry is the _built_ server:

```sh
pnpm --filter @plotroom/desktop build && pnpm --filter @plotroom/desktop start
```

### Two processes cannot share a port

Every worktree defaults to the same 4600/4601 pair, and several agents work here at
once. The server refuses to start on a taken port; Vite quietly moves to the next free
one, so a renderer that came up on 4602 is proxying to somebody else's server. Give
your session its own pair:

```sh
PLOTROOM_PORT=4610 pnpm dev     # renderer lands on 4611
```

`PLOTROOM_PORT=0` is deliberately refused: the server's own "server started" line
echoes the configured port, so a product bound to an OS-assigned port is one nobody
can find. The test harnesses bind port 0 themselves and read the assignment back
(`ephemeralPort()`), which is the technique to copy for a throwaway server.

## What it needs before it can do any work

A default `pnpm dev` gives you a canvas you can arrange and a product that **refuses
to run anything**. Two things decide whether work can start, and a third decides
whether your configuration is the one in force.

**A repository to branch from.** With neither `PLOTROOM_WORKSPACE_REPO` nor
`PLOTROOM_WORKSPACE_REMOTE` set, every run is refused `workspace_not_configured`.
Workspaces are real `git worktree` checkouts under `<state-dir>/workspaces/<id>`, so
pointing this at your own PlotRoom clone means PlotRoom creates worktrees beside the
ones other sessions are working in. Point it at a scratch repo.

**A runtime that can enforce permissions.** `PLOTROOM_RUNTIME` selects the adapter:

| Value                     | State                 | Needs                                                                                  |
| ------------------------- | --------------------- | -------------------------------------------------------------------------------------- |
| unset → `pi-coding-agent` | default               | a `pi` binary on `PATH` (or `PLOTROOM_PI_PROGRAM`), authenticated with your own config |
| `scripted`                | opt-in                | nothing but a valid `PLOTROOM_RUNTIME_SCRIPT`                                          |
| `omp-session-host`        | **refuses every run** | — its permission gate is not wired yet                                                 |

The session host advertises `enforcesPermissions: false`, and
`checkPermissionEnforcement` refuses start, resume and fork on it with
`permissions_advisory_only` — "approvals and claims would be advice, not gates". The
server logs that at boot. It is not broken; it is unfinished, and the refusal is the
product declining to fake a gate.

**Use `scripted` for anything that is not specifically about a vendor runtime.** It
shares every line downstream of the seam with the real adapters — the observation
log, the phase reducer, the claim gate, accounting, the WS stream, the completion
loop — so a scripted run exercises the product rather than a mock of it. A real model
costs money and needs Bun plus credentials, and lives behind an opt-in:
`PLOTROOM_SESSION_HOST_SPIKE=1 pnpm --filter @plotroom/server test`.

**Nothing you set in the environment wins against what is already stored.**
`applyStoredSettings` layers the `settings` rows from `plotroom.db` **on top of** the
env-derived config at boot, and `~/.plotroom` persists across every run — so a port or
a credential set once in the Settings panel follows you forever and silently beats
`PLOTROOM_PORT`. A stored value the catalog would refuse is skipped and logged at
`error`. When a server ignores you, look there first.

### Configuration worth knowing

Defaults: host `127.0.0.1`, port `4600`, state directory `~/.plotroom` (holding
`plotroom.db`, `blobs/`, `workspaces/`, `git-cache/`, `runtime/`), static directory `apps/web/dist`,
concurrency 4, attention and integration ticks 30s, compaction 6h, log level `info`.

`apps/server/src/settings/catalog.ts` is the inventory of everything an operator can
set, each entry naming its environment variable and whether it needs a restart. Six
variables are environment-only and not in it: `PLOTROOM_STATE_DIR`,
`PLOTROOM_WORKSPACE_DIR`, `PLOTROOM_WORKSPACE_SETUP`, `PLOTROOM_RUNTIME_SCRIPT`,
`PLOTROOM_SESSION_HOST`, `PLOTROOM_SESSION_HOST_BUN`.

Booleans accept `1` or `true`, case-insensitively, and nothing else. Migrations apply themselves on every
boot — there is no migration command — and a rebuilding migration that leaves a
foreign-key violation refuses to complete rather than migrating your store badly.

**Auth on a local run: none.** An unset `PLOTROOM_CREDENTIAL` means every request is
allowed, and binding a non-loopback host is a two-part opt-in
(`PLOTROOM_ALLOW_NON_LOOPBACK_BIND=1` **and** a credential) refused at boot rather
than at the first request. The origin check does not bite a local `curl` either: with
no `Origin` header it falls back to `Host`, and any loopback host on any port is
trusted. It bites a request that carries a non-loopback `Origin` — a tunnel, a
non-loopback bind — which is what `PLOTROOM_TRUSTED_ORIGINS` is for.

## Prove the change works

Pick the cheapest thing that actually exercises what you changed.

**A pure function, a predicate, a data source** — `pnpm test`, or one package's
suite. `packages/ui`'s panels put all their logic in `data-source.ts` precisely so
this is enough.

**A server change** — the in-process harness, `apps/server/src/testing/harness.ts`.
`boot(overrides)` starts the real app on an OS-assigned port with a real state
directory and the scripted runtime; `harness.call(path, { method, body, actor })`
speaks to it as either actor; `cleanupHarnesses()` in `afterEach`. **Spread
`repository()` into the overrides** if the test runs work — `boot` configures a
workspace directory but no repository, and without one every run is refused
`workspace_not_configured`. The nineteen `*.integration.test.ts` files beside the
routes are the pattern to copy — no hand-rolled server, no fixed port.

**A surface the browser touches** — the e2e suite:

```sh
pnpm build                                                                 # the suite runs dist/, not source
pnpm --filter @plotroom/web exec playwright install --with-deps chromium   # once
pnpm --filter @plotroom/web e2e
```

It is deliberately outside `pnpm verify` and turbo's `test` task, and `AGENTS.md`
requires it whenever you touch a surface it covers. `apps/web/e2e/server-harness.ts`
boots a real server child process — fresh temp state directory, ephemeral port,
scripted runtime, a temp git repo — and exports `startMilestoneServer`, `apiGet`,
`apiPost`, `apiPatch`. Restart durability has its own harnesses beside it,
`canvas-restart-harness.ts` and `steering-restart-harness.ts` (each with its own
`startRestartableServer`, and the second with `killKeepingState` for a crash that
leaves the state directory intact), and canvas gestures live in
`canvas-drag-helpers.ts`.

**Anything you would only believe by clicking it** — run `pnpm dev`, open 4601, and
drive the gesture. That is the step "exercise the change" names, and no suite
substitutes for it: the milestone spec exists because a walkthrough found what unit
tests did not.

A clean slate to drive, on its own port and its own state:

```sh
PLOTROOM_STATE_DIR=$(mktemp -d) PLOTROOM_WORKSPACE_REPO=/path/to/scratch/repo \
  PLOTROOM_PORT=4610 pnpm dev
```

That leaves the default runtime, so starting a session needs `pi` on `PATH`. To drive
runs with no model at all, add `PLOTROOM_RUNTIME=scripted` **and**
`PLOTROOM_RUNTIME_SCRIPT=<file>` — the scripted runtime refuses a run with no script
rather than inventing an empty one, and the browser cannot supply one per launch.
`MILESTONE_SCRIPT` in `apps/web/e2e/server-harness.ts` is the shape to copy.

## The shapes a change takes

Six recurring shapes. Each names the files in order, the best existing example to
copy, and the test the repo expects — which is not negotiable in the way the code is.

### A schema change

`packages/db/src/migrations.ts` (append) → `packages/db/src/schema.ts` (the Drizzle
read model, same commit) → the store beside it → `packages/core` if a union widens →
`migrations.test.ts` → the store's own test. Worked example: migration 9,
`interrupted_runs`, and `run-store.ts`'s `interrupt()`.

- **Append-only. Never edit a shipped migration.** `SCHEMA_VERSION` is `max(id)`.
- **Migration ids are reserved per track, so they are not contiguous.** The comment
  above the highest id says which lane holds the gap. `applyMigrations` applies the
  _set_ of unapplied ids, so a reserved lower id landing later still applies —
  renumbering "to tidy up" corrupts every installed store.
- A CHECK constraint cannot be altered in place: set `rebuildsTable: true` and let
  `applyRebuild` do SQLite's documented dance (foreign keys off **before** the
  transaction, explicit column lists, indexes recreated by name, then
  `PRAGMA foreign_key_check`).
- **The test:** seed a store at the previous migration with one row of every child
  table, upgrade it for real, and assert nothing was lost — counts, links, every
  column, an empty `foreign_key_check`, foreign keys enforced again, the widened CHECK
  accepting the new value and still rejecting nonsense.

### A rule or predicate

The predicate in `packages/core/src/<area>.ts` with its test → exported from
`index.ts` → the store calls it and throws a typed refusal → the route reports what
the store said → `packages/ui` calls **the same function** wherever the canvas must
refuse before the server does. Models: `checkConnection`, `wouldCycle`,
`isCompactable`, `checkAuthoring`, `resolveEffectiveBudget`.

- Pure, no I/O, injected clock, returning a discriminated refusal whose `message` is
  the operator-facing wording. Every surface reports the predicate's own message,
  never a rephrasing of it.
- **A rule states itself once.** Two statements are allowed only as predicate plus
  schema constraint — never predicate plus predicate.
- "Enforced twice" means the schema **cannot represent** the violation, not that a
  comment repeats the rule. That second line is real only when it is a constraint the
  database enforces, with a case in `invariants.schema.test.ts`.
- **The test:** every refusal reason and its boundaries beside the predicate, the
  refusal reaching the write in a store test, and — if it is reachable over HTTP —
  asserted in the route's integration test for both actors.

### An HTTP route or WS event

`apps/server/src/routes/<area>.ts` → mounted in `app.ts` → `routes/api.ts` if it needs
a new store → a service for anything beyond a store call → a variant in
`packages/core/src/events.ts` for a new event → `sessions/tools/catalog.ts` →
`<area>.integration.test.ts`. Copy `routes/graph.ts` for the internal shape.

- **Gating is per route, in the route**, by the request's actor rather than by a flag
  elsewhere: refuse with a reason naming the spec section, or filter a list read the
  same way a write would refuse.
- **Publish only on a real change** — an idempotent re-place announces nothing — and
  announce a multi-store gesture through `atomically(db, bus, work)`, which buffers
  events and publishes them after the commit. Publishing mid-transaction announces
  writes that may still roll back.
- A new WS event is a variant in `packages/core/src/events.ts`. There is nothing to
  add under `ws/`: the stream relays every event verbatim, with no per-client filter.
- **The catalog is not optional.** A mounted mutating route with neither a live agent
  tool nor a written operator-only entry fails `catalog.test.ts` — in `packages/core`,
  which is a confusing place to discover you forgot.

### An agent-facing tool

An entry in `packages/core/src/sessions/tools/catalog.ts`, the route it names, and the
server-side gate that owns it — landing together, because the catalog test fails if
any one is missing.

- The entry declares the endpoint **exactly as mounted**, its `reflexivity` class, and
  `targetResolution` whenever it is lineage-checked; `destroys` and
  `approval: "always"` are pinned to each other.
- `decideToolPermission` builds the approval ask from the **declared** extent, never
  the raw input — which is where a credential would be. An un-enumerated write intent
  is `unbounded`, so it raises an approval: slow and correct rather than wrong.
- The declaration is the trust boundary. A tool that mis-declares its intent as
  writing nothing executes ungated, and nothing downstream catches it.

### A UI change

`packages/ui/src/<area>/` holds `types.ts`, `data-source.ts` with its test, and the
`*.tsx` that only draws; `apps/web/src/App.tsx` assembles. A panel is four files plus
one `registry.register(definePanel(...))` call — the same call a plugin makes. A
canvas node is a component plus a key in `nodeTypes`; content varies by zoom **inside**
the view, not by registering three node types.

- **The design gate is in force** (see `AGENTS.md`): no product CSS, only xyflow's own
  stylesheet, and inline `style` restricted to layout mechanics with a comment saying
  so. Decision 0002 describes the target state — `@plotroom/toolkit` does not exist
  yet, and until it does, nothing here decides how anything looks.
- Any connection affordance calls `checkConnection` on all three paths — mid-drag, on
  connect, and the keyboard wire — and announces the refusal's own message.
- **The test:** vitest over the pure module, plus a Playwright spec whenever the change
  is a user-visible mechanic.

### A plugin change

The leaf module → the module that exports the manifest, if its declarations change →
that module's unit test → the host test (`host.integration.test.ts`, or `host.test.ts`
in `filesystem`) when the change is observable through the real worker. Each plugin
lays its files out slightly differently; read the one you are editing.

- **The contract is frozen at v1.** A plugin-side change may only use what v1 already
  expresses; the contract also refuses to make some things expressible, so "add it to
  the SDK" is usually the wrong answer.
- A plugin never supplies markup — a card is title, lines and actions the host draws.
  Truncation is reported through the contract's field, never silent.
- A whole new plugin is a package, a project reference in the root `tsconfig.json`,
  and then — as a **separate** commit — its entry in the in-box list and the server's
  dependency. Register the machine-touching half server-side, never in the renderer.
- **The test:** a unit test over the declarations and the pure logic, **and** the host
  test, which loads the compiled entry through the real worker host — so the module the
  product runs is the module the test proved.

## Failure modes worth recognizing

- **`pnpm verify` fails in `apps/session-host`** — its tests are `bun test src`, so
  Bun must be on `PATH`; `pnpm compile` needs it too. `pnpm build` and `pnpm dev` do
  not. `PLOTROOM_SESSION_HOST_BUN` does not help here — it is read at runtime, to pick
  the Bun the _server_ spawns the sidecar with.
- **A blank page or a 503 on 4600** — the renderer is not built. In dev, use 4601.
- **The e2e suite fails opaquely** — it runs `dist/`; `pnpm build` first.
- **A run is refused `workspace_not_configured`** — no repository to branch from.
- **A run is refused `permissions_advisory_only`** — the session-host runtime is
  selected and its gate is not wired.
- **A session-host change appears not to take** — the server spawns the package's
  built entry, so a source change needs a build.
- **The server ignores an environment variable** — a stored setting beat it.
- **A request gets a 403 `forbidden`** — a non-loopback `Origin` that is not in
  `PLOTROOM_TRUSTED_ORIGINS`.
- **Ports already in use** — another session's worktree. Set `PLOTROOM_PORT`.
