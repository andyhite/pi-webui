# 0006 — Playwright can drive an Electrobun window, over CDP, in CEF mode only

- **Status:** Accepted (spike result)
- **Date:** 2026-08-04
- **Issues:** #84 (the spike), #78 (the decision it gates, part (c))
- **Deciders:** none — this records a measurement, not a choice. #78(c)
  remains deferred; the revisit is a new decision with this as its evidence.
- **Verified against:** Electrobun 1.18.1 (npm `latest`), CEF
  `147.0.10+chromium-147.0.7727.118`, Playwright 1.62.1, Linux x64 under
  `Xvfb`. Every claim below is scoped to that; where a claim comes from
  reading Electrobun's source rather than from a run, it says so.

## The question

#78 decided (c) — Electrobun instead of Electron — is deferred past M1 and
priced as one change including the server's move to Bun. It left one gate
open, and said why it is a gate rather than a detail:

> Losing the canvas e2e suite is not an acceptable price for toolchain
> unification.

Playwright has first-class Electron support (`_electron.launch`). Nothing
equivalent is documented for Electrobun. The #78 investigation could not
test it — headless host, no display server — so the answer was scheduled on
faith. This record replaces the faith with a run.

## The answer

**Yes, in `bundleCEF` mode, over `chromium.connectOverCDP`.** The canvas
e2e suite would survive the shell swap.

The proof is `apps/web/e2e/electrobun-shell.spec.ts`, which is a real run
rather than a description of one: it builds a minimal Electrobun app,
points its single window at a real spawned `@plotroom/server`'s own served
page (single origin, spec §12), attaches Playwright over CDP, and asserts
against the canvas — a node it seeded through the API renders, carries its
title, sits inside a mounted xyflow pane, and responds to a wheel gesture
Playwright issues by changing the zoom level the canvas reports. The
renderer is unmodified: nothing about the UI is special-cased for the
shell, so "never fork the UI per target" holds.

That the engine driven is the _bundled CEF_ rests first on provenance: the
CDP port is parsed out of the `DevTools listening on …` banner the app's own
child process printed, so the endpoint is definitionally that window's. The
spec also compares the attached browser's version to the `cefVersion` the
bundle recorded, which corroborates it and would catch an attachment that
landed elsewhere — but it is not independent proof, since it would pass
silently if Playwright's bundled Chromium ever matched CEF's version.

The **canvas** assertions were shown to be load-bearing by two mutations,
each confirmed to fail: pointing the window at `about:blank`, and asserting
text the canvas does not contain. The engine-identity assertion was not
mutation-tested, and the paragraph above is why it does not need to be.

## What does not work, and what that costs

Three negative results matter more than the positive one, because each is a
constraint on any suite built on this.

**1. System webviews expose no CDP at all.** Measured here for **WebKitGTK**
only, which is the one this host can run: with the system webview no remote
endpoint is reachable. For WKWebView (macOS) and WebView2 (Windows) the
claim is read off Electrobun's source, not run — neither sets any remote
debugging surface, and WebKit's own Remote Inspector is not CDP in any case.
So the e2e answer is _conditional on `bundleCEF: true`_ — which is
independently what #78 already recommended ("ship the engine we test"). If
the shell were ever adopted in system-webview mode, this record does not
cover it and the gate would be lost; on the two platforms above, re-measure
before relying on the negative.

**2. The port is data, not a flag.** On Linux 1.18.1 the CEF path never
sets `CefSettings.remote_debugging_port`; the port arrives only as a
Chromium switch out of `build.<platform>.chromiumFlags`, which the CLI
writes into the bundle's `Resources/build.json`. Passing
`--remote-debugging-port=N` on the app binary's own command line does
nothing at all. Measured both ways: with the flag in `build.json`, CEF
prints its `DevTools listening on ws://…` banner; with the flag only on
argv, no endpoint ever opens. The mechanism, from the source rather than a
run, is that the Zig launcher spawns a fixed `{bun, Resources/main.js}`
child and drops its own argv, and Linux CEF reads its command line back out
of `/proc/self/cmdline`, which is the bun child's.

The consequence for a suite: **the CDP port is fixed at build time.** A
per-run port therefore means either a per-run build — what the spike does,
and a warm rebuild is about 0.7s, which is why it is affordable at all — or
editing `Resources/build.json` in the built bundle before launch, which was
also measured to work. There is no ephemeral-port-then-launch path.

