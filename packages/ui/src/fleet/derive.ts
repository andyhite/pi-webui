/**
 * The fleet aggregation, as a pure function over what is actually available
 * (see `types.ts`'s doc comment for the gap this stands in for). Kept
 * separate from `data-source.ts` so "what counts as today, and who is the
 * biggest spender" is testable without any HTTP plumbing at all.
 */

import type {
  FleetSessionSpend,
  FleetSessionSummary,
  FleetSummary,
} from "./types.js";

/** The shipped default (`apps/server/src/config.ts#DEFAULT_CONCURRENCY_LIMIT`) — the fallback until a real endpoint names the configured value. */
export const DEFAULT_CONCURRENCY_LIMIT_FALLBACK = 4;

const SECONDS_PER_DAY = 24 * 60 * 60;

/** Midnight UTC on `now`'s day \u2014 a fixed, testable notion of "today" rather than a client-timezone guess. */
export function startOfUtcDay(nowSeconds: number): number {
  return Math.floor(nowSeconds / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

export function deriveFleetSummary(input: {
  readonly sessions: readonly FleetSessionSummary[];
  readonly spend: readonly FleetSessionSpend[];
  readonly nowSeconds: number;
  readonly concurrencyLimit: number;
  readonly queuedCount: number;
}): FleetSummary {
  const since = startOfUtcDay(input.nowSeconds);

  let todayTotalMicros = 0;
  let biggestSpender: { sessionId: string; amountMicros: number } | null = null;

  for (const session of input.spend) {
    let sessionTotal = 0;
    for (const entry of session.entries) {
      if (entry.at >= since) todayTotalMicros += entry.amountMicros;
      sessionTotal += entry.amountMicros;
    }
    if (
      sessionTotal > 0 &&
      (biggestSpender === null || sessionTotal > biggestSpender.amountMicros)
    ) {
      biggestSpender = {
        sessionId: session.sessionId,
        amountMicros: sessionTotal,
      };
    }
  }

  return {
    todayTotalMicros,
    biggestSpender,
    runningCount: input.sessions.filter((s) => s.running).length,
    concurrencyLimit: input.concurrencyLimit,
    queuedCount: input.queuedCount,
  };
}
