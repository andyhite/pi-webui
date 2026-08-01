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
    async kill() {
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

  it("attaches instead of throwing when a re-probe after the deadline finds it healthy after all", async () => {
    // Models a race with a concurrent launch: nothing is healthy when this
    // call starts, the wait times out, but a re-probe right before giving
    // up finds the other launch finished in the meantime.
    const child = fakeProcess(11);
    let probeCalls = 0;
    const probe = async () => {
      probeCalls += 1;
      return probeCalls >= 3;
    };

    const handle = await spawnOrAttach({
      probe,
      spawn: () => child,
      waitUntilHealthy: async (p) => p(),
    });

    expect(handle.result).toEqual({ mode: "attached" });
    // The spawn attempt that lost the race is cleaned up, not left running.
    expect(child.killed).toBe(true);
  });

  it("kills its own late-healthy child before re-probing, never attaching to the corpse of what it just killed", async () => {
    // A child that would still report healthy if probed before being
    // killed — simulating "the wait gave up a beat before our own child
    // actually came up". The fix must kill it first and only then
    // re-probe, so this can never be mistaken for a genuinely different
    // server to attach to.
    const child = fakeProcess(13);
    let calls = 0;
    const probe = async () => {
      calls += 1;
      // Call 1: pre-spawn check. Call 2: waitUntilHealthy's one check.
      // Both unhealthy, so the wait times out.
      if (calls <= 2) return false;
      // Call 3+: the re-probe. "Healthy" only if nobody has killed this
      // child yet — which a correct kill-before-probe order rules out.
      return !child.killed;
    };

    await expect(
      spawnOrAttach({
        probe,
        spawn: () => child,
        waitUntilHealthy: async (p) => p(),
      }),
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
