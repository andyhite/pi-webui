# S1/S3 spike: Tauri window on Linux (#308)

Own throwaway dir, part of epic #304's shell-decision track (C: #308 -> #309).
Never touches `apps/desktop` production code.

## What this is

A minimal `create-tauri-app` (vanilla JS) scaffold whose window loads
PlotRoom's **real** served build (`apps/web`'s production `dist/`) against a
**real**, running `@plotroom/server`, seeded with one canvas node through the
same HTTP API surface `electrobun-shell.spec.ts` (0006's Electrobun spike)
used. It is driven over WebKitWebDriver/tauri-driver by
`@wdio/tauri-service`, per Tauri's documented WebDriver testing model
(https://v2.tauri.app/develop/tests/webdriver/).

- `spike-server.mjs` - spawns `apps/server/dist/index.js` under the system
  `node` (NOT this harness's own Bun runtime - see the file's own comment for
  why: a native N-API dependency the compiled server pulls in crashes
  immediately under Bun), seeds one node, and holds the process open on a
  fixed port (`127.0.0.1:47811`) that matches `src-tauri/tauri.conf.json`'s
  `build.devUrl`.
- `src-tauri/tauri.conf.json` - `devUrl` is what a **debug** `cargo build`
  binary actually loads (Tauri's debug-build convention); `frontendDist`
  (`apps/web/dist-spike-fixtures`, gitignored, regenerate with
  `pnpm --filter @plotroom/web build` copied to that path) only satisfies the
  config schema for a prospective release build and is not exercised here.
- `test/specs/spike.spec.mjs` - the real S1 exercise (window opens, canvas
  node renders, pane mounts, WDIO pointer-drag, WDIO wheel-zoom) and the real
  S3 assertion (window + seeded node + one Tauri IPC round trip).
- `test/specs/diag.spec.mjs` - a throwaway diagnostic spec used while getting
  the harness working; kept because it's still useful for a from-scratch
  re-run.

## How to reproduce

This directory is its own `create-tauri-app` scaffold with its own
`package.json`/`package-lock.json`, outside the pnpm workspace globs — it is
the one place in this repo where the root's pnpm-only rule does not apply,
because nothing here feeds `pnpm-lock.yaml` or turbo's graph.

```sh
# 1. build apps/web and apps/server once (from the repo root)
pnpm --filter @plotroom/web build
pnpm --filter @plotroom/server build
mkdir -p apps/web/dist-spike-fixtures && cp -r apps/web/dist/* apps/web/dist-spike-fixtures/

# 2. this dir: populate its own node_modules from its own lockfile, then build
cd spike-shell-c308/s1-tauri-window
# (this directory's own package manager, per its own package-lock.json above)
source ~/.cargo/env   # cargo/tauri-driver on PATH
cargo build --manifest-path src-tauri/Cargo.toml   # debug build; minutes, not hours

# 3. start the real server this run's window will point at (separate shell/process manager)
node spike-server.mjs
# note the printed nodeId

# 4. start tauri-driver (separate shell/process manager), pointed at WebKitWebDriver
tauri-driver --port 4444 --native-driver /usr/bin/WebKitWebDriver

# 5. run the S1/S3 suite (wdio.conf.mjs's default spec) against a real X
# display (Xvfb is fine) - invoke the locally installed binary directly,
# never a version-fetching wrapper
DISPLAY=:<n> SPIKE_NODE_ID=<nodeId from step 3> ./node_modules/.bin/wdio run wdio.conf.mjs
```

Every long-lived process here (Xvfb, the spike server, tauri-driver, and the
wdio run itself) needs its own generous, explicit timeout - none of this is
fast enough for a tool's default timeout, and that mismatch (not the app
itself) is what crashed earlier attempts.

## Results (Linux, WebKitGTK 4.1; recorded on #308)

6 passing, 0 failing, ~73-114s wall clock for the whole `spike.spec.mjs` run
(timing varies run to run; the wheel-zoom test loops real discrete wheel
ticks rather than assuming a fixed jump crosses a bucket boundary, so its
own duration varies):

- PASS - window opens, title contains "PlotRoom" (real served page, not a
  blank shell).
- PASS - the seeded canvas node renders through
  `[data-testid="canvas-node-<id>"]` with its real content.
- PASS - `.react-flow__pane` (the real xyflow canvas) mounts and is displayed.
- PASS - WDIO pointer-gesture drag: a 12-sample `performActions` pointer
  gesture (pointerDown, N interpolated pointerMoves, pointerUp) moves the
  seeded node's rendered position by more than 5px in both axes. A single
  coarse `pointerMove` after `pointerDown` is too abrupt for WebKitGTK's
  synthetic-input path to register as a drag-start - this is not a
  WebKitGTK rendering defect, it is this harness under-sampling the gesture.
- PASS - WDIO wheel-gesture zoom: loops real, discrete wheel ticks (checking
  `[data-testid="zoom-level"]`'s `textContent` - the same product test hook
  every real canvas e2e gate reads, and the same reason: the hook is
  intentionally `display: none`, so a _visibility_ assertion on it can never
  pass) zooming **out** until the bucket label changes. Zooming out rather
  than in matters here: a single seeded node's initial `fitView` often lands
  already at the most zoomed-in bucket (`detail`), so zooming in further has
  nowhere to go - zooming out is guaranteed room to move regardless of the
  canvas's starting bucket. WebKitGTK's async-wheel path committed a zoom
  change on every run.
- PASS (S3) - one real `@wdio/tauri-service` assertion: window handle
  obtained, seeded node visible, `window.__TAURI__.core.invoke("greet", ...)`
  round-tripped to Rust and back with the expected string.

An earlier revision of this spike recorded 4 passing / 2 failing here, and
attributed both failures to the Xvfb/no-GPU environment and "WDIO's known
WebKitGTK gesture quirks." That record was wrong on both counts, caught by
an independent QA re-run on #308: the drag failure was a single-sample
gesture too coarse to register, and the zoom failure was a _visibility_
assertion on a hook that is `display: none` by design (so it could never
pass, no scroll was ever involved) followed, once fixed, by a _direction_
bug (zooming further into an already-fully-zoomed-in canvas). Both are
harness bugs in this spike, not findings about WebKitGTK - see the #308
comment thread for the correction. The environment's one real caveat is
software rendering: `libEGL warning: DRI3 error: Could not get DRI3 device`
prints on every run (no GPU/DRI3 available here) but did not stop the page
from rendering, the gestures from registering, or the IPC round trip from
working.
