import type { Logger } from "../logging/logger.js";
import {
  nodeIntervalScheduler,
  type IntervalScheduler,
} from "../maintenance/compaction.js";
import type { IntegrationService } from "./service.js";

/**
 * The refresh job (§9.1, principle 2): **a scheduled read, never a scheduled
 * run.**
 *
 * "Scheduled reads only, never scheduled runs — refresh changes state and
 * costs nothing, changes surface as drift." This module is the one thing that
 * decides *when* to call `IntegrationService.refresh`, and it is built so that
 * decision cannot become anything else: it is handed an `IntegrationService`
 * and nothing else — no reference to `RunService`, `SessionHub`, or any budget
 * — so there is no path from this file to starting a session even by mistake.
 * Every tick calls `refresh()`, whose own contract is a read reconciled through
 * `ObjectStore`; nothing downstream of that call can initiate work either.
 *
 * The predicate for *which* integrations are due is
 * `IntegrationService.dueForScheduledRefresh`, itself built on
 * `isIntervalRefreshDue` — an on-demand or observed producer is never due here,
 * because manual refresh and the host callback seam are their own paths.
 *
 * Timers are injected, exactly like `maintenance/compaction.ts` and
 * `attention/tick.ts`: a schedule tested against real time either sleeps or
 * lies, and this one is tested by driving a fake scheduler and a fake clock
 * directly.
 */
export interface RefreshJob {
  stop(): void;
  /** Run one tick now, outside the schedule. */
  runNow(): Promise<void>;
  /**
   * Change the cadence without restarting the process (§11's "applied without
   * restart", Epic 8.3). Clears whatever timer is running and re-arms with the
   * new interval; zero disables the schedule exactly like the constructor
   * option does, and on-demand and observed refresh stay available either way.
   */
  reschedule(intervalSeconds: number): void;
  readonly intervalSeconds: number;
}

export interface RefreshJobOptions {
  readonly integrations: IntegrationService;
  readonly logger: Logger;
  /** Seconds between ticks; 0 or less disables the schedule. */
  readonly intervalSeconds: number;
  readonly now: () => number;
  readonly scheduler?: IntervalScheduler;
}

export function startRefreshJob(options: RefreshJobOptions): RefreshJob {
  const { integrations, now, scheduler } = options;
  // Tagged so the Logs panel can filter to just this schedule (§8, Epic 8.3).
  const logger = options.logger.child("integrations");
  const pickScheduler = scheduler ?? nodeIntervalScheduler;

  const runNow = async (): Promise<void> => {
    const due = integrations.dueForScheduledRefresh(now());
    for (const integration of due) {
      try {
        const outcome = await integrations.refresh(integration.id);
        logger.info("scheduled integration refresh", {
          integrationId: integration.id,
          ok: outcome.ok,
        });
      } catch (error) {
        // One integration's failure is not the schedule's: the next tick and
        // every other integration's own refresh try independently.
        logger.error("scheduled integration refresh failed", {
          integrationId: integration.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  let timer: { clear(): void } | null = null;
  let currentIntervalSeconds = 0;

  const arm = (intervalSeconds: number): void => {
    timer?.clear();
    timer = null;
    currentIntervalSeconds = intervalSeconds;

    if (intervalSeconds <= 0) {
      logger.info("integration refresh schedule disabled", { intervalSeconds });
      return;
    }

    timer = pickScheduler(() => {
      runNow().catch((error: unknown) => {
        logger.error("integration refresh tick failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalSeconds * 1000);

    logger.info("integration refresh scheduled", { intervalSeconds });
  };

  arm(options.intervalSeconds);

  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      timer?.clear();
      timer = null;
    },
    runNow,
    reschedule: (intervalSeconds: number) => {
      if (stopped) return;
      logger.info("integration refresh rescheduled", {
        from: currentIntervalSeconds,
        to: intervalSeconds,
      });
      arm(intervalSeconds);
    },
    get intervalSeconds() {
      return currentIntervalSeconds;
    },
  };
}