**3. One instance per `app.identifier`.** CEF's singleton lock lives under
the cache path Electrobun derives from the app identifier
(`~/.cache/<identifier>/<channel>/CEF`). A second instance sharing an
identifier prints "Opening in existing browser session", `CefInitialize`
fails, and it exits. A `user-data-dir` Chromium switch does **not** avoid
this — Electrobun's own `root_cache_path` overrides it (measured: the
switch was present, the cache path was used anyway, the collision still
happened). Two bundles with _distinct_ identifiers do run concurrently
(also measured).

So a parallel Playwright suite is possible but not free: it needs one
bundle per worker, each with its own identifier and its own port. The spike
stays at `workers: 1` and puts the port **and the pid** in the identifier.
The port alone would not have been enough: `ephemeralPort()` binds port 0
and closes before the app binds it, so two concurrent invocations can be
handed the same free port. With both, no live instance can collide with
another. Each run removes its own profile directory on teardown and sweeps
any left by a run that crashed before it could.

## Other facts a future reader should not have to rediscover

- **Linux requires X11.** Measured only in that every run here is under
  `xvfb-run`; per the source, `initializeGTK()` forces `GDK_BACKEND=x11` and
  calls the aborting `gtk_init`, and CEF is given
  `--ozone-platform=x11 --use-x11`. There is no headless mode to fall back
  on, because CEF is embedded in-process rather than spawned as a browser.
  `xvfb-run` is the harness, not a convenience — and CI would need it. This,
  not Electrobun, is what blocked the #78 investigation.
- **Linux CEF defaults are already container-friendly**: `--no-sandbox`,
  `--disable-gpu`, `--disable-dev-shm-usage` are on by default. So is
  `--disable-web-security`, which changes page semantics under test. Setting
  the flag to `false` in `chromiumFlags` cancels it, and the spike does
  cancel it, so the run behind this record is evidence about the
  configuration a real suite would use rather than about a browser with the
  same-origin policy switched off. Confirmed by reading CEF's **own**
  effective command line over CDP (`chrome://version`), not by trusting the
  config: `--disable-web-security` absent, `--remote-debugging-port=<n>`
  present. That page is also how to check any future flag question.
- **`--remote-allow-origins=*` is not needed** with Playwright 1.62.1 and
  this CEF (tested with and without). It is the first thing to try if a
  future pair rejects the DevTools WebSocket upgrade.
- **Nothing is vendored.** The npm tarball is TypeScript only, with no
  postinstall; the CLI, core and CEF tarballs (~210MB, ~1.6GB extracted)
  are downloaded lazily at first build. A cold or network-restricted CI runner fails at
  build time, not install time.
- **Teardown must kill the process group.** `xvfb-run`, the launcher, the
  bun child and CEF's helpers are all one tree; killing the leader alone
  leaves CEF holding the display. The spike spawns `detached` and signals
  the group.

## Why this is not wired into any gate

Electrobun is deferred past M1 (#78), so the repository takes on no
dependency on it: the spike fetches the framework into a scratch directory
at run time, and lives on its own Playwright config
(`apps/web/e2e/playwright.electrobun.config.ts`) which the default gate
`testIgnore`s. Nothing in `pnpm verify`, turbo's `test` task, or
`pnpm --filter @plotroom/web e2e` touches it. It is run deliberately:

```sh
pnpm build && pnpm --filter @plotroom/web e2e:electrobun
```

The version is pinned in the harness on purpose. **From the beta line's
source, read rather than run**, 1.18.4-beta.19 already changes the
mechanism: it routes the flag through `CefSettings` after validation,
refuses to forward it as a raw switch, adds an
`ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT` runtime override, and turns the port
**off by default in packaged builds**. A green run on that line would
therefore be evidence about a different seam than the one described here —
and those four behaviours are the ones to re-check first, since nothing here
verified them.

When the post-M1 revisit happens, bump the pin and re-run; the spike is
there so that costs minutes rather than a day. Bumping the pin is enough on
its own: the harness reinstalls whenever the scratch directory holds a
different version, because a presence check would have let "bump and re-run"
go green while still measuring 1.18.1.

## What would have replaced the gate had the answer been no

Recorded because #84 asked for it, and because the answer could change if
the shell is ever wanted in system-webview mode: the fallback was to keep
the Playwright suite on the browser target only — the renderer is one web
app served by the local server, so the suite loses nothing about the
_canvas_ — and accept that the desktop shell itself is smoke-tested by
hand. That is a real loss of coverage over shell-specific behaviour (window
lifecycle, the server child process, deep links, the updater), not over the
canvas. It is not needed: CEF mode answers yes.
