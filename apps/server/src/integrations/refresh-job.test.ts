import { describe, expect, it, vi } from "vitest";
import type { Integration } from "@plotroom/core";
import { Logger } from "../logging/logger.js";
import type { IntervalScheduler, Timer } from "../maintenance/compaction.js";
import { startRefreshJob } from "./refresh-job.js";
import type { IntegrationService } from "./service.js";

function fakeScheduler() {
  const calls: { callback: () => void; everyMillis: number }[] = [];
  let cleared = 0;
  const scheduler: IntervalScheduler = (callback, everyMillis): Timer => {
    calls.push({ callback, everyMillis });
    return { clear: () => (cleared += 1) };
  };
  return {
    scheduler,
    calls,
    tick: () => calls.at(-1)?.callback(),
    get cleared() {
      return cleared;
    },
  };
}

function fixture(id: string): Integration {
  return {
    id,
    pluginId: "fake-plugin",
    producerId: "fake-tickets",
    name: "Fake tickets",
    system: "fake",
    scope: null,
    connectionState: "connected",
    lastConnectedAt: 0,
    lastRefreshAt: null,
    lastBrokenAt: null,
    lastBrokenReason: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * A stand-in with **only** the two methods `startRefreshJob` is allowed to call.
 * Its type is intentionally not the real `IntegrationService`: anything this
 * job needs beyond `dueForScheduledRefresh`/`refresh` is a compile error here,
 * which is the structural half of "never a scheduled run" (principle 2) — there
 * is no run or session reference anywhere in this file for the job to reach.
 */
function fakeIntegrations(due: readonly Integration[]) {
  const refreshed: string[] = [];
  const stub: Pick<IntegrationService, "dueForScheduledRefresh" | "refresh"> = {
    dueForScheduledRefresh: vi.fn(() => due),
    refresh: vi.fn(async (id: string) => {
      refreshed.push(id);
      return {
        ok: true as const,
        integration: fixture(id),
        objectsWritten: 0,
        objects: [],
        unavailable: [],
      };
    }),
  };
  return { stub: stub as IntegrationService, refreshed };
}

describe("the integration refresh job (§9.1, principle 2)", () => {
  it("does not schedule anything when the interval is off, but on-demand still runs", async () => {
    const { stub, refreshed } = fakeIntegrations([fixture("integration-1")]);
    const timers = fakeScheduler();

    const job = startRefreshJob({
      integrations: stub,
      logger: new Logger("error"),
      intervalSeconds: 0,
      now: () => 0,
      scheduler: timers.scheduler,
    });

    expect(timers.calls).toHaveLength(0);
    await job.runNow();
    expect(refreshed).toEqual(["integration-1"]);
  });

  it("refreshes only what is due, every tick, and nothing else", async () => {
    const { stub, refreshed } = fakeIntegrations([
      fixture("integration-1"),
      fixture("integration-2"),
    ]);
    const timers = fakeScheduler();

    const job = startRefreshJob({
      integrations: stub,
      logger: new Logger("error"),
      intervalSeconds: 30,
      now: () => 1_000,
      scheduler: timers.scheduler,
    });

    expect(timers.calls[0]?.everyMillis).toBe(30_000);
    expect(job.intervalSeconds).toBe(30);

    await timers.tick();
    expect(refreshed).toEqual(["integration-1", "integration-2"]);
    expect(stub.dueForScheduledRefresh).toHaveBeenCalledWith(1_000);
  });

  it("one integration's refresh failure never stops another's, or the schedule", async () => {
    const failing = fixture("integration-fails");
    const ok = fixture("integration-ok");
    const refreshed: string[] = [];
    const stub: Pick<IntegrationService, "dueForScheduledRefresh" | "refresh"> =
      {
        dueForScheduledRefresh: () => [failing, ok],
        refresh: vi.fn(async (id: string) => {
          if (id === failing.id) throw new Error("network unreachable");
          refreshed.push(id);
          return {
            ok: true as const,
            integration: fixture(id),
            objectsWritten: 0,
            objects: [],
            unavailable: [],
          };
        }),
      };
    const timers = fakeScheduler();

    const job = startRefreshJob({
      integrations: stub as IntegrationService,
      logger: new Logger("error"),
      intervalSeconds: 30,
      now: () => 0,
      scheduler: timers.scheduler,
    });

    await expect(job.runNow()).resolves.toBeUndefined();
    expect(refreshed).toEqual([ok.id]);
  });

  it("stops once, however many times it is asked", () => {
    const { stub } = fakeIntegrations([]);
    const timers = fakeScheduler();
    const job = startRefreshJob({
      integrations: stub,
      logger: new Logger("error"),
      intervalSeconds: 30,
      now: () => 0,
      scheduler: timers.scheduler,
    });
    job.stop();
    job.stop();
    expect(timers.cleared).toBe(1);
  });

  it("reschedules without a restart (Epic 8.3)", async () => {
    const { stub, refreshed } = fakeIntegrations([fixture("integration-1")]);
    const timers = fakeScheduler();
    const job = startRefreshJob({
      integrations: stub,
      logger: new Logger("error"),
      intervalSeconds: 30,
      now: () => 0,
      scheduler: timers.scheduler,
    });

    job.reschedule(5);

    expect(timers.cleared).toBe(1);
    expect(timers.calls).toHaveLength(2);
    expect(timers.calls[1]?.everyMillis).toBe(5_000);
    expect(job.intervalSeconds).toBe(5);

    await timers.tick();
    expect(refreshed).toEqual(["integration-1"]);
  });

  it("a stopped job ignores a reschedule rather than reviving itself", () => {
    const { stub } = fakeIntegrations([]);
    const timers = fakeScheduler();
    const job = startRefreshJob({
      integrations: stub,
      logger: new Logger("error"),
      intervalSeconds: 30,
      now: () => 0,
      scheduler: timers.scheduler,
    });

    job.stop();
    job.reschedule(10);

    expect(timers.calls).toHaveLength(1);
  });
});
