import { describe, expect, it, vi } from "vitest";
import type { CompactionResult, Maintenance } from "@plotroom/db";
import { Logger } from "../logging/logger.js";
import {
  startCompactionJob,
  type IntervalScheduler,
  type Timer,
} from "./compaction.js";

const EMPTY: CompactionResult = {
  at: 0,
  versionsRemoved: 0,
  runsRemoved: 0,
  blobsRemoved: 0,
  bytesFreed: 0,
};

/** A scheduler that hands the test the callback instead of a real timer. */
function fakeScheduler() {
  const calls: { callback: () => void; everyMillis: number }[] = [];
  let cleared = 0;

  const scheduler: IntervalScheduler = (callback, everyMillis): Timer => {
    calls.push({ callback, everyMillis });
    return {
      clear: () => {
        cleared += 1;
      },
    };
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

function job(
  compact: () => CompactionResult,
  intervalSeconds: number,
  scheduler?: IntervalScheduler,
) {
  const maintenance = { compact } as unknown as Maintenance;
  return startCompactionJob({
    maintenance,
    logger: new Logger("error"),
    intervalSeconds,
    ...(scheduler === undefined ? {} : { scheduler }),
  });
}

describe("the compaction job (Epic 2.3, §15-3)", () => {
  it("sweeps on the configured interval, not at startup", () => {
    const compact = vi.fn(() => EMPTY);
    const timers = fakeScheduler();

    const schedule = job(compact, 3_600, timers.scheduler);

    // A process restarting in a loop must not sweep on every boot.
    expect(compact).not.toHaveBeenCalled();
    expect(timers.calls[0]?.everyMillis).toBe(3_600_000);
    expect(schedule.intervalSeconds).toBe(3_600);

    timers.tick();
    timers.tick();
    expect(compact).toHaveBeenCalledTimes(2);
  });

  it("does not schedule anything when the interval is off", () => {
    const compact = vi.fn(() => EMPTY);
    const timers = fakeScheduler();

    const schedule = job(compact, 0, timers.scheduler);

    expect(timers.calls).toHaveLength(0);
    expect(schedule.intervalSeconds).toBe(0);

    // "Never automatically" is not "never": the operator can still ask.
    schedule.runNow();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("keeps sweeping after one sweep fails", () => {
    const compact = vi
      .fn<() => CompactionResult>()
      .mockImplementationOnce(() => {
        throw new Error("disk on fire");
      })
      .mockImplementation(() => EMPTY);
    const timers = fakeScheduler();

    job(compact, 60, timers.scheduler);

    // A failed sweep is logged and dropped: nothing downstream waits on it, and
    // taking the server down for a maintenance job would be worse than the job
    // not running.
    expect(() => timers.tick()).not.toThrow();
    expect(() => timers.tick()).not.toThrow();
    expect(compact).toHaveBeenCalledTimes(2);
  });

  it("stops once, however many times it is asked", () => {
    const timers = fakeScheduler();
    const schedule = job(() => EMPTY, 60, timers.scheduler);

    schedule.stop();
    schedule.stop();

    expect(timers.cleared).toBe(1);
  });

  it("reports what a sweep removed, verbatim", () => {
    const result: CompactionResult = {
      at: 123,
      versionsRemoved: 4,
      runsRemoved: 1,
      blobsRemoved: 5,
      bytesFreed: 8_192,
    };

    expect(job(() => result, 0).runNow()).toEqual(result);
  });
});
