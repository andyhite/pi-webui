/**
 * The Electron main process (spec §12, Epic 3.0): spawn-or-attach to the
 * local server, then load the single origin URL — never a second origin,
 * never a hardcoded host (§12's single-origin rule applies here too: the
 * URL this window loads is built from the same `resolvePort` the dev proxy
 * and the health probe use, never a literal).
 *
 * The decision and orchestration logic lives in `spawn-or-attach.ts`,
 * unit-tested with a mocked probe/spawn; this file only wires it to real
 * Electron/Node primitives (`app`, `BrowserWindow`, `child_process`, `fetch`)
 * and is not itself unit-tested — there is nothing left to test once the
 * seams are pulled out (see `spawn-or-attach.integration.test.ts`, which
 * drives `spawnServer`/`healthProbe` against a real built server instead).
 *
 * Three things beyond spawn-or-attach itself, all required before this
 * mechanism counts as done:
 *
 *   - a single-instance lock, so a second launch does not spawn a second
 *     server for the same instance;
 *   - `spawnOrAttach`'s own re-probe-after-timeout (in spawn-or-attach.ts)
 *     covers a race between two *separate* instances/launches;
 *   - a child exit listener, so a server that crashes after this process
 *     already attached/spawned it successfully surfaces as a visible error
 *     rather than a window that silently stops responding.
 */

import { spawn as spawnChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { BrowserWindow, app } from "electron";

import { resolvePort } from "./config.js";
import { createPollingWaiter, spawnOrAttach } from "./spawn-or-attach.js";
import type { HealthProbe, SpawnedProcess } from "./spawn-or-attach.js";

/**
 * Same layout assumption as the rest of the monorepo (AGENTS.md): sibling
 * apps under `apps/`. `apps/server` is Track A's; this only assumes its
 * compiled entry point exists at the conventional `dist/index.js` path.
 */
const SERVER_ENTRY = fileURLToPath(
  new URL("../../server/dist/index.js", import.meta.url),
);

export function healthProbe(port: number): HealthProbe {
  return async () => {
    try {
      // The server's real health route (apps/server/src/routes/health.ts)
      // lives under /api, like everything else — never a bare /health.
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      return response.ok;
    } catch {
      return false;
    }
  };
}

export function spawnServer(
  port: number,
  onUnexpectedExit: (code: number | null) => void,
): SpawnedProcess {
  const child = spawnChildProcess(process.execPath, [SERVER_ENTRY], {
    stdio: "inherit",
    env: { ...process.env, PLOTROOM_PORT: String(port) },
  });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("failed to spawn the local server: no pid");
  }

  let expectedShutdown = false;
  child.on("exit", (code) => {
    if (!expectedShutdown) onUnexpectedExit(code);
  });

  return {
    pid,
    kill: () => {
      expectedShutdown = true;
      child.kill();
    },
  };
}

/** Shown in place of the app when the server we spawned crashes underneath it. */
function crashPage(code: number | null): string {
  const message = `the local server exited unexpectedly (code ${String(code)}). Restart PlotRoom to try again.`;
  return `data:text/html,${encodeURIComponent(`<pre>${message}</pre>`)}`;
}

async function main(): Promise<void> {
  // One server per instance: a second launch attaches to nothing new and
  // spawns nothing new — it just quits, leaving the first instance's
  // window as the one true window (spec §12's single-origin rule extends
  // to "one process talks to one server", not just "one origin").
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  const port = resolvePort();
  const probe = healthProbe(port);
  let window: BrowserWindow | null = null;

  const handle = await spawnOrAttach({
    probe,
    spawn: () =>
      spawnServer(port, (code) => {
        // The server we spawned crashed after we already confirmed it
        // healthy — surface it rather than leaving an unresponsive window.
        if (window) {
          void window.loadURL(crashPage(code));
        } else {
          app.quit();
        }
      }),
    waitUntilHealthy: createPollingWaiter(250),
  });

  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.on("window-all-closed", () => {
    // Shutdown kills only what this process spawned (§12); an attached
    // server belongs to whoever started it and outlives this window.
    handle.stop();
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => handle.stop());

  await app.whenReady();
  window = new BrowserWindow({ width: 1280, height: 800 });
  // The one single-origin URL (§12) — same port the health probe just
  // confirmed is serving, never a second address.
  await window.loadURL(`http://127.0.0.1:${port}/`);
}

if (process.env.NODE_ENV !== "test") {
  void main();
}
