# 05 — The desktop shell migration (Electrobun or Tauri, replacing Electron)

The shell choice is now **open between two candidates**, decided by a constraint call the
operator makes plus three cheap spikes — not by this report fiat. The full scoring is
[`07-alternatives.md`](07-alternatives.md) §7.1; this file is the decision procedure and
the migration plan for each outcome. Either way, Electron, electron-builder,
electron-updater, and the pnpm-deploy staging machinery are deleted.

Shared prerequisites (either plan): Bun phases A–D landed (04) — the packaged shell needs
the server on Bun + bun:sqlite; 0005 priced shell+server as one change and that pricing
stands in both directions.

## 5.0 The decision procedure

**The constraint call (operator, recorded in the ADR):** keep or relax
"pinned Chromium + e2e attaches to the shell" (C1+C2, 07 §7.1).

- **Kept → Plan A (Electrobun + bundleCEF).** The only non-Electron shell satisfying both.
- **Relaxed → Plan B (Tauri v2) is the front-runner**, contingent on the spikes below.
  Rationale: under relaxed constraints Tauri wins governance, release discipline, signing
  (incl. Windows), signature-enforced updater, Intel-Mac coverage, and footprint — exactly
  the axes where Electrobun is weakest — and the canvas e2e question is answered by the
  dual-target strategy (07 §7.2): browser engine matrix for the canvas, thin native WDIO
  suite for the shell. This is Tauri's own documented testing model
  ([webdriver docs](https://v2.tauri.app/develop/tests/webdriver/)).

**The spikes (each hours-to-a-day, in the 0006 spirit — run before the ADR):**

| #   | Spike                                                                                                                                                                                                       | Answers                                                                                                                                                                                                    | Kill condition                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| S1  | PlotRoom's served page in a Tauri window on Linux (WebKitGTK 4.1) and macOS (WKWebView); drag/wheel/zoom by hand + via WDIO pointer actions                                                                 | Is the xyflow canvas acceptable on system webviews? (WebKitGTK's Skia/DMA-BUF/async-scroll path is the risk — [graphics docs](https://docs.webkit.org/Ports/WebKitGTK%20and%20WPE%20WebKit/Graphics.html)) | canvas jank/breakage on WebKitGTK → Plan A                    |
| S2  | Compiled Bun server + session-host binary as Tauri sidecars (`bundle.externalBin`, per-target-triple names); spawn-or-attach; process-tree teardown ([sidecar docs](https://v2.tauri.app/develop/sidecar/)) | Does the process model survive?                                                                                                                                                                            | sidecar lifecycle unable to express attach semantics → Plan A |
| S3  | One real `@wdio/tauri-service` assertion per OS (window opens, seeded canvas node visible, one IPC round trip)                                                                                              | Is the native shell suite real on all three OSes? ([service docs](https://webdriver.io/docs/desktop-testing/tauri))                                                                                        | macOS embedded-driver path broken → Plan A                    |

If Plan B survives the spikes, record the constraint relaxation + spike measurements in
the ADR (supersedes the _decision_ posture of 0005(c)/#78; 0006 stays true as a
measurement). If any spike kills it, Plan A proceeds with the same ADR recording why.

---

## 5.A Plan A — Electrobun + bundleCEF (constraints kept)

### 5.A.1 Ecosystem reality check (researched 2026-08-05, primary sources)

| Fact                                                                                                                                                                                                                                                                                                                                                               | Consequence                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Latest release is `v1.18.4-beta.19`; the main-branch docs describe a "v2.x" toolchain (Hutch CLI, Cottontail runtime) that does not match the release feed ([releases](https://github.com/blackboardsh/electrobun/releases.atom), [v2 changelog](https://github.com/blackboardsh/electrobun/blob/main/docs/src/content/docs/electrobun/guides/changelog/v2-x.mdx)) | **Pin an exact version and read that version's docs, not main.** 0006 pinned 1.18.1 and documented that the beta line already changed the CDP-port mechanism (routed through CefSettings, off by default in packaged builds, `ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT` override). Re-run the spike on the adopted pin — 0006 designed for exactly this ("bump the pin and re-run; costs minutes"). |
| Maintainer explicitly disclaims review/response/merge expectations ([contributing](https://github.com/blackboardsh/electrobun#contributing)); MIT; ~12.6k stars                                                                                                                                                                                                    | Bus-factor risk is real. Mitigation: pin hard, vendor knowledge in ADRs (the repo already does), keep the recorded retreat: Electron first (constraints intact), Tauri if constraints are renegotiated.                                                                                                                                                                                         |
| Platform targets: macOS **arm64 only** (no x64 core), Windows x64 (ARM via emulation), Linux x64+arm64 ([compatibility](https://github.com/blackboardsh/electrobun/blob/main/docs/src/content/docs/electrobun/guides/compatability.mdx))                                                                                                                           | **Intel-Mac support is dropped.** Surface to the operator in the ADR; it is a product decision. (Plan B keeps Intel Macs.)                                                                                                                                                                                                                                                                      |
| Builds are host-native only; no cross-compilation; native CI runners required (same doc)                                                                                                                                                                                                                                                                           | Extend the `session-host-binary` matrix pattern to packaging jobs; macos runner must be arm64.                                                                                                                                                                                                                                                                                                  |
| Linux needs GTK3 / WebKitGTK 4.1 / Ayatana AppIndicator / librsvg at runtime **even with CEF bundled** (same doc)                                                                                                                                                                                                                                                  | AppImage self-containment regresses vs Electron. Declare deb dependencies; document AppImage host requirements; verify on a clean container.                                                                                                                                                                                                                                                    |
| `bundleCEF: true` ships pinned Chromium (CEF `147.0.10+chromium-147.0.7727.118` at the 0006 pin)                                                                                                                                                                                                                                                                   | "Ship the engine we test"; keeps Playwright CDP coverage per 0006. Cost: ~210MB framework download at build, big bundles.                                                                                                                                                                                                                                                                       |
| Updater: patch-then-full, **static file hosting** ([updater](https://github.com/blackboardsh/electrobun/blob/main/docs/src/content/docs/electrobun/apis/updater.mdx))                                                                                                                                                                                              | Replaces electron-updater; feed decision becomes "pick a static host".                                                                                                                                                                                                                                                                                                                          |
| Code signing: macOS sign/notarize/staple supported; **Windows signing not in the pipeline** ([code-signing](https://github.com/blackboardsh/electrobun/blob/main/docs/src/content/docs/electrobun/guides/code-signing.mdx))                                                                                                                                        | External signtool step in the packaging job when Windows distribution matters.                                                                                                                                                                                                                                                                                                                  |
| Deep links: no documented API found                                                                                                                                                                                                                                                                                                                                | Repo uses none today (0005: "twelve APIs, no `protocol`") — non-blocking; note as unverified gap.                                                                                                                                                                                                                                                                                               |
| One live instance per `app.identifier`; CEF singleton lock (0006 measured)                                                                                                                                                                                                                                                                                         | Per-run identifiers for e2e; explicit single-instance behavior for the packaged app.                                                                                                                                                                                                                                                                                                            |
| Linux CEF requires X11, no headless; CI needs `xvfb-run` (0006)                                                                                                                                                                                                                                                                                                    | Desktop e2e job runs under xvfb; the spike harness already encodes this.                                                                                                                                                                                                                                                                                                                        |

### 5.A.2 What replaces what

| Today (Electron)                                                                            | Plan A (Electrobun)                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Electron main: spawn server via `process.execPath` + `ELECTRON_RUN_AS_NODE`                 | Bun main process: run the server **in-process** (import `@plotroom/server`'s app; native core owns the GUI thread, so server work doesn't block UI) or spawn a `bun` child. Recommend in-process first; keep spawn-or-**attach** semantics. `[INFERENCE — in-process serving needs a spike commit before the ADR]` |
| `BrowserWindow` → `http://localhost:PORT`                                                   | `new BrowserWindow({ url, renderer: "cef", … })` — same single-origin model, unchanged renderer (0006 proved zero renderer changes)                                                                                                                                                                                |
| electron-builder + stage-resources (`pnpm deploy`, symlink staging, `extraResources` split) | Electrobun CLI build bundling web `dist` + compiled session-host binary + its `pi_natives` addons. **The staging apparatus is deleted** — bun:sqlite + in-process server leave no `node_modules` to stage.                                                                                                         |
| electron-updater (`publish: null`)                                                          | Electrobun Updater + static hosting; version injected from root package.json (decision 0003 unchanged)                                                                                                                                                                                                             |

### 5.A.3 The desktop e2e gate (promotion of the spike)

`playwright.electrobun.config.ts` stops being a spike and becomes the desktop gate in CI
(xvfb + CEF cache keyed on the pin), alongside the browser canvas gate. Constraints from
0006 carried into the real suite: build-time CDP port (per-run bundle build ~0.7s warm, or
the beta line's env override), identifier = name+port+pid, `workers: 1`, stale-profile
sweep. The canvas engine matrix (07 §7.2 Layer 1) is worth adopting under Plan A too — it
hardens browser mode, which ships regardless of shell.

### 5.A.4 Risk register

| Risk                                            | Severity     | Mitigation                                                                                                   |
| ----------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| Upstream instability / bus factor               | High         | Hard pin; ADR knowledge capture; recorded retreat order (Electron, then Tauri-with-renegotiated-constraints) |
| v1.18-beta ↔ v2 docs mismatch                   | Medium       | Read docs at the pinned tag; the spike re-run is the arbiter                                                 |
| In-process server surprises                     | Medium       | Spike before ADR; child-process fallback documented                                                          |
| Intel-Mac drop                                  | Product call | Operator sign-off in ADR                                                                                     |
| Linux runtime deps regress AppImage portability | Medium       | deb dependency metadata; clean-container verification                                                        |
| Windows signing gap                             | Low today    | External signing step when needed                                                                            |

---

## 5.B Plan B — Tauri v2 (constraints relaxed; front-runner if spikes pass)

### 5.B.1 Architecture

| Concern          | Plan B shape                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Main process     | Thin Rust: window creation, spawn-or-attach, sidecar lifecycle, single-instance, updater wiring. The only Rust in the repo; scope it deliberately (~the size of today's `main.ts`). Everything with product logic stays TS.                                                                                                                      |
| Server           | `bun build --compile` binary (same pipeline as session-host's `compile`) shipped via `bundle.externalBin` with per-target-triple names; spawned with capability-gated shell permissions ([sidecar docs](https://v2.tauri.app/develop/sidecar/)). Attach mode = don't spawn, connect to existing/remote — logic ported from `spawn-or-attach.ts`. |
| Session host     | Unchanged: the compiled binary + `pi_natives` addons ship as additional sidecar/resource files; the server spawns it exactly as today.                                                                                                                                                                                                           |
| Renderer         | Unchanged web app at `http://localhost:PORT` (single origin, spec §12) in the Tauri window; **no Tauri JS APIs in the renderer** — keep the renderer shell-agnostic so browser mode stays identical ("never fork the UI per target" is preserved by _not using_ the webview bridge for product features).                                        |
| Webviews         | System engines: WebView2 / WKWebView / WebKitGTK 4.1. Engine variance is accepted **and tested** (07 §7.2).                                                                                                                                                                                                                                      |
| Updater          | tauri-plugin-updater: signature-enforced, static JSON + artifacts ([updater](https://v2.tauri.app/plugin/updater/)); solves the "feed undecided" question with the strongest of the three models.                                                                                                                                                |
| Packaging        | tauri bundler: dmg (x64+arm64), NSIS/MSI, AppImage/deb; mac notarization and Windows signing supported in-pipeline; native CI runners per target (matrix already exists for session-host).                                                                                                                                                       |
| Frontend tooling | Unchanged Bun/Vite; `tauri` CLI runs fine from bun scripts (it's a native binary orchestrated via npm package).                                                                                                                                                                                                                                  |

### 5.B.2 E2E under Plan B (the dual-target split, 07 §7.2)

- **Canvas:** Playwright browser matrix (`chromium` per-PR; + `webkit`, `firefox` on
  main/nightly) against the hermetic spawned-server harness — the existing suite, re-used
  as-is, gaining engine coverage it never had.
- **Shell:** small WDIO suite via `@wdio/tauri-service` on the packaging matrix: window
  lifecycle, sidecar spawn/attach/teardown, updater dry-run, one canvas-visible + one
  drag/wheel smoke per OS (the smoke is what closes the WebKitGTK gap the matrix can't).
- The Electrobun spike harness + `e2e:electrobun` config retire (superseded by the S1–S3
  spike results recorded in the ADR).

### 5.B.3 Risk register

| Risk                                                                  | Severity                 | Mitigation                                                                                                                  |
| --------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| WebKitGTK canvas behavior (rendering/input path varies by distro/GPU) | **High until S1 passes** | S1 is the go/no-go; the per-OS native smoke keeps watching it after adoption                                                |
| Rust in the repo (new language surface)                               | Medium                   | Confine to the shell crate; review rule: no product logic in Rust; document build prereqs in CONTRIBUTING (own docs change) |
| Engine variance bugs post-ship (dialogs, clipboard, IME, GPU)         | Medium                   | 07 §7.2's "matrix can't catch" list lives in the shell suite + release smoke checklist                                      |
| Suite split adds a second test framework (WDIO)                       | Low-Medium               | Shell suite stays deliberately tiny; canvas stays Playwright                                                                |
| WebView2/WKWebView evergreen drift                                    | Low                      | engines update with the OS — also the upside (security patches without releases)                                            |

---

## 5.C Common to both plans

- **What gets deleted:** `electron`, `electron-builder`, `electron-updater`,
  `electron-builder.yml` (with its annotated `extraResources` split),
  `scripts/stage-resources.mjs`, `scripts/package.mjs`, `scripts/copy-static-assets.mjs`
  (backend-picker assets move into the new bundle pipeline), the `ELECTRON_RUN_AS_NODE`
  spawn path, `apps/desktop/dist-installers/` ignore entry, Electron's
  `trustedDependencies` entry from Phase A. `deployment.md` rewrite is its own docs change.
- **CI:** packaging job on the native matrix (reuse/merge with `session-host-binary`);
  desktop test job (xvfb for Plan A CEF; WDIO service for Plan B); `install.yml` retires
  into the bun:sqlite FTS5 platform round trip (04 §4.3); remote cache (03 §3.5) becomes
  worth adopting once this matrix lands.
- **ADR contents:** the constraint call and its reasoning; spike measurements (S1–S3 or
  the Electrobun pin re-spike); update-hosting choice; signing posture; platform coverage
  (Intel-Mac kept or dropped); packaged-release pause window (06); e2e-runner
  re-evaluation trigger (07 §7.2).
