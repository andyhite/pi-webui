import type { CompactionResult, Maintenance } from "@plotroom/db";
import type { Logger } from "../logging/logger.js";

/**
 * The compaction job (Epic 2.3, §15-3).
 *
 * The *rule* is a pure predicate in `@plotroom/core` and the *sweep* is
 * `Maintenance.compact` in `@plotroom/db`; this epic owns only the scheduling,
 * which is why this file is small and knows nothing about what compaction
 * decides. It cannot: a job that had an opinion about retention would be a
 * second place the rule lives.
 *
 * Timers are injected. A schedule tested against real time is a test that either
 * sleeps or lies, and the interval here is measured in hours.
 */
export interface CompactionSchedule {
  /** Stop the sweep. Idempotent, so shutting down twice is not an error. */
  stop(): void;
  /** Run one sweep now, outside the schedule (the on-demand endpoint). */
  runNow(): CompactionResult;
  readonly intervalSeconds: number;
}

export interface Timer {
  clear(): void;
}

/** `setInterval`, as a dependency. Tests pass a fake and drive it directly. */
export type IntervalScheduler = (
  callback: () => void,
  everyMillis: number,
) => Timer;

export const nodeIntervalScheduler: IntervalScheduler = (
  callback,
  everyMillis,
) => {
  const handle = setInterval(callback, everyMillis);
  // Maintenance must never be the reason a process refuses to exit.
  handle.unref();
  return { clear: () => clearInterval(handle) };
};

export interface CompactionJobOptions {
  readonly maintenance: Maintenance;
  readonly logger: Logger;
  /** Seconds between sweeps; 0 or less disables the schedule entirely. */
  readonly intervalSeconds: number;
  readonly scheduler?: IntervalScheduler;
}

/**
 * Start the schedule (or deliberately not, when the interval is off).
 *
 * The first sweep happens after one interval, never at startup: a process that
 * is restarting in a loop would otherwise sweep on every boot, and compaction is
 * the one job whose cost is proportional to how much it finds.
 */
export function startCompactionJob(
  options: CompactionJobOptions,
): CompactionSchedule {
  const { maintenance, logger, intervalSeconds } = options;
  const scheduler = options.scheduler ?? nodeIntervalScheduler;

  const runNow = (): CompactionResult => {
    const result = maintenance.compact();

    // Reported every time, including the sweeps that found nothing: a
    // maintenance job nobody can see is a maintenance job nobody can trust (§8).
    logger.info("compaction sweep", {
      versionsRemoved: result.versionsRemoved,
      runsRemoved: result.runsRemoved,
      blobsRemoved: result.blobsRemoved,
      bytesFreed: result.bytesFreed,
    });

    return result;
  };

  if (intervalSeconds <= 0) {
    logger.info("compaction schedule disabled", { intervalSeconds });
    return { stop: () => {}, runNow, intervalSeconds: 0 };
  }

  const timer = scheduler(() => {
    try {
      runNow();
    } catch (error) {
      // A failed sweep must not take the server with it: nothing downstream
      // depends on it having run, and the next interval tries again.
      logger.error("compaction sweep failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, intervalSeconds * 1000);

  logger.info("compaction scheduled", { intervalSeconds });

  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      timer.clear();
    },
    runNow,
    intervalSeconds,
  };
}
