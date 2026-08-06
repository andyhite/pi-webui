import { expect } from "vitest";
import { describe, it, mock } from "bun:test";
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
    const compact = mock(() => EMPTY);
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
    const compact = mock(() => EMPTY);
    const timers = fakeScheduler();

    const schedule = job(compact, 0, timers.scheduler);

    expect(timers.calls).toHaveLength(0);
    expect(schedule.intervalSeconds).toBe(0);

    // "Never automatically" is not "never": the operator can still ask.
    schedule.runNow();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("keeps sweeping after one sweep fails", () => {
    const compact = mock<() => CompactionResult>()
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

  it("reschedules without a restart, clearing the old timer and arming a new one (Epic 8.3)", () => {
    const compact = mock(() => EMPTY);
    const timers = fakeScheduler();

    const schedule = job(compact, 3_600, timers.scheduler);
    expect(timers.calls).toHaveLength(1);

    schedule.reschedule(60);

    expect(timers.cleared).toBe(1);
    expect(timers.calls).toHaveLength(2);
    expect(timers.calls[1]?.everyMillis).toBe(60_000);
    expect(schedule.intervalSeconds).toBe(60);

    timers.tick();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("rescheduling to zero disables the schedule without disabling runNow", () => {
    const compact = mock(() => EMPTY);
    const timers = fakeScheduler();

    const schedule = job(compact, 3_600, timers.scheduler);
    schedule.reschedule(0);

    expect(schedule.intervalSeconds).toBe(0);
    // Only the arm from construction was cleared; no new timer replaced it.
    expect(timers.calls).toHaveLength(1);

    schedule.runNow();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("a stopped schedule ignores a reschedule rather than reviving itself", () => {
    const timers = fakeScheduler();
    const schedule = job(() => EMPTY, 60, timers.scheduler);

    schedule.stop();
    schedule.reschedule(30);

    expect(timers.calls).toHaveLength(1);
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
