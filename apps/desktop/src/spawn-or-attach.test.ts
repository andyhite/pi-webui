import { describe, expect, it, vi } from "vitest";

import {
  ServerNeverBecameHealthyError,
  createPollingWaiter,
  spawnOrAttach,
} from "./spawn-or-attach.js";
import type { HealthWaiter, SpawnedProcess } from "./spawn-or-attach.js";

function fakeProcess(pid: number): SpawnedProcess & { killed: boolean } {
  const proc = {
    pid,
    killed: false,
    kill() {
      proc.killed = true;
    },
  };
  return proc;
}

describe("spawnOrAttach", () => {
  it("attaches without spawning when a server is already listening", async () => {
    const spawn = vi.fn();
    const waitUntilHealthy: HealthWaiter = vi.fn();

    const handle = await spawnOrAttach({
      probe: async () => true,
      spawn,
      waitUntilHealthy,
    });

    expect(handle.result).toEqual({ mode: "attached" });
    expect(spawn).not.toHaveBeenCalled();
    expect(waitUntilHealthy).not.toHaveBeenCalled();
  });

  it("attaching never kills anything on stop — it never spawned anything", async () => {
    const child = fakeProcess(1);
    const handle = await spawnOrAttach({
      probe: async () => true,
      spawn: () => child,
      waitUntilHealthy: async () => true,
    });
    handle.stop();
    expect(child.killed).toBe(false);
  });

  it("spawns and waits for readiness when nothing is listening yet", async () => {
    const child = fakeProcess(42);
    let probeCalls = 0;
    const probe = async () => {
      probeCalls += 1;
      return probeCalls > 1; // unhealthy on the first (pre-spawn) probe
    };

    const handle = await spawnOrAttach({
      probe,
      spawn: () => child,
      waitUntilHealthy: async (p) => p(),
    });

    expect(handle.result).toEqual({ mode: "spawned", pid: 42 });
  });

  it("kills the spawned process when it never becomes healthy in time", async () => {
    const child = fakeProcess(7);

    await expect(
      spawnOrAttach(
        {
          probe: async () => false,
          spawn: () => child,
          waitUntilHealthy: async () => false,
        },
        5_000,
      ),
    ).rejects.toBeInstanceOf(ServerNeverBecameHealthyError);

    expect(child.killed).toBe(true);
  });

  it("stop() kills only the process this call spawned", async () => {
    const child = fakeProcess(9);
    const handle = await spawnOrAttach({
      probe: async () => false,
      spawn: () => child,
      waitUntilHealthy: async () => true,
    });
    expect(handle.result).toEqual({ mode: "spawned", pid: 9 });
    handle.stop();
    expect(child.killed).toBe(true);
  });
});

describe("createPollingWaiter", () => {
  it("returns true as soon as the probe reports healthy", async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    let probeCalls = 0;
    const probe = async () => {
      probeCalls += 1;
      return probeCalls === 3;
    };

    const wait = createPollingWaiter(100, () => now, sleep);
    const healthy = await wait(probe, 10_000);

    expect(healthy).toBe(true);
    expect(probeCalls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up once the deadline passes without ever becoming healthy", async () => {
    let now = 0;
    const sleep = async (ms: number) => {
      now += ms;
    };
    const wait = createPollingWaiter(100, () => now, sleep);
    const healthy = await wait(async () => false, 250);

    expect(healthy).toBe(false);
    expect(now).toBeGreaterThanOrEqual(250);
  });
});
