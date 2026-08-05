# 01 — Current state: full tooling inventory

Facts only; assessment is in `02-assessment.md`. Citations are `file:line` against
`main` @ `8075bab7`.

## 1. Workspace and task orchestration

- **Package manager:** pnpm 9.12.0 (`package.json:8` `packageManager`), Node `>=22.18`
  (`package.json:9-11`). Workspace globs: `apps/*`, `packages/*`, `packages/plugins/*`
  (`pnpm-workspace.yaml`).
- **pnpm settings:** `pnpm.neverBuiltDependencies: ["better-sqlite3"]` (`package.json:30-34`)
  — suppresses the native build script; the prebuilt binary is used instead (validated by
  `install.yml`, see §7). `.npmrc`: `strict-peer-dependencies=false`,
  `auto-install-peers=true`, `resolution-mode=highest`. No `patchedDependencies`, no
  overrides.
- **Task runner:** Turborepo, declared `^2.3.3`, **installed 2.10.8** (lockfile). Root
  `turbo.json` tasks: `build` (`^build`, outputs `dist/**`), `compile` (`^build`, uncached),
  `typecheck` (depends on **own** `build`), `lint`, `test` (`^build`), `dev` (persistent,
  uncached). `globalDependencies` lists the six shared configs
  (`tsconfig.json`, `tsconfig.base.json`, `tsconfig.tests.base.json`, `eslint.config.js`,
  `vitest.base.config.ts`, `.npmrc`) — `turbo.json:27-34`.
- **Root scripts** (`package.json:12-29`): turbo wrappers (`build`, `compile`, `dev`,
  `check` = `turbo run typecheck lint test`, …) plus a parallel **non-turbo** pipeline for
  root-level `scripts/` and config files: `typecheck:scripts` / `lint:scripts` /
  `test:scripts` / `check:scripts`. The full local gate is
  `verify = format:check && check && check:scripts`.
- **No remote cache.** CI caches `.turbo/cache` via `actions/cache` keyed
  `os/job/sha` with branch→main restore keys (`.github/actions/setup/action.yml`).

## 2. TypeScript

