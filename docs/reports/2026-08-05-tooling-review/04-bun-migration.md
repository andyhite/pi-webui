# 04 — Bun as the single toolchain

Goal per operator: all apps/packages on Bun, configuration and boilerplate reduced, and the
repo's documented workarounds **removed at the source rather than preserved**. This
supersedes decision 0005 parts (a) "toolchain addition, not a replacement" and (b) "server
stays on Node" — **a new ADR must record that** (0005 itself says the revisit is a new
decision).

## 4.0 Starting position — why this repo is unusually well-placed

- `apps/session-host` already runs, tests (`bun test`), and compiles (`Bun.build
--compile`) under Bun 1.3.14, inside the pnpm workspace, with no second lockfile. The
  hybrid works; the migration generalizes it rather than inventing anything.
- The Vitest surface is measured-plain: **zero** `vi.mock`, jsdom, snapshots, or custom
  `environment:`; three `vi.useFakeTimers()` sites (grep-verified). 0005 itself noted "the
  test surface is cheap".
- The Node coupling is edge-shaped, exactly as 0005 recorded: better-sqlite3 in
  `packages/db/src/client.ts`, `@hono/node-server` + `@hono/node-ws` in the server entry,
  and `node:worker_threads` in `packages/plugin-sdk/src/host.ts` + `worker-entry.ts`.
