// #317's native shell suite: drives the *real* Tauri debug binary
// (`../src-tauri/target/debug/plotroom-desktop[.exe]`, built by
// `bun run --filter=@plotroom/desktop e2e:build` — see this repo's own
// `.github/workflows/ci.yml`) over `@wdio/tauri-service`'s `embedded`
// driver provider — the same provider on every OS the packaging matrix
// covers, so this one config runs on Linux, macOS and Windows alike: no
// external `tauri-driver`, no WebKitWebDriver/Edge WebDriver install, and —
// the whole reason `embedded` was picked over `official` — real support on
// macOS, where neither of those external drivers exists at all
// (`tauri-plugin-wdio-webdriver`, registered only in debug builds; see
// `src-tauri/src/lib.rs`).
//
// Env vars this run's spawned server sidecar needs (a real workspace git
// repo, a fixed port, a scratch state dir) MUST be set on `process.env`
// *before* the service ever spawns the app binary — `Command::new(...)` in
// the Rust shell's own `sidecar.rs` inherits this process's environment.
// This file is imported twice per run (the CLI launcher process, which
// actually spawns the app, and the forked worker process that runs
// `native-shell.spec.mjs`) — `prepareEnv()`'s own header explains why its
// values are fixed rather than freshly randomized per import.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { killPortHolder, prepareEnv } from "./server-harness.mjs";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));
const exeSuffix = process.platform === "win32" ? ".exe" : "";
const appBinaryPath = join(
  desktopDir,
  "src-tauri",
  "target",
  "debug",
  `plotroom-desktop${exeSuffix}`,
);

const prepared = prepareEnv();
Object.assign(process.env, prepared.env);
// Consumed by `native-shell.spec.mjs` — the one place this run's
// port/baseUrl are computed, so the spec reads the exact same values this
// file just applied to `process.env`, rather than recomputing its own.
globalThis.__plotroomDesktopE2E__ = { ...prepared, appBinaryPath };

export const config = {
  runner: "local",
  specs: ["./native-shell.spec.mjs"],
  maxInstances: 1,
  services: [
    [
      "@wdio/tauri-service",
      {
        driverProvider: "embedded",
        appBinaryPath,
      },
    ],
  ],
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: appBinaryPath },
    },
  ],
  logLevel: "info",
  bail: 0,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 90_000,
  connectionRetryCount: 3,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 60_000 },
  // #351: the graceful `on_window_event` teardown path is not reliably
  // reachable via this embedded WebDriver provider on macOS -- this suite's
  // own safety net, so a leaked sidecar never survives into a later run.
  afterSession: async function () {
    const { promise, resolve } = Promise.withResolvers();
    setTimeout(resolve, 2_000);
    await promise;
    if (killPortHolder(prepared.port)) {
      console.warn(
        `[native-shell suite] reaped a sidecar still bound to port ${prepared.port} after session end -- see #351`,
      );
    }
  },
};
