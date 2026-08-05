# 03 — Core recommendations (toolchain-agnostic)

These stand on their own: they improve the repo whether or not the Bun/Electrobun
migrations proceed, and none of them is wasted by those migrations (each row says how it
interacts). Ordered by recommended execution; sizes are relative.

## 3.1 Shared config as internal packages (replaces most of `globalDependencies`)

**What:** create internal config packages and have workspace packages depend on them:

```
packages/config/          (or tooling/ — pick one, stay consistent with existing layout: packages/)
  typescript-config/      @plotroom/typescript-config   base.json, tests.json
  eslint-config/          @plotroom/eslint-config       index.js (flat config array)
  vitest-config/          @plotroom/vitest-config       packageTests (until/unless bun test)
```

Each consumer's `tsconfig.json` does `"extends": "@plotroom/typescript-config/base.json"`;
each package gets a 2-line `eslint.config.js` re-exporting the shared array (flat config
resolves package-locally, so per-package files are the correct flat-config shape); vitest
configs already re-export a base — just move where it lives.

**Why:** shared config enters the package graph, so a change to it invalidates (and, for
`--affected`, **selects**) exactly the packages that depend on it — the precise behavior the
current `globalDependencies` block approximates globally, at the cost of busting every
task's cache for any shared-config edit. This is the pattern Turborepo's own docs and
examples recommend ([tools guide](https://turborepo.dev/docs/guides/tools),
[internal packages](https://turborepo.dev/docs/core-concepts/internal-packages)).

**Keep in `globalDependencies` / root inputs afterwards:** `.npmrc` (or `bunfig.toml`),
and anything genuinely global. `turbo.json` itself is always hashed. For root files that
only _some_ tasks read, prefer per-task `inputs` with `$TURBO_ROOT$` (verify the token
against installed turbo 2.10.8 before relying on it —
[configuring tasks](https://turborepo.dev/docs/crafting-your-repository/configuring-tasks)).

**Acceptance (this is the load-bearing part):** re-run the measurement documented in
`turbo.json:4-34` — edit a shared config, confirm `turbo ls --affected` selects every
consumer; edit a package-local file, confirm only that package is selected. The comment in
`turbo.json` must be rewritten to describe the new mechanism, and
`scripts/workspace-tooling.test.ts` should gain a rule that every package depends on the
config packages it extends.

**Interaction with migrations:** do this _before_ the Bun PM swap if convenient (it's
package-manager-neutral), or fold it into the same window; do not do it mid-swap.

## 3.2 Dependency hygiene

1. **Raise floors to match reality:** turbo `^2.10.8`, typescript `^5.9.3`, vitest per
   its resolution in 3.4 below. Manifest ranges should describe what is tested.
2. **Drop `resolution-mode=highest`** (pnpm default `lowest-direct` for direct deps) — or,
   if the team prefers living at latest, accept it consciously and add a scheduled
   lockfile-refresh routine so drift happens in reviewed PRs, not in whoever installs next.
   Moot after the Bun swap (Bun has its own resolution semantics; carry the same policy
   decision into `bunfig.toml`).
3. **Remove `drizzle-kit`** from `packages/db` (unused; embedded migrations are the
   documented architecture).
4. **Dedupe react** (19.2.7/19.2.8 dual resolution) — `pnpm dedupe`, or free with the
   lockfile regeneration in the Bun swap.
5. **Dead config deletions** per the table in `02-assessment.md` §2.4.

## 3.3 Linter modernization: oxlint primary, ESLint as a thin residual

**Operator direction: oxlint.** Type-aware linting is also still wanted (today the config
is `tseslint.configs.recommended` only — verified, `eslint.config.js:29` — so
`no-floating-promises` etc. never ran). The field research
([`07-alternatives.md`](07-alternatives.md) §7.4) confirms the direction: against Biome
and ESLint, oxlint wins on custom-rule + type-aware capability at native speed. (For the
record, xo — easily confused with oxlint — is an ESLint wrapper, not a faster linter;
§3.7.) The plan:

1. **Custom rules move into the shared config package** (§3.1) as a local ESLint-format
   plugin — turborepo's documented pattern
   ([eslint guide](https://turborepo.dev/docs/guides/tools/eslint)). Written once in
   ESLint-plugin format, they run under ESLint today and under oxlint's
   ESLint-v9-compatible JS-plugin host when that leaves alpha
   ([oxlint js-plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins.html)).
   Contents: the two architectural rules (toolkit encapsulation, renderer Node-import
   ban) + the workspace-convention rules from §3.8.
2. **`lint` = `oxlint --type-aware`**: 847 built-in rules, 50–100× native speed claims,
   and type-aware rules via tsgolint/typescript-go — 59 of 61 typescript-eslint
   type-aware rules incl. `no-floating-promises`
   ([type-aware docs](https://oxc.rs/docs/guide/usage/linter/type-aware.html),
   [1.0 announcement](https://oxc.rs/blog/2025-06-10-oxlint-stable.html)). Expect a wave
   of genuine findings in the async server/WS code; triage, never blanket-disable.
   **Verify item:** `--type-aware` against the Phase E single root tsconfig (the docs'
   monorepo `.d.ts` caveat reads as written for per-package configs; ours is the
   root-config case — prove it on this repo).
3. **A micro-ESLint pass carries the custom plugin + package.json rules** until oxlint's
   JS plugins are proven, then ESLint drops from the JS/TS path. Because this pass lints
   a tiny file set, ESLint's speed stops mattering — which also makes the ESLint 10 bump
   low-stakes (do it when convenient; `eslint-config-prettier` compat is the only check).
4. **Prettier stays** (Biome's formatter+Tailwind-sorting unification is the runner-up
   path, blocked by plugin expressiveness for the custom rules — 07 §7.4).

Sequencing: independent of the Bun phases (oxlint/Biome are native binaries; runtime is
irrelevant, which also answers "does it work with Bun" — yes, trivially). Land it in
Lane 0, but _after_ deciding §3.8 so the rules land in their final home once.

## 3.4 Vitest: do not stay on 2.x

Two acceptable resolutions; pick based on the Bun decision (04 §4.4):

- **If bun test is adopted:** skip the vitest upgrade entirely except for
  `vitest.scripts.config.ts` — and move `scripts/**` tests to bun test too, which removes
  vitest from the repo. (The release-script tests use plain assertions; verified no
  vitest-only APIs beyond the runner itself. `[INFERENCE]` — re-verify with a run.)
- **If vitest stays:** upgrade to 4.x now. Surface is small: per-package configs re-export
  one base object; no `workspace`/`projects` usage; three `vi.useFakeTimers()` sites.
  This also removes the transitive vite 5 from the tree.

Either way, keep the per-package test-task shape (turbo caching — 02 §2.5), and keep
`src/**/*.test.ts` vs `.spec.ts` semantics.

## 3.5 Remote cache (optional, do after the dust settles)

Adopt Vercel Remote Cache via OIDC (no long-lived secret) or a self-hosted turbo cache
server; keep the `actions/cache` fallback for forks. Value scales with the CI matrix — worth
revisiting when the shell packaging matrix lands (05 §5.C). Until then the current
per-job `.turbo` cache is adequate.
([turbo GHA guide](https://turborepo.dev/docs/guides/ci-vendors/github-actions))

## 3.6 Small quality-of-life items

- Commit `.vscode/settings.json` + `extensions.json` (format-on-save with the workspace
  prettier, ESLint flat-config flag, workspace TypeScript version) — the `.gitignore`
  allowlist already anticipates them.
- Unify the two root file-list definitions (`tsconfig.scripts.json` include vs
  `lint:scripts` args) next time either is touched.
- Consider `git config extensions.worktreeConfig`-based per-worktree excludes documented in
  CONTRIBUTING for reviewers who need scratch dirs (this review used
  `$GIT_COMMON_DIR/info/exclude`; a documented convention beats ad-hoc).

## 3.7 Alternatives considered — verdicts (so nobody re-litigates them silently)

| Idea                                                        | Verdict                                                                      | Why                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root Vitest `projects` config replacing per-package configs | **No**                                                                       | Breaks per-package turbo caching/parallelism; the boilerplate is meta-test-enforced and tiny (02 §2.5)                                                                                                                        |
| Config generator ("sync" script) for package manifests      | **No**                                                                       | The meta-test already enforces the template _and_ catches hand edits; a generator adds a write path without adding safety                                                                                                     |
| lefthook / other hook managers                              | **No**                                                                       | Husky surface is ~20 lines; CI re-enforces everything; churn without payoff                                                                                                                                                   |
| TypeScript 7 / native compiler as the checker               | **Yes — inside the TS restructure** (04 §4.1/§4.6, 07 §7.3)                  | TS 7 is stable and ~10× faster; adopting it in the same step that removes emit/references means one parity diff instead of two migrations. Superseded an earlier "defer" stance after the operator confirmed TS 7 is current. |
| Changesets for versioning                                   | **No**                                                                       | Single-version private product with a tested bespoke release script matching decision 0003; Changesets solves a publishing problem this repo doesn't have                                                                     |
| Nx / moon / turborepo replacement                           | **No**                                                                       | Turborepo is working, current (2.10.8 installed), and both migrations keep it (turbo supports Bun workspaces + bun.lock prune/affected — [prune docs](https://turborepo.dev/docs/reference/prune))                            |
| Root `--noEmit` whole-graph typecheck (drop references)     | **Yes — but only in the Bun end-state** (04 Phase E, decision table 07 §7.3) | Inside the _current_ Node-consumer world it would lose per-package caching for nothing; once packages stop emitting and TS 7 checks the graph in seconds, references stop earning their keep.                                 |
| xo as the linter                                            | **No**                                                                       | It is an ESLint wrapper ("uses ESLint underneath" — [README](https://github.com/xojs/xo)); same engine, opinions we'd override, zero speed win                                                                                |
| Biome as linter+formatter                                   | **Runner-up, no for now**                                                    | GritQL plugins too weak for the custom architectural rules; type-aware preliminary (~75% `noFloatingPromises` detection); revisit if oxlint's JS plugins stall and formatter unification becomes attractive (07 §7.4)         |
| oxlint as primary linter                                    | **Yes** (§3.3)                                                               | native speed, 847 rules, tsgolint type-aware (59/61 typescript-eslint rules); ESLint-compatible plugin path for the custom rules                                                                                              |

## 3.8 Workspace conventions as lint rules (retiring the meta-test)

Operator direction: enforce workspace conventions with lint rules in a shared package
instead of the bespoke `scripts/workspace-tooling.test.ts`. Analysis in
[`07-alternatives.md`](07-alternatives.md) §7.5; the plan:

1. **Most of the meta-test evaporates in Phase E** — build scripts, `tsconfig.tests.json`
   shapes, vitest-config identity, `@types/node`-per-manifest all stop existing. Do not
   port those checks; delete them with their subjects.
2. **The survivors are package.json-shaped** (naming, `private`, `test`/`lint` script
   shapes + sanctioned deviations, single-target `.ts` exports, no build script on
   library packages). They become custom rules over `package.json` via ESLint's official
   JSON language plugin (`@eslint/json` — supports custom rules;
   [repo](https://github.com/eslint/json)), with `eslint-plugin-package-json` for the
   generic manifest hygiene ([npm](https://www.npmjs.com/package/eslint-plugin-package-json)).
   They live in the same local plugin as the architectural rules (§3.3 item 1), inside
   the shared config package (§3.1) — one home for every workspace convention.
3. **Optionally add `sherif`** (zero-config monorepo manifest linter) for the fixed
   policies it covers (dep-version consistency etc.); it complements but cannot replace
   the custom rules.
4. **Honest residue:** cross-file/graph checks (workspace-glob membership, cross-package
   uniqueness) are not natural lint rules. Keep a ~50-line `bun test` in the config
   package for those — a successor, not a survivor, of the 320-line meta-test.
5. The enforcement-first discipline transfers intact: a convention change edits the rule
   first, then the packages (06 invariant 1 is reworded accordingly).

Sequence with §3.3 (same home, land together or back-to-back); the Phase E deletions in
item 1 mean the _final_ rule set should be written against the post-restructure template,
with the interim rule set covering only conventions that exist in both worlds.