- Turborepo fully supports Bun workspaces: `workspace:*`, `catalog:`, and `turbo prune`
  producing a pruned `bun.lock` for frozen installs
  ([prune docs](https://turborepo.dev/docs/reference/prune),
  [bun workspaces](https://bun.sh/docs/pm/workspaces)). Turbo stays.

## 4.1 The typecheck question, answered directly

**Bun does not typecheck and does not emit declarations — by design, and that has not
changed.** Bun's own TypeScript guide ships a recommended tsconfig with `"noEmit": true`
and defers checking to the TypeScript compiler
([guide](https://bun.sh/guides/runtime/typescript)); the bundler docs still say `bun build`
is "not intended to replace tsc for typechecking or generating type declarations"
([bundler](https://bun.sh/docs/bundler)). There is no `bun build --dts`. _Something_ must
run the TypeScript checker — that is non-negotiable physics, not a Bun gap.

But that does not mean keeping the current `tsc -b` architecture. Two facts dissolve it:

1. **In a Bun-everything repo, nothing needs compiled JS or `.d.ts` from library
   packages.** Bun executes TS directly; Vite transpiles TS; editors read TS. Declarations
   exist today only because Node consumers needed `dist/*.js` and project references needed
   `composite` + `declaration`
   ([TS refs docs](https://www.typescriptlang.org/docs/handbook/project-references.html)).
   Remove the Node consumers (Phases C–D) and declarations lose their reason. This is
   Turborepo's endorsed pattern for private monorepos
   ([you might not need project references](https://turborepo.dev/blog/you-might-not-need-typescript-project-references)).
2. **The checker got ~10× faster.** TypeScript 7 (the native/Go compiler, `tsgo`) is out;
   the project's own numbers include Sentry's 72.8s → 6.8s for a `--noEmit` check, with
   `--build`, `--noEmit`, declaration emit, and parallel builders/checkers supported
   ([TS 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-beta/)
   — beta post; TS 7 is now stable per operator, verify the exact stable package/binary
   name at implementation time). A whole-graph check of this repo's size should be
   seconds.

**Target architecture** (replaces `build: tsc -b` + `typecheck: tsc -b && tsc -p
tsconfig.tests.json` everywhere):

- Library packages **stop building entirely**. `exports` point at `./src/*.ts` (drop the
  `types` and `default`→dist conditions; TS source is the only target). Delete per-package
  `dist`, `composite`, references, `tsBuildInfoFile`-under-dist, and every
  `tsconfig.tests.json` (tests are simply included in the check).
- **One root no-emit typecheck** over all packages' `src` + tests + `scripts/` (killing
  `tsconfig.scripts.json` too): a single tsconfig, `noEmit`, strictness flags unchanged.
  Base `module`/`moduleResolution` move from `NodeNext` to `"Preserve"`/`"bundler"` —
  Bun's recommended shape, and what makes exports→`.ts` resolution first-class
  ([bun ts guide](https://bun.sh/guides/runtime/typescript)).
- **Checker: TypeScript 7** (native compiler). During cutover, run TS 7 and the pinned
  5.9-line `tsc` against the same tsconfig once, diff the diagnostics on this codebase,
  then drop the old line. Editor: the native LSP; verify the remaining feature gaps don't
  matter here (semantic-highlighting nuances, some import management — the announcements
  list them).
- Turbo: `typecheck` becomes a root task (`//#typecheck`). `build` shrinks to the four
  real artifact builds: web (`vite build`), toolkit CSS (`vite build`), session-host
  `compile`, desktop bundle. `test` drops `dependsOn: ["^build"]` (nothing consumes dist).

**What this deletes, permanently — the "weird things" fixed at the source:**

| Today's workaround                                             | Why it existed                                                                                                                | Why it's gone                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `typecheck` `dependsOn: ["build"]` (own build, #118 torn-dist) | typecheck and build were the same emitting `tsc -b`                                                                           | typecheck never emits; there is no package build to race                               |
| `tsc -b && tsc -p tsconfig.tests.json` two-project dance       | tests excluded from the composite build but still needing a check                                                             | one project includes tests; one command                                                |
| `tsBuildInfoFile` under `dist/` + `.tsbuildinfo.tests`         | emit + incremental state coupling                                                                                             | at most one root `.tsbuildinfo`; possibly none if the cold check is fast enough        |
| `source`/`types`/`default` triple export conditions            | dev wanted TS, prod wanted JS, editors wanted d.ts                                                                            | one target: TS source                                                                  |
| plugins' `test: tsc -b && vitest run` prefix                   | Node worker fixtures loaded `dist` (Node type-stripping can't resolve `.ts` from `.js` specifiers — `worker-entry.ts` header) | Bun workers load TS directly; the constraint documented in `worker-entry.ts` dissolves |
| broad `globalDependencies` for tsconfig bases                  | per-task inputs can't reach above a package                                                                                   | config packages (03 §3.1) + a root typecheck task whose inputs are naturally global    |

**Honest tradeoffs of the root-task shape** (decision table in
[`07-alternatives.md`](07-alternatives.md) §7.3): a root `typecheck` re-runs on any TS
change anywhere (no per-package cache granularity) — acceptable when the whole check runs
in seconds under TS 7, and revisit if it creeps; editor uses one workspace project instead
of references (fine at 12 packages of this size; references' editor-memory benefit targets
much larger repos); go-to-definition lands in source (an upgrade — today it lands in
`.d.ts` unless declaration maps are wired everywhere).

**Sequencing constraint:** the restructure requires that no Node process consumes the
packages at runtime — so it lands **after** the server/runtime swap (Phase D) inside the
coupled milestone, not before. Until then the current `tsc -b` architecture — including
its documented workarounds — stays; they are correct for the world they live in, and they
are removed _with_ that world rather than patched inside it.

## 4.2 Phase A — package manager swap (pnpm → bun)

Mechanical, one branch, repo-wide. No runtime changes yet: scripts still run tsx/vitest/
electron under Node exactly as today (Bun respects bin shebangs).

1. Move workspace globs from `pnpm-workspace.yaml` into root `package.json`
   `"workspaces": ["apps/*", "packages/*", "packages/plugins/*"]`. `workspace:*` deps work
   unchanged.
2. `bun install` → `bun.lock` (text). Delete `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
   `.npmrc` (carry any policy into `bunfig.toml`). Use the **isolated linker** (Bun's
   default for new monorepos) — it is pnpm-strict and will surface phantom imports
   immediately; fix any it finds rather than falling back to hoisted
   ([isolated installs](https://bun.sh/docs/pm/isolated-installs)).
3. **Lifecycle-script audit (`trustedDependencies`).** Bun blocks dependency postinstalls by
   default — the _generalization_ of today's `neverBuiltDependencies: ["better-sqlite3"]`,
   which can be deleted. Packages that DO need scripts while they remain in the tree:
   `electron` (binary download — needed until the shell swap), and audit the rest with
   `bun pm untrusted` after first install. `husky` is a root `prepare` script — root
   lifecycle scripts still run ([install docs](https://bun.sh/docs/pm/cli/install)).
   better-sqlite3 needs **no** trust entry: it must keep using its prebuild, same as today
   (that is what `install.yml` asserts).
4. `packageManager` field → Bun (and/or `devEngines.packageManager`, which turbo docs
   recommend); add `engines.bun >= 1.4.0` (1.4.0 is also the release that fixed the
   historical Playwright stdio blocker — see 07 §7.2); keep `engines.node` while Node
   still runs Playwright/Electron. Pin the Bun version in one place CI and CONTRIBUTING
   read.
5. Replace `pnpm`-isms: root scripts (`pnpm format:check` → `bun run format:check` etc.),
   husky hooks, `turbo` invocations are PM-agnostic already; `.github/actions/setup`
   drops pnpm/store-cache steps for `oven-sh/setup-bun` + Bun install cache
   (`~/.bun/install/cache`); `install.yml`'s "frozen install works on Windows" job becomes
   `bun install --frozen-lockfile` + the same db round trip.
6. **`apps/desktop/scripts/stage-resources.mjs` is the one real casualty:** it uses
   `pnpm --filter @plotroom/server deploy --prod`, a pnpm-specific feature. Interim
   replacement: `turbo prune @plotroom/server --production` + `bun install
--frozen-lockfile` in the pruned output (documented-supported for Bun,
   [prune](https://turborepo.dev/docs/reference/prune)). This machinery is deleted entirely
   in the shell phase, so spend minimally.
7. Update `scripts/workspace-tooling.test.ts` expectations and the `turbo.json` comment
   about lockfile semantics (turbo parses `bun.lock` semantically — verify `--affected` on
   a lockfile-only change behaves; `ci.yml`'s unfiltered-on-lockfile fallback already
   covers the failure mode).

**Acceptance:** clean-machine `bun install --frozen-lockfile` + `bun run verify` green;
`turbo ls --affected` behaves on (a) package change, (b) shared-config change, (c) lockfile
change; Windows install job green; e2e green; desktop packaging still produces a working
AppImage (staging path swapped per item 6).

**Known gaps to not trip over:** Bun has no documented `patchedDependencies` equivalent
(repo uses none today — do not adopt patches while on Bun without checking support);
overrides exist (npm `overrides` syntax).

## 4.3 Phase B — SQLite: better-sqlite3 → `bun:sqlite` (with Drizzle)

**Strategy: single driver, cut over once — sequenced inside the coupled milestone**
(bun:sqlite does not exist under Node, so a Node-spawned server cannot run it, and the
packaged Electron desktop runs the server under `ELECTRON_RUN_AS_NODE`. 0005 priced these
as one change deliberately; that pricing stands). A dual-driver factory is _possible_ —
same Drizzle schema/query builder — but the db package's raw driver surface (below) would
need an abstraction layer that gets thrown away weeks later. Not worth it; sequence instead.

Mechanics:

- Client: `import { Database } from "bun:sqlite"` + `drizzle-orm/bun-sqlite`
  (`drizzle({ client })`) — the adapter is sync internally, mirroring `all/get/values/run`
  ([drizzle bun-sqlite](https://orm.drizzle.team/docs/sqlite/connect-bun-sqlite);
  adapter source verified: `client.prepare(...)`, `client.transaction(...)`, nested
  savepoints).
- **Raw-API delta to audit** (call sites: `client.ts`, `search.ts`, stores exposing
  `state.sqlite`, and db tests):

| better-sqlite3                    | bun:sqlite                                                                                          | Note                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `db.prepare(sql)`                 | `db.prepare(sql)` / `db.query(sql)` (cached, default cache 20)                                      | near-drop-in for `.run/.get/.all/.iterate`              |
| `db.pragma("journal_mode = WAL")` | `db.run("PRAGMA journal_mode = WAL")` or `db.query("PRAGMA …").get()`                               | no `.pragma()` helper — wrap once in `client.ts`        |
| `db.exec(sql)`                    | `db.run(sql)` (multi-statement)                                                                     |                                                         |
| `db.transaction(fn)`              | `db.transaction(fn)` (+ `.deferred/.immediate/.exclusive`, nested → savepoints)                     | semantics match                                         |
| `.pluck()/.raw()/.expand()`       | none — use `.values()` or map rows                                                                  | grep for usage; believed absent `[INFERENCE — verify]`  |
| `db.backup()`                     | none — `db.serialize()` / `Database.deserialize()`                                                  | check maintenance/backup routes                         |
| int64                             | `safeIntegers` option (per-db or per-statement)                                                     | decide explicitly; better-sqlite3 defaulted differently |
| `db.loadExtension()`              | exists, but **not on macOS system SQLite** (Apple build); `Database.setCustomSQLite()` escape hatch | repo loads no extensions today                          |

- **FTS5 is the hard gate.** Bun's docs do not promise FTS5 or state the bundled SQLite's
  compile flags; Linux/Windows use Bun's static SQLite, macOS uses Apple's system SQLite
  ([bun:sqlite docs](https://bun.sh/docs/runtime/sqlite)). The repo's search is FTS5 +
  `snippet()` + weighted `bm25()` (`packages/db/src/search.ts`). **Before any code moves:**
  add a probe test (create an `fts5` virtual table, run `MATCH`/`snippet`/`bm25`,
  check `sqlite_compileoption_used('ENABLE_FTS5')`) and run it on all three OSes in CI —
  extend/repurpose `install.yml` into that platform round trip. If any platform fails,
  `Database.setCustomSQLite()` with a shipped SQLite is the fallback; record whichever way
  it lands in the ADR. (Apple's system SQLite has shipped FTS5 for years, and Bun's static
  builds are believed to enable it — but this repo's rule is measure, don't believe.)
- Keep the explicit PRAGMAs (`WAL`, `foreign_keys ON`, `synchronous NORMAL`,
  `busy_timeout 5000`) — bun:sqlite defaults differ and WAL sidecar cleanup differs on
  macOS (persistent WAL; use `SQLITE_FCNTL_PERSIST_WAL` fileControl + truncate checkpoint
  on close if the state directory must stay tidy — the persistence note's "single portable
  file" property is why this matters).
- Preserve observable invariants: migration atomicity via `db.transaction`, the FK
  off/`foreign_key_check`/on rebuild dance in `client.ts:80-113`, and `schema_migrations`
  semantics. The migration tests already cover these; they are the acceptance suite.
- Payoffs: `neverBuiltDependencies` gone, `install.yml`'s prebuild dance gone, the
  electron-rebuild class of problems gone, and 0005's promised deletion of the
  `extraResources` native-module split.

## 4.4 Phase C — test runner: Vitest → `bun test`

**Recommended: adopt bun test.** Rationale: the measured test surface uses nothing Vitest-
specific (§4.0); session-host already established the pattern and the meta-test already
models it as a deviation — the migration _inverts the deviation map_ (bun test becomes the
template; nothing remains the exception); it deletes every `vitest.config.ts`, the vitest/
vite-5 subtree, and the runner version-drift class entirely. Bun test has what this repo
uses: watch, coverage (text/lcov), JUnit reporter, fake timers, concurrency controls
([test config](https://bun.sh/docs/test/configuration),
[coverage](https://bun.sh/docs/test/code-coverage)).

Mechanics:

- Per package: `test: bun test src` (mirrors session-host; scoping to `src` keeps
  Playwright specs out). Imports change `vitest` → `bun:test` (`describe/it/expect`
  are Jest-compatible; the three `vi.useFakeTimers()` sites → bun's fake timers).
- Root `bunfig.toml` `[test]` for shared knobs; the per-package 30s-timeout exceptions
  (git/github/jira plugins) become `bun test --timeout 30000` in those packages' scripts —
  keeping the deviation visible in the manifest, which the meta-test then asserts.
- `scripts/**` tests move to `bun test` too (`test:scripts`), removing
  `vitest.scripts.config.ts`.
- Turbo task shape unchanged until the TS restructure lands (`test` still `dependsOn:
["^build"]` while plugin tests exercise built workers); afterwards the dependency drops.
- Update `docs/development.md`'s per-shape test commands (own docs change, per repo rules).

**Fallback if a blocker appears** (e.g. a bun-test behavior gap in the worker-heavy plugin
tests): upgrade Vitest to 4.x instead (03 §3.4) and stop — the rest of the Bun migration
does not depend on this phase.

## 4.5 Phase D — server runtime: Node → Bun

- Entry: replace `@hono/node-server` `serve()` with `export default { fetch: app.fetch,
port }` / `Bun.serve`; replace `@hono/node-ws` + `ws` with Hono's Bun WebSocket helper
  (`hono/bun` `createBunWebSocket`) — Hono is Bun-native
  ([hono on bun](https://hono.dev/getting-started/bun)). Drop `ws` and both `@hono/node-*`
  deps. The WS upgrade path is the riskiest edit: the observation-log/attention WS routes
  have integration tests; they are the acceptance suite.
- Dev: `tsx watch --conditions=source src/index.ts` → `bun --watch src/index.ts` (Bun runs
  TS directly; until the TS restructure lands, keep resolving workspace deps to source via
  the `source` condition — **verify `--conditions` support on the pinned Bun version**, or
  set the condition in `bunfig.toml`; after the restructure the condition machinery is
  gone entirely). Drop `tsx`.
- **Plugin host (`packages/plugin-sdk`):** keep `node:worker_threads` imports — Bun
  implements the core surface (creation, `workerData`, `parentPort`, message/error/exit,
  `postMessage`) but not every option ([reference](https://bun.sh/reference/node/worker_threads)).
  The host clears `execArgv` and uses no stdio/resourceLimits options, so the used surface
  is the supported one `[INFERENCE — the gate is the existing real-worker tests]`. The
  plugin-sdk and plugin test suites running under `bun test` **are** the compatibility
  proof; if a gap surfaces, the adapter seam is one file (`host.ts` worker construction).
- Session-host spawn path unchanged (server already spawns `bun`).
- CI: `code` job runs everything under Bun (setup already installs Bun); `spike.yml`
  unchanged (already Bun).

**Sequencing constraint (restating 4.3):** landing this with bun:sqlite breaks the packaged
Electron desktop until the new shell lands (dev-mode desktop is fine — it can spawn
host-installed `bun`). Plan both inside one milestone; see 06.

## 4.6 Phase E — the TypeScript restructure (§4.1's target architecture)

Lands immediately after Phase D inside the coupled milestone (it needs "no Node consumers"
to be true). Steps, each verifiable on its own:

1. Base tsconfig: `module: "Preserve"`, `moduleResolution: "bundler"`, `noEmit`; drop
   `composite`/`declaration`/`declarationMap`; strictness flags unchanged.
2. Exports: collapse `source`/`types`/`default` to a single `.ts` target per subpath;
   delete `main`/`types` dist fields; scrub `dist` from tooling assumptions
   (turbo `build.outputs`, staging scripts).
3. Delete per-package `tsconfig.tests.json` and `build` scripts for the nine library
   packages; delete `tsconfig.scripts.json` (root check includes `scripts/`).
4. Root `typecheck` task: TypeScript 7 native compiler, `-p tsconfig.json --noEmit`,
   wired as turbo `//#typecheck`; one-time diagnostics diff against the pinned 5.9 `tsc`
   on the same config, then remove the old line. Delete the own-build-first `dependsOn`
   and rewrite the `turbo.json` comments **with their reasons** (#118's mechanism no
   longer exists).
5. `test` drops `dependsOn: ["^build"]`; plugins drop their `tsc -b &&` test prefix
   (workers load TS under Bun).
6. `build` keeps only: web, toolkit (CSS), session-host `compile`, desktop bundle.
7. Meta-test rewritten to enforce the new template (no build script on library packages,
   single-target exports, no stray tsconfigs).
8. Editor: adopt/verify the TS 7 native language server on the single workspace project;
   go-to-definition now lands in source by construction.

**Acceptance:** verify green with the new pipeline; e2e green (harness spawns `bun
src/index.ts` server, Vite-built web); packaged app green; a deliberate type error in a
deep package fails `typecheck`; a deliberate test-only type error fails it too (the old
second project's job); cold and warm `typecheck` times recorded in the PR (this is the
measurement that justifies — or revisits — the root-task shape; see 07 §7.3).

## 4.7 What breaks — consolidated checklist

1. Lockfile/caches/CI keys all change (Phase A) — expected, one-time.
2. Native/postinstall deps silently skip scripts until trusted (Phase A audit).
3. Phantom deps surface under the isolated linker (Phase A — fix manifests, don't hoist).
4. `pnpm deploy` staging (Phase A item 6; deleted in the shell phase).
5. bun:sqlite API deltas + FTS5 platform probe (Phase B gate).
6. WS adapter swap (Phase D; integration tests cover).
7. worker_threads option gaps (Phase D; real-worker tests cover).
8. TS 7 native compiler: one-time diagnostics-parity diff on this codebase before it
   becomes the gate (Phase E step 4); editor feature gaps checked against actual use.
9. e2e runner stays on Node for now — re-evaluate Playwright-under-Bun on its own track
   (07 §7.2); never let it block the milestone.
10. `scripts/workspace-tooling.test.ts` must be updated **first** in each phase — it is the
    enforcement, and it will (correctly) fail every phase until it is taught the new
    template.