- **Project references throughout.** Root `tsconfig.json` is an empty solution file
  referencing all 12 projects. `tsconfig.base.json`: NodeNext, ES2023, `strict` plus
  `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, `isolatedModules`, `composite` + `incremental`, declarations +
  maps, `skipLibCheck`.
- **Per package:** `tsconfig.json` extends the base, `rootDir: src` → `outDir: dist`,
  `tsBuildInfoFile: dist/.tsbuildinfo` (deliberate: deleting `dist/` forces a rebuild —
  `AGENTS.md` "Commands"), excludes `src/**/*.test.ts`. A second project,
  `tsconfig.tests.json`, extends the package config + `tsconfig.tests.base.json`
  (no-emit, non-composite, own `dist/.tsbuildinfo.tests`) and typechecks the tests.
- **Scripts:** `tsconfig.scripts.json` typechecks `scripts/**/*.ts` and `*.config.ts`
  (no emit; relies on Node 22 type-stripping to _run_ `scripts/release.ts` directly).
- **Every package:** `build: tsc -b`, `typecheck: tsc -b && tsc -p tsconfig.tests.json`.
  So `typecheck` **re-runs the emitting build** — see the do-not-fix list, §9.

## 3. Packages — the enforced template

Nine packages (`core`, `db`, `plugin-sdk`, `ui`, `toolkit`, `plugins/{filesystem,git,github,jira}`)
share one manifest shape: private, ESM-only (`type: module`, no CJS condition), `main`/`types`
→ `dist`, and conditional `exports` with **three conditions**:
`source` → `./src/*.ts` (raw TS), `types` → `./dist/*.d.ts`, `default` → `./dist/*.js`.
The `source` condition is how dev-mode consumers get live TS (`apps/server` dev runs
`tsx watch --conditions=source`; `apps/web/vite.config.ts` puts `"source"` first in
`resolve.conditions`).

Deltas from the template (all deliberate, most annotated in-file):

| Package                   | Delta                                                                                                                                                                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`                    | extra `./testing` subpath export; no TS references                                                                                                                                                                                                                                             |
| `db`                      | deps `better-sqlite3@13.0.2` + `drizzle-orm@0.45.2`; devDep `drizzle-kit@0.31.10` (**unused** — no `drizzle.config.*` exists anywhere, no script invokes it)                                                                                                                                   |
| `ui`                      | DOM libs + `react-jsx`; references core, plugin-sdk, all plugins, toolkit                                                                                                                                                                                                                      |
| `toolkit`                 | dual emitter: `tsc` with `emitDeclarationOnly` + **Vite library build** for JS and `toolkit.css` (Tailwind v4 via `@tailwindcss/vite`); custom `checkThemeCss` Vite plugin fails the build if committed `src/theme.generated.css` is stale vs `renderThemeCss()`; `tokens:emit` regenerates it |
| `plugins/git,github,jira` | `test: tsc -b && vitest run` (build first — real worker/subprocess fixtures need `dist`); vitest configs merge the shared base with a 30s timeout, each with a comment saying why                                                                                                              |
| `plugins/*`               | public `./renderer-manifest` subpath; `github`/`jira` also `./testing`                                                                                                                                                                                                                         |

**Vitest:** `vitest.base.config.ts` exports `packageTests` (include `src/**/*.test.ts` only —
`.spec.ts` is reserved for Playwright). Per-package `vitest.config.ts` re-exports it; the
meta-test asserts each package's config resolves to the _same array object_, so nobody can
fork the include silently.

**The meta-test** (`scripts/workspace-tooling.test.ts`) is the convention-enforcement
mechanism for all of the above: it expands the workspace globs and asserts, per package:
`@plotroom/*` naming; canonical `build`/`typecheck`/`lint`/`test` scripts (with an explicit
deviation map for session-host's Bun scripts and the plugins' `tsc -b &&` test prefix);
tests project shape; the shared-vitest-object identity; that any `node:` import is backed by
`@types/node` (or `@types/bun`) in that manifest. **Any tooling migration edits this file as
its enforcement step.**

## 4. Apps

### `apps/server` — Node + Hono

`build: tsc -b`; `dev: tsx watch --conditions=source src/index.ts`; deps
`@hono/node-server`, `@hono/node-ws`, `ws`, `hono@4.12.33`, `zod@4`, all workspace packages.
Serves the built renderer in prod: `defaultStaticDir()` resolves `../../web/dist`
(`apps/server/src/config.ts:150-153`); returns 503 with "renderer missing" when absent
(`app.ts` ~503). Spawns the session host with a configurable executable defaulting to
`"bun"` (`config.ts:96-107`).

### `apps/web` — Vite + React renderer

`build: tsc -b && vite build` (vite 8.2.0); `dev: vite` with `/api` + `/ws` proxy and
`source`-condition resolution for workspace HMR. Unit tests Vitest. **Two Playwright
configs**: `e2e/playwright.config.ts` (the real gate: hermetic, spawns built
`server/dist` serving built `web/dist`, headless, `workers: 1`, retries 0, `testIgnore`s the
Electrobun spec) and `e2e/playwright.electrobun.config.ts` (opt-in spike only, 15-min
timeout; downloads ~210MB CEF into ~1.6GB scratch on cold run). `typecheck` also checks
`e2e/tsconfig.json`.

### `apps/desktop` — Electron shell (thin)

`build: tsc -b && node scripts/copy-static-assets.mjs`; `start: electron .`; **no `dev`
script**. Electron 43.2.0, electron-builder 26.15.3, electron-updater. Main process is
minimal: resolve sibling `server/dist/index.js`, spawn it with `process.execPath` +
`ELECTRON_RUN_AS_NODE=1` + an IPC channel, or attach to an existing/remote backend
(`src/main.ts:83-145`). Packaging: `scripts/stage-resources.mjs` builds server+web, runs
`pnpm --filter @plotroom/server deploy --prod` into `build/resources/server`
(symlink-preserving), copies `web/dist`; `electron-builder.yml` stages those as
`extraResources` with a **deliberately split entry for `server/node_modules`** (electron-
builder excludes child `node_modules` dirs); targets Linux AppImage/deb (verified), mac dmg

- Windows NSIS (configured, unverified); `publish: null` — updater wired but no feed/signing
  decided (`docs/deployment.md`).

### `apps/session-host` — the Bun precedent (decision 0005)

pnpm-managed deps (single root lockfile — **no second lockfile**), but Bun runs three
things: `test: bun test src` (tests import `bun:test`), `compile: bun src/compile.ts`
(→ `Bun.build` `--compile`; stages `pi_natives.<platform>*.node` beside the ~400MB binary —
the artifact is a **directory**, per 0005's amendment), and the packaged runtime.
`build`/`typecheck` remain `tsc -b`; tsconfig sets `types: ["bun"]` (the only package that
does). Pinned exact dep `@oh-my-pi/pi-coding-agent@17.2.8` (raw-TS entry, requires Bun
≥1.3.14). No vitest config — the one allowed template deviation.

## 5. Lint / format / commits

- **ESLint 9.39.5 flat config, single root file** (`eslint.config.js`, 172 lines):
  `@eslint/js` recommended + typescript-eslint recommended + `eslint-config-prettier`;
  consistent type-imports; underscore-unused convention; `no-console` warn (off for
  scripts/tooling). Plus **architectural rules**: all workspace imports of `toolkit`
  internals forbidden (including dynamic import, via AST selector), and a
  **hand-maintained file list** of plugin renderer-reachable modules where Node imports /
  `Buffer` / `process` are forbidden. Each package runs `eslint .` from its own cwd; flat
  config resolution walks up to the root file.
- **Prettier 3.9.6** with `prettier-plugin-tailwindcss` pinned to
  `packages/toolkit/src/toolkit.css` as the stylesheet (`.prettierrc.json`). `.prettierignore`
  covers generated trees, the lockfile, the product spec, design exports, generated theme CSS.
- **commitlint** (`commitlint.config.js`): conventional config, 11-type enum, kebab scope,
  72-char header; one exact-string ignore for a historical 73-char commit.
- **husky:** `pre-commit` = refuse `main` commits (unless `ALLOW_MAIN_COMMIT=1`), enforce
  branch naming, run `format:check`; `commit-msg` = commitlint.

## 6. Release

`pnpm release` → `scripts/release.ts` run directly by Node 22 type-stripping: requires main

- clean tree, validates the whole commit range with commitlint, derives the bump from an
  exhaustive type table (`scripts/release/version.ts`), regenerates `CHANGELOG.md`
  (`notes.ts`/`changelog.ts` — every commit appears exactly once), commits with scoped
  `ALLOW_MAIN_COMMIT=1`, tags, prints (does not run) the push. All of it unit-tested under
  `vitest.scripts.config.ts`. This is the **one** sanctioned non-PR write to `main`
  (decision 0003).

## 7. CI (GitHub Actions)

| Workflow      | Trigger                                                           | Jobs / gating                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checks.yml`  | every PR + main push, **no path filters**                         | `format` (prettier check); `commits` (commitlint over the PR range + reject merge commits); `pr-title` (lints the future squash subject incl. ` (#N)` suffix)                                                                                                                                                                                                                                                                                  |
| `ci.yml`      | PR + main push, `paths-ignore` docs/prose                         | `scope` (computes `turbo ls --affected` via `TURBO_SCM_BASE/HEAD`; **unfiltered** on main or when root manifests/lockfile/`.npmrc` change) → `code` (`pnpm check` scoped + `check:scripts` always) → `e2e` (only if web affected: turbo-build web's upstream graph, Playwright chromium, artifacts on failure) → `session-host-binary` (only if session-host affected: **native matrix** ubuntu/macos/windows, `pnpm compile` incl. smoke run) |
| `install.yml` | manifest/lockfile paths only                                      | Windows: fresh install must use the better-sqlite3 **prebuild** (refuses a compiled binding), then an in-memory create/insert/select round trip through `packages/db`                                                                                                                                                                                                                                                                          |
| `spike.yml`   | daily cron + changes to `apps/session-host/package.json` + manual | real-SDK suite against the **compiled** session-host binary; needs `ANTHROPIC_API_KEY`; red = the pinned SDK moved                                                                                                                                                                                                                                                                                                                             |

Setup composite (`.github/actions/setup`): pnpm → Node 22 (pnpm store cache) → optional Bun
1.3.14 → `pnpm install --frozen-lockfile` → optional `.turbo/cache` cache. Main pushes run
the full graph, which is what publishes warm caches for branch runs.

## 8. The design gate (affects tooling choices)

Decision 0002 + `AGENTS.md`: no authored CSS outside `packages/toolkit`; Tailwind v4 exists
_only_ inside toolkit's Vite build; `prettier-plugin-tailwindcss` at the root is the
formatting half of that. `packages/ui` deliberately has **no** jsdom/component-test infra —
render-adjacent logic is extracted into pure functions and unit-tested; anything
user-visible is proven in Playwright (`docs/development.md`, shape 5).

## 9. Deliberate mechanisms that look like hacks — and their retirement schedule

Every item below is documented in-repo and was verified in place. **The operator's
direction is to fix these at the source, and the plan does** — the table in
`04-bun-migration.md` §4.1 maps each to the phase that removes its _reason_. What an
implementer must not do is delete a workaround while its reason still exists: each was the
fix for a measured failure, and removing it early reintroduces that failure. "Retired by"
below names the step that makes deletion safe.

1. **`typecheck` `dependsOn: ["build"]` (own build)** — `turbo.json:46-63`. Both scripts are
   `tsc -b` over the same project; running them as siblings produced **torn `dist/` files
   that turbo then cached** (#118). Own-build-first makes the second `tsc -b` a no-op check.
   _Retired by_ 04 Phase E: `typecheck` stops emitting entirely, so there is nothing to
   race — the workaround leaves with its reason.
2. **Broad `globalDependencies`** — `turbo.json:4-34`. Not just cache-busting: the same list
   drives `--affected` **selection**; a shared base missing from it makes CI "select nothing
   and report green having checked nothing" (measured on turbo 2.10.8). _Retired by_ the
   config-package refactor (03 §3.1) plus the root typecheck task (04 Phase E); the
   selection property must be re-measured, not assumed, at that point.
3. **`compile` uncached** — the artifact is ~400MB and the task ends with a smoke run; a
   cache hit would replay a stale smoke test and store the binary twice (`turbo.json:40-45`).
   _Stays_ — this is not a workaround; caching a smoke run is wrong by definition.
4. **`pnpm-lock.yaml` deliberately absent from `globalDependencies`** — turbo parses it
   semantically; `ci.yml` runs unfiltered on lockfile changes instead (`turbo.json:22-26`).
   _Carries over_ to `bun.lock` unchanged (verify in 04 Phase A step 7).
5. **Playwright e2e outside `verify`/turbo `test`** — hermetic prod-shaped gate needing a
   prebuild; run explicitly per `AGENTS.md`. _Stays_ (07 §7.2 keeps the runner too).
6. **`.prettierignore` on `docs/product-spec.md` and design exports**; **commitlint
   exact-message ignore** for one historical commit — historical records are immutable
   here. _Stays._
7. **`extraResources` split for `server/node_modules`** — electron-builder's copier excludes
   child `node_modules`; the split is the workaround (`electron-builder.yml`, annotated).
   _Retired by_ the shell swap (05 §5.C) — with bun:sqlite and an in-process server there is
   no `node_modules` tree to stage at all.
8. **Spike suite runs against the compiled binary, not `bun dist/main.js`** — compiling flips
   `isCompiledBinary()` SDK-wide and is the only path that exercises `worker-dispatch.ts`
   (0005 amendment; `spike.yml` header). _Stays._
9. **`tsBuildInfoFile` under `dist/`** — so `rm -rf dist` forces a true rebuild
   (`AGENTS.md`); the tests project writes `.tsbuildinfo.tests` alongside for the same
   reason. _Retired by_ 04 Phase E — library packages stop emitting, so there is no
   `dist`, no build info, and no second tests project.
10. **Root `scripts/` outside the workspace** — release tooling must not be a package the
    graph depends on; it gets its own `check:scripts` lane instead, and CI always runs it.
    _Simplified by_ 04 Phase E (the root typecheck absorbs `tsconfig.scripts.json`; the
    separate test lane remains).
