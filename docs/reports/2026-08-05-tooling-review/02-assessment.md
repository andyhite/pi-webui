# 02 — Assessment against best practice

Judgment calls, prioritized. "Best practice" here means the current upstream guidance from
Turborepo, TypeScript, typescript-eslint, Vitest, ESLint, and Prettier docs (URLs inline),
tempered by what this specific repo needs.

## 2.1 What is genuinely excellent (keep, and keep the _pattern_)

- **Conventions enforced, not documented.** `scripts/workspace-tooling.test.ts` asserts the
  package template (scripts, tsconfig shape, shared-vitest identity, `@types/node`
  presence) across every workspace member, with an explicit deviation map for sanctioned
  exceptions. The _mechanism_ is what's valuable — enforcement over documentation — and it
  transfers: per operator direction the test's checks move into custom lint rules in the
  shared config package (03 §3.8), most of its subject matter having been deleted by the
  TS restructure anyway. Until each stage lands, the test remains the enforcement and each
  stage updates it (or its lint-rule successor) _first_.
- **Annotated deviations.** `turbo.json`, `electron-builder.yml`, the plugin vitest
  configs, and the Playwright configs all say _why_ they deviate, usually with a measurement
  or an issue number. This review's do-not-fix list (01 §9) is possible only because of that.
- **Layered CI gating.** Workflow-level path filters + a `scope` job computing
  `turbo ls --affected` + job-level gates means required checks can pass as skipped-success
  without lying. The `scope` job's fallback to unfiltered on root-manifest/lockfile changes
  closes the classic `--affected` blind spot.
