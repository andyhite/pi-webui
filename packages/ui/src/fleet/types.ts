/**
 * The fleet panel's data (§8, §11): "a fleet view — today's total, the
 * biggest spender, and running sessions against the concurrency limit."
 *
 * **The gap is closed.** `GET /api/fleet` (`apps/server/src/routes/
 * spend.ts`) now returns today's total, the biggest spender, running vs
 * the concurrency limit's real configured value, queued count, and every
 * budget with its remaining amount — one read, no per-session fan-out, no
 * fallback default to carry around. `createApiFleetDataSource` is a plain
 * field mapping over that response; there is no aggregation logic left in
 * this package for the fleet panel to own.
 */

export interface FleetBiggestSpender {
  readonly sessionId: string;
  readonly workstreamId: string;
  readonly amountMicros: number;
}

export interface FleetSummary {
  readonly todayTotalMicros: number;
  readonly biggestSpender: FleetBiggestSpender | null;
  readonly runningCount: number;
  readonly concurrencyLimit: number;
  readonly queuedCount: number;
}

export interface FleetDataSource {
  load(): Promise<FleetSummary>;
}
