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
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPollingWaiter, spawnOrAttach } from "./spawn-or-attach.js";
import type { SpawnOrAttachHandle } from "./spawn-or-attach.js";
import { healthProbe, spawnServer } from "./main.js";

/**
 * A port the OS says is free, never one a counter guessed. A static band is the
 * worse of the two failures available here: 46_900 is inside Linux's own
 * ephemeral range (32768–60999), so any port-0 bind anywhere on the machine can
 * already hold it — including `apps/server`'s suites, which `turbo run test` runs
 * at the same time as this one. The probe closes before the child binds, which is
 * a window; a counter is not a window, it is a standing collision.
 */
function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() =>
          reject(new Error("could not determine an ephemeral port")),
        );
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
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
    const port = await ephemeralPort();
    const stateDir = tempStateDir();
    let unexpectedExitCode: number | null | undefined;
    // Declared outside the try so `finally` can always stop it — an
    // assertion failing partway through must never leak the spawned
    // server process.
    let handle: SpawnOrAttachHandle | undefined;

    const originalEnv = process.env.PLOTROOM_STATE_DIR;
    process.env.PLOTROOM_STATE_DIR = stateDir;
    try {
      handle = await spawnOrAttach(
        {
          port,
          probeFor: healthProbe,
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
      handle?.stop();
      if (originalEnv === undefined) {
        delete process.env.PLOTROOM_STATE_DIR;
      } else {
        process.env.PLOTROOM_STATE_DIR = originalEnv;
      }
    }
  }, 20_000);

  it("attaches without spawning a second process once one is already healthy", async () => {
    const port = await ephemeralPort();
    const stateDir = tempStateDir();
    // Declared outside the try so `finally` can always stop whichever of
    // these got assigned before an assertion failed.
    let first: SpawnOrAttachHandle | undefined;
    let second: SpawnOrAttachHandle | undefined;

    const originalEnv = process.env.PLOTROOM_STATE_DIR;
    process.env.PLOTROOM_STATE_DIR = stateDir;
    try {
      first = await spawnOrAttach(
        {
          port,
          probeFor: healthProbe,
          spawn: () => spawnServer(port, () => {}),
          waitUntilHealthy: createPollingWaiter(100),
        },
        15_000,
      );
      expect(first.result.mode).toBe("spawned");

      let spawnCalledAgain = false;
      second = await spawnOrAttach({
        port,
        probeFor: healthProbe,
        spawn: () => {
          spawnCalledAgain = true;
          return spawnServer(port, () => {});
        },
        waitUntilHealthy: createPollingWaiter(100),
      });

      expect(second.result).toEqual({ mode: "attached", port });
      expect(spawnCalledAgain).toBe(false);
    } finally {
      first?.stop();
      second?.stop();
      if (originalEnv === undefined) {
        delete process.env.PLOTROOM_STATE_DIR;
      } else {
        process.env.PLOTROOM_STATE_DIR = originalEnv;
      }
    }
  }, 20_000);

  it("reports the port it actually bound when a stored override moves it, rather than the one it was asked for (#87, #88)", async () => {
    const askedPort = await ephemeralPort();
    const storedPort = await ephemeralPort();
    const stateDir = tempStateDir();
    let handle: SpawnOrAttachHandle | undefined;

    const originalEnv = process.env.PLOTROOM_STATE_DIR;
    process.env.PLOTROOM_STATE_DIR = stateDir;
    try {
      handle = await spawnOrAttach(
        {
          port: askedPort,
          probeFor: healthProbe,
          spawn: () => spawnServer(askedPort, () => {}),
          waitUntilHealthy: createPollingWaiter(100),
        },
        15_000,
      );
      expect(handle.result).toEqual({
        mode: "spawned",
        pid: expect.any(Number),
        port: askedPort,
      });
      const firstBoundPort =
        handle.result.mode === "spawned" ? handle.result.port : askedPort;

      const write = await fetch(
        `http://127.0.0.1:${firstBoundPort}/api/settings/port`,
        {
          method: "PUT",
          headers: {
            origin: `http://localhost:${firstBoundPort}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ value: storedPort }),
        },
      );
      expect(write.status).toBe(200);
      handle.stop();
      // Let the kill actually land before spawning a second real process on
      // the same `askedPort` — a still-shutting-down first process holding
      // it would make the second boot's own bind race rather than exercise
      // the override.
      await new Promise((resolve) => setTimeout(resolve, 300));
      handle = undefined;

      // Asked for `askedPort` again (free, since the first process released
      // it) — the stored override should win at boot, and this call must
      // learn the real port from the child's own report rather than
      // assuming the one it asked for.
      handle = await spawnOrAttach(
        {
          port: askedPort,
          probeFor: healthProbe,
          spawn: () => spawnServer(askedPort, () => {}),
          waitUntilHealthy: createPollingWaiter(100),
        },
        15_000,
      );

      expect(handle.result).toEqual({
        mode: "spawned",
        pid: expect.any(Number),
        port: storedPort,
      });

      const response = await fetch(
        `http://127.0.0.1:${storedPort}/api/health`,
        {
          headers: { origin: `http://localhost:${storedPort}` },
        },
      );
      expect(response.ok).toBe(true);

      // Nothing is listening on the port this call asked for — the second
      // process bound the stored override instead, not both.
      await expect(
        fetch(`http://127.0.0.1:${askedPort}/api/health`, {
          headers: { origin: `http://localhost:${askedPort}` },
        }),
      ).rejects.toBeDefined();
    } finally {
      handle?.stop();
      if (originalEnv === undefined) {
        delete process.env.PLOTROOM_STATE_DIR;
      } else {
        process.env.PLOTROOM_STATE_DIR = originalEnv;
      }
    }
  }, 30_000);
});