- **The `source` export condition** giving live-TS dev (tsx/Vite) while `default` stays
  compiled JS. This is exactly Turborepo's "Compiled package" strategy with a JIT escape
  hatch ([internal packages](https://turborepo.dev/docs/core-concepts/internal-packages)),
  and it is the hinge that makes the Bun migration cheap (04 §4.5).
- **Hermetic, prod-shaped Playwright gate** spawning the real built server serving the real
  built renderer — plus the Electrobun spike kept out of the default gate by construction.
- **Release tooling** that is unit-tested, refuses unparseable history, and confines the
  `main`-write exception to one script (decision 0003).
- **Test hygiene**: no `vi.mock`, no snapshots, no jsdom anywhere; three
  `vi.useFakeTimers()` call sites total (verified by grep). Logic is extracted to pure
  functions instead of mocked into testability. This is why the test-runner question in 04
  is a real choice rather than a rewrite.

## 2.2 Version currency (installed, from `pnpm-lock.yaml`)

| Tool                        | Declared           | Installed                           | Current stable (reported 2026-08)                                           | Note                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ------------------ | ----------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| turbo                       | `^2.3.3`           | 2.10.8                              | 2.10.x                                                                      | **Raise the declared floor.** `turbo.json`'s own comments say "measured on turbo 2.10.8"; the config's correctness claims assume behavior the declared range does not guarantee. Pin `^2.10.8`.                                                                                                                                    |
| typescript                  | `^5.7.2`           | 5.9.3                               | **7.x stable** (native compiler, ~10× checker — operator-confirmed current) | Adopt TS 7 as the checker **inside** the TS restructure (04 §4.1/§4.6): the restructure removes emit and project references, which is exactly the surface where a compiler swap carries risk, so doing both together with one diagnostics-parity diff is cheaper than two migrations. Until then, raise the 5.x floor to `^5.9.3`. |
| vitest                      | `^2.1.8`           | **2.1.9**                           | 4.x                                                                         | **Two majors behind**, and vitest 2 pins a **transitive vite 5.4.21** next to web's vite 8.2.0 — two Vite majors resolved in one tree. Resolved either by upgrading to vitest 4 or by the bun-test migration (04 §4.4). Don't leave as-is.                                                                                         |
| vite (web)                  | `^8.2.0`           | 8.2.0                               | 8.x                                                                         | Fine.                                                                                                                                                                                                                                                                                                                              |
| eslint                      | `^9.16.0`          | 9.39.5                              | 10.x reported; ESLint 9 EOL reported imminent                               | Mostly superseded by the linter modernization (03 §3.3): oxlint takes the JS/TS path; ESLint shrinks to a micro-pass hosting the custom plugin + package.json rules, where its version is low-stakes (bump to 10.x when convenient).                                                                                               |
| typescript-eslint           | `^8.18.0`          | 8.65.0                              | 8.x                                                                         | Removed by 03 §3.3 (type-aware moves to oxlint/tsgolint).                                                                                                                                                                                                                                                                          |
| prettier                    | `^3.4.2`           | 3.9.6                               | 3.9.x                                                                       | Fine. **Verify** `prettier-plugin-tailwindcss@^0.8.1` against prettier 3.9 + Tailwind v4 — it predates both by a while.                                                                                                                                                                                                            |
| electron / electron-builder | `^43` / `^26.15.3` | 43.2.0 / 26.15.3                    | —                                                                           | Retired by the shell migration (05, either plan); don't invest.                                                                                                                                                                                                                                                                    |
| better-sqlite3              | `^13.0.2`          | 13.0.2                              | —                                                                           | Retired by bun:sqlite (04 §4.3).                                                                                                                                                                                                                                                                                                   |
| drizzle-orm                 | `^0.45.2`          | 0.45.2                              | —                                                                           | Kept; gains a `bun-sqlite` driver import.                                                                                                                                                                                                                                                                                          |
| react                       | `^19.2.0`          | **19.2.7 and 19.2.8 both resolved** | —                                                                           | Harmless but sloppy: two patch versions of react in one lockfile (an artifact of `resolution-mode=highest` at different install times). Dedupe.                                                                                                                                                                                    |
| @types/node                 | `^26.1.2`          | 26.1.2                              | —                                                                           | Mostly removable post-Bun (kept where Node APIs remain, e.g. Playwright harness).                                                                                                                                                                                                                                                  |

The deeper issue than any one row: **`resolution-mode=highest` + caret ranges means the
lockfile drifts upward on every fresh `pnpm install` of a new dep**, and manifest ranges
stop describing what's tested. Recommendation in 03 §3.2.

## 2.3 Issues, prioritized

### P1 — worth fixing soon regardless of migrations

1. **Vitest 2 / dual-Vite tree** (table above). Cheapest durable fix is the bun-test
   migration; if that is delayed, bump vitest to 4.x first — `projects` replaced
   `workspace` in 3.2 ([vitest projects](https://vitest.dev/guide/projects)), but this repo
   doesn't use either, so the upgrade surface is small (per-package configs re-export one
   base object).
2. **Unused `drizzle-kit`** devDep in `packages/db`: no `drizzle.config.*` exists, no script
   invokes it; migrations are hand-written embedded SQL (a deliberate, documented choice —
   `docs/architecture/persistence.md`). A dep that big and that security-relevant should not
   sit unused. Remove it (or wire it up intentionally — but the embedded-migrations
   architecture note argues against that; removal is the right call).
3. **Declared-vs-assumed turbo floor** (table above).
4. **Duplicate ignore entries**: `.pi-subagents/` appears twice in `.gitignore` (lines 15-16
   and 45-46); `.prettierignore` also carries a duplicate. One-line cleanups.

### P2 — structural, best rolled into the migrations

5. **`globalDependencies` over-invalidation vs config packages.** Current pattern: six
   shared root files bust _every_ task's cache on any change, documented as the price of
   `--affected` correctness (01 §9.2). Upstream now recommends **internal config packages**
   (`@repo/typescript-config`-style) so shared config participates in the package graph and
   invalidation is exact ([turborepo tools guide](https://turborepo.dev/docs/guides/tools),
   [internal packages](https://turborepo.dev/docs/core-concepts/internal-packages));
   `$TURBO_ROOT$` inputs exist for the residual root-file cases
   ([configuring tasks](https://turborepo.dev/docs/crafting-your-repository/configuring-tasks)
   — verify against installed 2.10.8). Recommendation in 03 §3.1. **Constraint:** the
   refactor must preserve the _selection_ property — re-run the measurement in the
   `turbo.json` comment (change a shared config; assert every package is selected).
   <a id="item-5a"></a>**5a. No type-aware linting.** The flat config composes
   `tseslint.configs.recommended`, not `recommendedTypeChecked`
   (verified: `eslint.config.js:29`; no `projectService`/`parserOptions` anywhere in the
   file). Rules like `no-floating-promises`, `no-misused-promises`, and `await-thenable`
   are therefore off — a real gap for an async Hono server with WS routes and a worker
   protocol. Fixed by the linter modernization (03 §3.3): `oxlint --type-aware` delivers
   59/61 typescript-eslint type-aware rules via tsgolint at native speed
   ([docs](https://oxc.rs/docs/guide/usage/linter/type-aware.html)); budget for a wave of
   newly surfaced findings.
6. **Build/typecheck duality** — `typecheck` re-runs the emitting `tsc -b` and depends on
   own `build` to avoid torn output (#118). Sound workaround; the root cause is that
   _typecheck and build are the same emitting command_. **Fixed at the source in the
   mainline plan** (04 §4.1 + Phase E, per operator direction): library packages stop
   emitting entirely, typecheck becomes one root no-emit TS 7 check, and the workaround
   retires with its reason. The one rule that remains: do not delete the workaround
   _before_ Phase E — inside the current Node-consumer world it is correct.
7. **Renderer-boundary lint via hand-maintained file list** (`eslint.config.js`). The
   comment admits new renderer-reachable modules can silently bypass it. The rule moves
   into the shared custom plugin (03 §3.3/§3.8) as-is first; improving it (generate the
   file list from the module graph, or Turborepo `boundaries` tags — experimental, verify
   on 2.10.x) is a follow-up, not a blocker. Not urgent; the plugin renderer surface is
   small.
8. **No remote cache.** `actions/cache` of `.turbo` keyed per job+sha works but only warms
   from same-branch/main history and re-uploads whole caches. Vercel Remote Cache (OIDC,
   zero-secret) or a self-hosted cache would deduplicate across jobs and PRs
   ([turbo + GHA](https://turborepo.dev/docs/guides/ci-vendors/github-actions)). Medium
   value now; higher after the compile matrix grows (the shell packaging matrix, 05 §5.C).

### P3 — minor / cosmetic

9. **Two hand-maintained root file lists**: `tsconfig.scripts.json` `include` vs
   `lint:scripts` args (`eslint scripts *.config.js *.config.ts`) — easy to update one and
   not the other. Fold both into one glob source of truth when touched next.
10. **`.prettierignore` lists `pnpm-lock.yaml`** — prettier doesn't format lockfiles;
    harmless, delete when touched. (Dies with pnpm anyway.)
11. **No `.vscode/` committed** despite `extensions.json`/`settings.json` being allowlisted
    in `.gitignore`. Optional: commit format-on-save + ESLint + TS-workspace-version
    settings so editors match the gates. (The allowlist entries suggest this was intended.)
12. **`apps/desktop` has no `dev` script** — `turbo run dev` covers server+web only;
    desktop dev is `build` + `start`. Fine for a thin shell; note it in the Electrobun
    migration (hutch has `dev --watch`).
13. **`.npmrc` `strict-peer-dependencies=false` + `auto-install-peers=true`** hide manifest
    defects. If pnpm were staying, tighten; since pnpm is likely leaving, just carry the
    lesson: don't recreate the looseness in `bunfig.toml` (Bun's stricter isolated-linker
    default is the desired behavior).

## 2.4 Dead / redundant config inventory (complete list)

| Item                                               | Where                         | Action                                           |
| -------------------------------------------------- | ----------------------------- | ------------------------------------------------ |
| Duplicate `.pi-subagents/` ignore                  | `.gitignore:15-16,45-46`      | delete one block                                 |
| Duplicate `.pi-subagents/` ignore                  | `.prettierignore:2,21`        | delete one                                       |
| `pnpm-lock.yaml` in `.prettierignore`              | `.prettierignore`             | delete (moot post-Bun)                           |
| `drizzle-kit` devDep                               | `packages/db/package.json:29` | remove                                           |
| react 19.2.7 + 19.2.8 dual resolution              | `pnpm-lock.yaml`              | dedupe (or regenerate lockfile in the Bun swap)  |
| turbo `^2.3.3` floor                               | `package.json:45`             | raise to `^2.10.8`                               |
| `.vscode` allowlist entries with no `.vscode/` dir | `.gitignore:41-43`            | either commit the settings or drop the allowlist |

## 2.5 What was checked and found _not_ to be a problem

- **ESM-only, no dual CJS builds** — correct for a private, app-only monorepo.
- **Per-package `vitest.config.ts` + `tsconfig.tests.json` boilerplate** — looks like 20
  copies of the same file, but per-package test tasks are what turbo caches and
  parallelizes, and the meta-test guarantees the copies cannot drift. A root Vitest
  `projects` config would _reduce files but break per-package caching_. Keep the shape
  (whatever the runner). This contradicts a naive reading of the Vitest monorepo guidance,
  deliberately: turbo is the orchestrator here, not Vitest.
- **Single root ESLint flat config + `eslint .` per package** — the right shape for a
  monorepo. But note: it composes `tseslint.configs.recommended` (**not**
  `recommendedTypeChecked` — verified: `eslint.config.js:29`, and no `projectService`/
  `parserOptions` anywhere), so **no type-aware lint rules run at all**. See P2 item 5a
  below and 03 §3.3.
- **Husky + commitlint** — lefthook et al. offer no advantage worth a migration here; hooks
  are 20 lines and CI re-enforces everything anyway.
- **`.spec.ts` (Playwright) vs `.test.ts` (unit) suffix split** — good, keep.
- **Root `scripts/` outside the workspace** — deliberate (01 §9.10); the parallel
  `check:scripts` lane is always-on in CI, so nothing escapes checking.
