import type { Logger } from "../logging/logger.js";
import {
  nodeIntervalScheduler,
  type IntervalScheduler,
} from "../maintenance/compaction.js";
import type { AttentionService } from "./service.js";

/**
 * The attention tick — **a scheduled read, never an initiation** (principle 2).
 *
 * Everything §7 shows is derived from records that already exist, and the
 * ordinary trigger for re-deriving is the event stream: something was observed,
 * so the queue is recomputed. Two kinds of fact are not events, though, and they
 * are the reason this exists:
 *
 * - **a threshold coming due.** "No output for ten minutes" becomes true because
 *   time passed and nothing happened. An alert that only appeared when something
 *   else changed would be an alert about silence that silence could suppress.
 * - **a snooze elapsing.** "Bring it back at 3pm" needs somebody to look at 3pm.
 *
 * Principle 2 forbids the product *originating work*: starting a session,
 * queueing a run, spending money with nobody behind it. This starts nothing and
 * spends nothing — it reads state and publishes a list. The stance is recorded
 * here rather than assumed, because a timer in this product needs a reason.
 *
 * Zero disables the schedule. The derivation still runs on every event and every
 * read of `GET /api/attention`, so disabling it costs punctuality, not the queue.
 */
export interface AttentionTick {
  stop(): void;
  /** Re-derive now, outside the schedule. */
  runNow(): void;
  /**
   * Change the cadence without restarting the process (§11's "applied without
   * restart", Epic 8.3). Clears whatever timer is running and re-arms with the
   * new interval; zero disables the schedule exactly like the constructor
   * option does, and every event-driven re-derivation stays unaffected either
   * way — only the two clock-only facts (a threshold coming due, a snooze
   * elapsing) lose or gain punctuality.
   */
  reschedule(intervalSeconds: number): void;
  readonly intervalSeconds: number;
}

export interface AttentionTickOptions {
  readonly attention: AttentionService;
  readonly logger: Logger;
  readonly intervalSeconds: number;
  readonly scheduler?: IntervalScheduler;
}

export function startAttentionTick(
  options: AttentionTickOptions,
): AttentionTick {
  const { attention, scheduler } = options;
  // Tagged so the Logs panel can filter to just this schedule (§8, Epic 8.3).
  const logger = options.logger.child("attention");
  const pickScheduler = scheduler ?? nodeIntervalScheduler;

  const runNow = (): void => {
    attention.refresh();
  };

  let timer: { clear(): void } | null = null;
  let currentIntervalSeconds = 0;

  const arm = (intervalSeconds: number): void => {
    timer?.clear();
    timer = null;
    currentIntervalSeconds = intervalSeconds;

    if (intervalSeconds <= 0) {
      logger.info("attention tick disabled", { intervalSeconds });
      return;
    }

    timer = pickScheduler(() => {
      try {
        runNow();
      } catch (error) {
        // A failed re-derivation must not take the server with it; the next
        // tick and the next event both try again.
        logger.error("attention tick failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }, intervalSeconds * 1000);

    logger.info("attention tick scheduled", { intervalSeconds });
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
      logger.info("attention tick rescheduled", {
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
