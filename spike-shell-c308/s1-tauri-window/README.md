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

```sh
# 1. build apps/web and apps/server once (from the repo root)
pnpm --filter @plotroom/web build
pnpm --filter @plotroom/server build
mkdir -p apps/web/dist-spike-fixtures && cp -r apps/web/dist/* apps/web/dist-spike-fixtures/

# 2. this dir
cd spike-shell-c308/s1-tauri-window
npm install
source ~/.cargo/env   # cargo/tauri-driver on PATH
cargo build --manifest-path src-tauri/Cargo.toml   # debug build; minutes, not hours

# 3. start the real server this run's window will point at (separate shell/process manager)
node spike-server.mjs
# note the printed nodeId

# 4. start tauri-driver (separate shell/process manager), pointed at WebKitWebDriver
tauri-driver --port 4444 --native-driver /usr/bin/WebKitWebDriver

# 5. run the suite against a real X display (Xvfb is fine)
DISPLAY=:<n> SPIKE_NODE_ID=<nodeId from step 3> npx wdio run wdio.conf.mjs
```

Every long-lived process here (Xvfb, the spike server, tauri-driver, and the
wdio run itself) needs its own generous, explicit timeout - none of this is
fast enough for a tool's default timeout, and that mismatch (not the app
itself) is what crashed earlier attempts.

## Results (Linux, WebKitGTK 4.1; recorded on #308)

4 passing, 2 failing, ~113s wall clock for the whole `spike.spec.mjs` run:

- PASS - window opens, title contains "PlotRoom" (real served page, not a
  blank shell).
- PASS - the seeded canvas node renders through
  `[data-testid="canvas-node-<id>"]` with its real content.
- PASS - `.react-flow__pane` (the real xyflow canvas) mounts and is displayed.
- FAIL - WDIO pointer-gesture drag: node did not move >5px within the
  `performActions` gesture.
- FAIL - WDIO wheel-gesture zoom: `[data-testid="zoom-level"]` (a real,
  existing product test hook used throughout `apps/web/e2e`) never became
  displayed within 15s of the synthetic wheel scroll.
- PASS (S3) - one real `@wdio/tauri-service` assertion: window handle
  obtained, seeded node visible, `window.__TAURI__.core.invoke("greet", ...)`
  round-tripped to Rust and back with the expected string.

See the #308 comment for the full interpretation (this environment is
software-rendered Xvfb with no DRI3/GPU - `libEGL warning: DRI3 error: Could
not get DRI3 device` printed on every run but did not stop the page from
rendering or the IPC round trip from working) and why the two gesture
failures are recorded as an open risk rather than a kill.
