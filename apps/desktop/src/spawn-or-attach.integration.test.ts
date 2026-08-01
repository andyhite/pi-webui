/**
 * Drives `spawnServer`/`healthProbe` (main.ts) against the real, built
 * server — no Electron window involved, since a headless CI/dev
 * environment may have no display to open one in. This is the fallback the
 * task calls for explicitly: verify the spawn/attach/probe logic in a test
 * when a real display is unavailable, rather than skip verifying it.
 *
 * Requires `apps/server` already built (`dist/index.js`); turbo's `test`
 * task depends on `^build`, and `@plotroom/server` is already a declared
 * dependency of this package, so `pnpm verify`/`turbo run test` always
 * builds it first.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPollingWaiter, spawnOrAttach } from "./spawn-or-attach.js";
import { healthProbe, spawnServer } from "./main.js";

let nextPort = 46_900;
function ephemeralPort(): number {
  nextPort += 1;
  return nextPort;
}

const stateDirs: string[] = [];
function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plotroom-desktop-test-"));
  stateDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (stateDirs.length > 0) {
    const dir = stateDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("spawnServer + healthProbe against the real built server", () => {
  it("spawns the real server and observes it become healthy", async () => {
    const port = ephemeralPort();
    const stateDir = tempStateDir();
    let unexpectedExitCode: number | null | undefined;

    const originalEnv = process.env.PLOTROOM_STATE_DIR;
    process.env.PLOTROOM_STATE_DIR = stateDir;
    try {
      const handle = await spawnOrAttach(
        {
          probe: healthProbe(port),
          spawn: () =>
            spawnServer(port, (code) => {
              unexpectedExitCode = code;
            }),
          waitUntilHealthy: createPollingWaiter(100),
        },
        15_000,
      );

      expect(handle.result.mode).toBe("spawned");

      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: { origin: `http://localhost:${port}` },
      });
      expect(response.ok).toBe(true);
      const body = (await response.json()) as { status: string };
      expect(body.status).toBe("ok");

      handle.stop();
      // Shutdown is an expected exit — the unexpected-exit callback must
      // not fire for a kill this process itself initiated.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(unexpectedExitCode).toBeUndefined();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.PLOTROOM_STATE_DIR;
      } else {
        process.env.PLOTROOM_STATE_DIR = originalEnv;
      }
    }
  }, 20_000);

  it("attaches without spawning a second process once one is already healthy", async () => {
    const port = ephemeralPort();
    const stateDir = tempStateDir();

    const originalEnv = process.env.PLOTROOM_STATE_DIR;
    process.env.PLOTROOM_STATE_DIR = stateDir;
    try {
      const first = await spawnOrAttach(
        {
          probe: healthProbe(port),
          spawn: () => spawnServer(port, () => {}),
          waitUntilHealthy: createPollingWaiter(100),
        },
        15_000,
      );
      expect(first.result.mode).toBe("spawned");

      let spawnCalledAgain = false;
      const second = await spawnOrAttach({
        probe: healthProbe(port),
        spawn: () => {
          spawnCalledAgain = true;
          return spawnServer(port, () => {});
        },
        waitUntilHealthy: createPollingWaiter(100),
      });

      expect(second.result).toEqual({ mode: "attached" });
      expect(spawnCalledAgain).toBe(false);

      first.stop();
      second.stop();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.PLOTROOM_STATE_DIR;
      } else {
        process.env.PLOTROOM_STATE_DIR = originalEnv;
      }
    }
  }, 20_000);
});
