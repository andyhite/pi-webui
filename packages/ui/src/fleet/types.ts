/**
 * The fleet panel's data (§8, §11): "a fleet view — today's total, the
 * biggest spender, and running sessions against the concurrency limit."
 *
 * **A known gap for Track A (recorded here, not hidden):** there is no
 * fleet aggregate endpoint on main. `GET /api/spend` (`apps/server/src/
 * routes/spend.ts`) returns only the fleet's all-time total and a row
 * count — no per-session breakdown, no "today" scoping, no concurrency
 * limit value anywhere. `createApiFleetDataSource` below computes what it
 * can from what exists (`GET /api/sessions` for running-vs-total,
 * `GET /api/sessions/:id/spend`'s per-session `entries` — each carrying its
 * own `at` — for today's total and the biggest spender), which is real
 * aggregation over real data, not a fixture standing in for it. The one
 * thing genuinely missing is the concurrency limit's *value*: it is
 * computed server-side (`apps/server/src/config.ts`) and only ever
 * returned embedded in a run-scope preview, never as its own read. This
 * data source takes it as a parameter with the shipped default
 * (`DEFAULT_CONCURRENCY_LIMIT`, currently 4) as its fallback, clearly
 * marked below — Track A's fleet aggregate endpoint should expose it
 * directly so a caller never has to know the default to render this panel
 * correctly.
 */

export interface FleetSessionSpend {
  readonly sessionId: string;
  /** One row per spend attribution entry this session was charged (own work only — descendants double-count a fleet total). */
  readonly entries: readonly {
    readonly amountMicros: number;
    readonly at: number;
  }[];
}

export interface FleetSessionSummary {
  readonly sessionId: string;
  readonly running: boolean;
}

export interface FleetSummary {
  readonly todayTotalMicros: number;
  readonly biggestSpender: {
    readonly sessionId: string;
    readonly amountMicros: number;
  } | null;
  readonly runningCount: number;
  readonly concurrencyLimit: number;
  readonly queuedCount: number;
}

export interface FleetDataSource {
  load(): Promise<FleetSummary>;
}
