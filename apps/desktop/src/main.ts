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
 * seams are pulled out.
 *
 * Stage 1 note: `apps/server` does not listen on a port yet (Epic 2.1 has
 * not landed) — spawning it will start a process that exits immediately, so
 * `spawnOrAttach` will correctly fail to observe health and throw. This file
 * is the mechanism; Track A's server landing an actual `/health` endpoint
 * and a listener is what makes it succeed end-to-end (Sync 2).
 */

import { spawn as spawnChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow } from "electron";

import { resolvePort } from "./config.js";
import { spawnOrAttach, createPollingWaiter } from "./spawn-or-attach.js";
import type { HealthProbe, SpawnedProcess } from "./spawn-or-attach.js";

/**
 * Same layout assumption as the rest of the monorepo (AGENTS.md): sibling
 * apps under `apps/`. `apps/server` is Track A's; this only assumes its
 * compiled entry point exists at the conventional `dist/index.js` path.
 */
const SERVER_ENTRY = fileURLToPath(
  new URL("../../server/dist/index.js", import.meta.url),
);

function healthProbe(port: number): HealthProbe {
  return async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      return response.ok;
    } catch {
      return false;
    }
  };
}

function spawnServer(port: number): SpawnedProcess {
  const child = spawnChildProcess(process.execPath, [SERVER_ENTRY], {
    stdio: "inherit",
    env: { ...process.env, PLOTROOM_PORT: String(port) },
  });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("failed to spawn the local server: no pid");
  }
  return {
    pid,
    kill: () => {
      child.kill();
    },
  };
}

async function main(): Promise<void> {
  const port = resolvePort();
  const probe = healthProbe(port);

  const handle = await spawnOrAttach({
    probe,
    spawn: () => spawnServer(port),
    waitUntilHealthy: createPollingWaiter(250),
  });

  app.on("window-all-closed", () => {
    // Shutdown kills only what this process spawned (§12); an attached
    // server belongs to whoever started it and outlives this window.
    handle.stop();
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => handle.stop());

  await app.whenReady();
  const window = new BrowserWindow({ width: 1280, height: 800 });
  // The one single-origin URL (§12) — same port the health probe just
  // confirmed is serving, never a second address.
  await window.loadURL(`http://127.0.0.1:${port}/`);
}

if (process.env.NODE_ENV !== "test") {
  void main();
}
