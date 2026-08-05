# 07 — Alternatives considered: shell, e2e strategy, typechecker, linter

Researched 2026-08-05 against primary sources. This file exists so the choices in 03/04/05
are decisions with recorded losers — and so the _constraints_ behind them are visible as
decisions too.

## 7.1 Desktop shell: the constraints are a choice, then the matrix

Two constraints have governed the shell question (decisions #78/0005/0006):

- **C1 — pinned engine:** the desktop ships the Chromium the suite tests ("ship the engine
  we test").
- **C2 — the canvas e2e suite attaches to the shell** over CDP (0006's measurement).

**The operator has put both on the table, and they are genuinely relaxable.** Two
observations support relaxing them:

1. _C1 was always softer than it looks._ In browser mode the operator uses whatever
   browser they have; nothing pins the renderer to one engine there `[INFERENCE — the
spec serves the renderer to "the browser"; no engine is pinned anywhere in
docs/product-spec.md]`. A desktop shell on system webviews widens the engine set the
   app must tolerate; it does not create the problem.
2. _C2 conflates two coverages._ What 0006 protected is **canvas behavior** coverage. That
   lives in the renderer and can be tested against the browser-served app across an
   engine **matrix**; what actually needs the shell is **shell behavior** (window
   lifecycle, server child/sidecar, updater, deep links, IPC) — a much smaller suite.
   0006 itself recorded browser-only e2e as the viable fallback, losing shell coverage,
   not canvas coverage. The dual-target split removes even that loss (§7.2).

**Relaxing C1+C2 is what makes Tauri viable.** The matrix, scored both ways:

|                           | Electron (status quo)     | Electrobun + bundleCEF                                                       | Electrobun native                | **Tauri v2**                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------- | ---------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine                    | Chromium, pinned          | Chromium (CEF), pinned                                                       | WKWebView / WebView2 / WebKitGTK | WKWebView / WebView2 / WebKitGTK; **no pinned-Chromium option** (CEF refused upstream — [#4591 via #14963](https://github.com/tauri-apps/tauri/issues/14963); verso archived — [repo](https://github.com/versotile-org/verso))                                                                                      |
| Shell e2e                 | Playwright `_electron`    | CDP, proven in-tree (0006)                                                   | none (no CDP)                    | WebDriver: `@wdio/tauri-service` drives **all three OSes** via an embedded WebDriver server, with `tauri.execute`, IPC command mocking, deep-link testing, Rust/frontend log capture ([service docs](https://webdriver.io/docs/desktop-testing/tauri), [tauri docs](https://v2.tauri.app/develop/tests/webdriver/)) |
| Canvas e2e                | via shell or browser      | via shell or browser                                                         | **browser matrix only** (§7.2)   | **browser matrix only** (§7.2)                                                                                                                                                                                                                                                                                      |
| Main process              | Node (Electron's)         | **Bun/TS**                                                                   | Bun/TS                           | **Rust** (thin here: spawn-or-attach + one window); server ships as a **sidecar** — a `bun build --compile` binary per target triple ([sidecar docs](https://v2.tauri.app/develop/sidecar/)); the compiled-Bun-binary shape is already proven in-tree by session-host                                               |
| Platforms                 | mac x64+arm64, win, linux | mac **arm64 only**, win x64, linux                                           | same                             | mac **x64+arm64** (10.15+), win 7+, linux ([prereqs](https://v2.tauri.app/start/prerequisites/))                                                                                                                                                                                                                    |
| Packaging/updater/signing | mature; feed undecided    | static-host bsdiff updater; mac signing yes, **win signing not in pipeline** | same                             | mature bundler; updater with **enforced signature verification**, static hosting ([updater](https://v2.tauri.app/plugin/updater/)); mac notarization + win signing supported                                                                                                                                        |
| Footprint                 | ~100–250MB class          | CEF-class                                                                    | small                            | **smallest**                                                                                                                                                                                                                                                                                                        |
| Governance                | huge ecosystem            | **single maintainer, no-support disclaimer, beta-tagged releases**           | same                             | Commons Conservancy programme, board, elections ([governance](https://v2.tauri.app/about/governance/)); active cadence (tauri 2.11.5, wry 0.56.0, Jul 2026 — [releases](https://v2.tauri.app/release/))                                                                                                             |

**Verdict, both postures:**

- **Constraints kept (C1+C2):** Electrobun+bundleCEF is the only non-Electron option;
  Electron is the retreat.
- **Constraints relaxed (operator's current lean):** **Tauri v2 is the front-runner.** It
  wins everything except the two relaxed constraints: governance, release discipline,
  signing (incl. Windows), signature-enforced updater, Intel-Mac coverage, footprint —
  precisely the risk axes where Electrobun is weakest. Electrobun-native mode is strictly
  dominated by Tauri (same engines, no test story, weaker project) and drops out.

**What Tauri costs, honestly:** (1) a thin Rust main process — `main.ts`'s ~150 lines of
spawn-or-attach logic get rewritten once, in Rust, against Tauri's shell/sidecar APIs with
capability permissions; (2) the canvas suite never attaches to the shell — coverage comes
from the §7.2 split; (3) **WebKitGTK is the real risk**, not rendering-identity in the
abstract: its rendering/input path (Skia + DMA-BUF GPU compositing since 2.46, async
wheel scrolling on a secondary thread — [release notes](https://webkitgtk.org/2024/09/17/webkitgtk2.46.0-released.html),
[graphics docs](https://docs.webkit.org/Ports/WebKitGTK%20and%20WPE%20WebKit/Graphics.html))
varies by distro version and GPU, and a wheel/drag-heavy xyflow canvas is exactly the
workload that finds such seams.

**Gates before a Tauri ADR** (each is hours-to-a-day, in the spirit of the 0006 spike):

1. **WebKitGTK canvas spike** — PlotRoom's served page in a Tauri window on Linux;
   exercise drag/wheel/zoom by hand and via WDIO pointer actions; also on WKWebView (mac).
   This is the go/no-go.
2. **Sidecar spike** — compiled Bun server + session-host binary staged via
   `bundle.externalBin`; spawn-or-attach semantics; process-tree teardown.
3. **WDIO native smoke proof** — one real assertion through `@wdio/tauri-service` on each
   OS (window opens, canvas node visible, one IPC round trip).

If gate 1 fails on WebKitGTK, the choices collapse back to pinned-Chromium shells
(Electrobun+CEF or Electron) — record the measurement either way.

## 7.2 E2E strategy: dual-target (browser engine matrix + thin native shell suite)

The operator's instinct matches what Tauri itself documents: test user flows in **web
mode** and shell/IPC concerns with the **native driver**
([tauri webdriver docs](https://v2.tauri.app/develop/tests/webdriver/) describe browser
mode with `invoke()` mocking + the native WDIO service; the service docs name the exact
engines it drives per OS — [wdio tauri service](https://webdriver.io/docs/desktop-testing/tauri)).

**Layer 1 — canvas suite, browser-served, engine matrix (Playwright projects):**
`chromium` + `webkit` + `firefox` against the same hermetic spawned-server harness the
suite uses today. Fidelity is a proxy, not identity — state it plainly:

| Shipped engine (native shell) | Test proxy                                                                  | Gap                                                                                                                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebView2 (Windows)            | Playwright `chromium` (or branded `msedge`)                                 | small — WebView2 is evergreen Chromium/Edge; version skew only ([browsers docs](https://playwright.dev/docs/browsers))                                                                                                                                     |
| WKWebView (macOS)             | Playwright `webkit` **on macOS runners**                                    | Playwright's WebKit is a patched WebKit-main build, "often before these updates are incorporated into Apple Safari"; docs say the closest-to-Safari experience is WebKit **on macOS** — Linux WebKit is not ([docs](https://playwright.dev/docs/browsers)) |
| WebKitGTK 4.1 (Linux)         | Playwright `webkit` (approximate) + **native WDIO smoke on real WebKitGTK** | largest gap: distro version spread, Skia/DMA-BUF/GPU compositing, async-scroll input path — engine lineage shared, platform port different                                                                                                                 |

**Layer 2 — shell suite, native driver, all three OSes:** small WDIO suite via
`@wdio/tauri-service` (or Playwright `_electron`/CDP if the shell ends up
Electron/Electrobun): window lifecycle, sidecar spawn/attach/teardown, updater dry-run,
deep links, one canvas-visible + one drag/wheel smoke per OS — the last item is what
closes the WebKitGTK gap Layer 1 cannot.

**What no browser matrix catches** (goes in the shell suite or manual smoke): native
file dialogs, clipboard permissions, OS drag-and-drop, IME, GPU-driver/compositing
variance, IPC/plugin commands, protocol/deep-link handling.

**CI cost control:** PRs run `chromium` only (today's behavior, `workers: 1` unchanged);
`webkit`/`firefox` projects run on main + nightly; native shell suite runs on the
packaging matrix (which exists anyway). Playwright WebKit on Linux needs
`playwright install --with-deps webkit`.

**Runner runtime:** unchanged verdict — the runner stays on Node. WDIO also requires Node
LTS ([requirements](https://webdriver.io/docs/gettingstarted)), so no shell choice makes
e2e "Bun-native"; the runner is a dev tool. Playwright-under-Bun status and triggers:
Bun 1.4.0 fixed the stdio blocker ([bun #4253](https://github.com/oven-sh/bun/issues/4253)),
Playwright merged a Bun exports condition with multi-worker instability named as the
remaining blocker ([PR #28875](https://github.com/microsoft/playwright/pull/28875)),
official support remains Node-only ([system requirements](https://playwright.dev/docs/intro)).
Re-evaluate when Playwright's docs list Bun. Puppeteer+`bun test`, WebdriverIO-as-primary,
and Cypress remain rejected for the canvas suite (framework rewrite for zero product
benefit; Cypress is the wrong model for external shells).

## 7.3 Typechecker shape (detail behind 04 §4.1/§4.6)

Context: private monorepo, nothing published, every consumer (Bun, Vite, editor) resolves
TS source. Declarations therefore have no consumer; the only job is _checking_.

| Option                                                                                                                                                      | Speed                                                                                                                                                                       | Editor                                                | Turbo caching                                                          | Verdict                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| (a) **Root single `--noEmit` check (src+tests+scripts), TS 7 native**                                                                                       | one graph, no duplicated upstream re-checks; TS 7 measured ~10× (Sentry 72.8s→6.8s, [TS 7 post](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-beta/)) | one project; go-to-def lands in source                | one root task; any TS change re-runs it — fine when the run is seconds | **Recommended**                                                                                     |
| (b) Per-package `tsc --noEmit`, no references                                                                                                               | parallelizable but each package re-checks its upstream's source (N× duplicated work)                                                                                        | same as (a)                                           | fine-grained                                                           | fallback if (a)'s runtime ever creeps past comfort                                                  |
| (c) Keep references + `emitDeclarationOnly` (or `tsc -b --noEmit`, supported since TS 5.0 — [#53979](https://github.com/microsoft/TypeScript/issues/53979)) | best incrementality once warm; declaration emit costs time; keeps `composite` machinery                                                                                     | `.d.ts` boundaries unless declaration maps everywhere | fine-grained but caches must carry d.ts/tsbuildinfo                    | only if the repo grows far beyond 12 packages; this is the _current_ world, kept only until Phase E |
| isolatedDeclarations + oxc/tsdown dts emit                                                                                                                  | fast d.ts without the checker                                                                                                                                               | —                                                     | —                                                                      | solves a publishing problem this repo doesn't have; not needed                                      |

Fallback discipline: TS 7 is stable; run one diagnostics diff against the pinned 5.9 `tsc`
on this codebase before it becomes the gate, then delete the old line (04 §4.6 step 4).

## 7.4 Linter: oxlint (operator direction) vs Biome vs ESLint — confirmed

Requirements to satisfy: (R1) fast; (R2) the two custom architectural rules (toolkit
internals unimportable incl. dynamic `import()`; Node globals/imports banned in
renderer-reachable files); (R3) type-aware rules (`no-floating-promises` class — currently
**absent**, see 02); (R4) workspace-convention rules on `package.json` files (replacing
the meta-test, §7.5 / 03 §3.8); (R5) works regardless of runtime (Bun repo).

|                         | ESLint 10 + typescript-eslint          | **oxlint (1.x)**                                                                                                                                                                                                                                                                                                                                                                                | Biome (2.x)                                                                                                                                         | xo                                                                                                                                |
| ----------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Speed                   | slow (JS; typed rules cost more)       | **50–100× claim; native** ([1.0 announcement](https://oxc.rs/blog/2025-06-10-oxlint-stable.html)); 847 built-in rules ([docs](https://oxc.rs/docs/guide/usage/linter))                                                                                                                                                                                                                          | native, fast                                                                                                                                        | **an ESLint wrapper — same engine, not faster** ("It uses ESLint underneath" — [xo README](https://github.com/xojs/xo)); rejected |
| Custom AST rules (R2)   | yes (today's config)                   | **JS plugins: ESLint-v9-compatible API** (visitors, selectors, scopes, fixes) — **alpha** ([js-plugins docs](https://oxc.rs/docs/guide/usage/linter/js-plugins.html))                                                                                                                                                                                                                           | GritQL plugins: snippet matching + reporting only in current iteration — too weak for R2 ([plugins docs](https://biomejs.dev/linter/plugins/))      | via ESLint                                                                                                                        |
| Type-aware (R3)         | yes (typescript-eslint)                | **yes — tsgolint (typescript-go): 59/61 typescript-eslint type-aware rules**, `--type-aware`, extra `oxlint-tsgolint` dep ([type-aware docs](https://oxc.rs/docs/guide/usage/linter/type-aware.html)). Caveat: docs say monorepos need dependent packages' `.d.ts` available and typeAware only in root config — **must be verified against the no-build/root-tsconfig end-state** (04 Phase E) | preliminary: `noFloatingPromises` ~75% of typescript-eslint's detection, no custom type-aware ([Biome v2 blog](https://biomejs.dev/blog/biome-v2/)) | via ESLint                                                                                                                        |
| package.json rules (R4) | **yes** — jsonc parsing + custom rules | JS plugins target JS/TS, not JSON cleanly                                                                                                                                                                                                                                                                                                                                                       | no                                                                                                                                                  | via ESLint                                                                                                                        |
| Formatter replacement   | no (Prettier stays)                    | no (Prettier stays)                                                                                                                                                                                                                                                                                                                                                                             | yes incl. Tailwind sorting (`useSortedClasses` — fidelity vs prettier-plugin-tailwindcss unverified)                                                | no                                                                                                                                |
| Monorepo config         | flat config, root or per-pkg           | nested configs; typeAware root-only                                                                                                                                                                                                                                                                                                                                                             | nested (`root:false`/`extends:"//"`)                                                                                                                | —                                                                                                                                 |

**Verdict: oxlint as the primary linter, ESLint kept as a thin residual, converging on
oxlint-only.** Concretely:

1. Write the custom rules **once, in ESLint-plugin format**, inside the shared config
   package (03 §3.1; turborepo's documented pattern —
   [eslint guide](https://turborepo.dev/docs/guides/tools/eslint)). That format runs under
   ESLint today **and** under oxlint's ESLint-compatible JS-plugin host — the alpha's
   whole design point.
2. `lint` = `oxlint` (built-in rules + `--type-aware` via tsgolint, replacing the
   typescript-eslint plan from 03 §3.3) — this also delivers R3 far cheaper than
   ESLint+typed-lint would have.
3. `lint:conventions` (or folded into `lint`) = ESLint running **only** the custom plugin:
   the two architectural rules + the package.json convention rules — a tiny file set,
   so ESLint's speed stops mattering.
4. When oxlint's JS plugins leave alpha and the two architectural rules are proven under
   it, drop ESLint from the JS/TS path entirely; package.json rules follow if/when oxlint
   lints JSON, else they stay in the micro-ESLint pass (or a 50-line `bun test` check —
   see §7.5).
5. Prettier stays (Biome's only unique win here is formatter unification; the Tailwind
   sorting fidelity is unverified and toolkit is one package — not worth the migration).
   Biome is the runner-up overall, blocked by R2 (plugin expressiveness) and weaker R3.

Two verify-items for the implementer: oxlint `--type-aware` against the Phase E single
root tsconfig (source-resolving, no `.d.ts` — the docs' monorepo caveat reads as
written-for-per-package-configs; ours is the root-config case they require anyway); and
the JS-plugin alpha actually hosting the two custom rules (if not yet, item 3 carries them
under ESLint — no schedule risk).

## 7.5 Replacing the workspace meta-test with lint rules

Operator direction: enforce workspace conventions with lint rules in a shared package
instead of `scripts/workspace-tooling.test.ts`. This mostly _falls out_ of the migration:

- **Most of the meta-test's subject matter is deleted by Phase E**, not migrated: no
  build scripts, no `tsconfig.tests.json`, no vitest configs (and their same-object
  identity check), no `@types/node`-per-manifest mapping (one root tsconfig owns types),
  no exports-triple shape.
- **What remains is package.json-shaped** — naming (`@plotroom/*`), `private: true`,
  `test: bun test src` (+ sanctioned timeout deviations), lint script shape,
  single-target `.ts` exports, no build script on library packages. All expressible as
  custom ESLint rules over `package.json` — ESLint's official JSON language plugin
  (`@eslint/json`) explicitly supports custom rules
  ([repo](https://github.com/eslint/json)), and `eslint-plugin-package-json`
  (jsonc-parser based) covers the generic manifest rules out of the box
  ([npm](https://www.npmjs.com/package/eslint-plugin-package-json)) — all living in the
  same shared plugin as the architectural rules (§7.4 item 1). Fixed-policy tools (sherif,
  manypkg,
  syncpack) enforce generic consistency (dep-version mismatches, workspace protocol) and
  can complement, but none support the repo's _custom_ script-shape rules — the custom
  plugin is the load-bearing piece.
- **Honest residue:** checks that are cross-file or graph-shaped — "every directory the
  workspace glob matches is a well-formed member", uniqueness across the workspace,
  anything comparing two files — are not natural lint rules (a lint rule sees one file).
  Keep those as a _small_ `bun test` in the config package (a ~50-line successor, not the
  320-line meta-test), or accept sherif's fixed versions of them. The enforcement-first
  discipline (06 invariant 1) transfers to the lint plugin: each convention change edits
  the rule first, then the packages.
