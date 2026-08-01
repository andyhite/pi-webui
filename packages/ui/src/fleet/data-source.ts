/**
 * `FleetDataSource` (§8, §11 Fleet panel). `createApiFleetDataSource` is
 * live over `GET /api/fleet` — the fleet aggregate endpoint Track A's
 * Stage 2 landed, closing the gap `types.ts` used to record: no N+1
 * per-session fan-out, no shipped-default fallback for the concurrency
 * limit, one read.
 */

import type { HttpClient } from "../transport/http.js";
import type {
  FleetBiggestSpender,
  FleetDataSource,
  FleetSummary,
} from "./types.js";

interface RawFleetResponse {
  readonly today: { readonly spentMicros: number };
  readonly biggestSpender: {
    readonly sessionId: string;
    readonly workstreamId: string;
    readonly spentMicros: number;
  } | null;
  readonly concurrency: {
    readonly running: number;
    readonly limit: number;
    readonly queued: number;
  };
}

export interface ApiFleetDataSourceOptions {
  readonly http: HttpClient;
}

function toBiggestSpender(
  raw: RawFleetResponse["biggestSpender"],
): FleetBiggestSpender | null {
  if (raw === null) return null;
  return {
    sessionId: raw.sessionId,
    workstreamId: raw.workstreamId,
    amountMicros: raw.spentMicros,
  };
}

export function createApiFleetDataSource(
  options: ApiFleetDataSourceOptions,
): FleetDataSource {
  const { http } = options;

  return {
    async load(): Promise<FleetSummary> {
      const response = await http.get<RawFleetResponse>("/api/fleet");
      return {
        todayTotalMicros: response.today.spentMicros,
        biggestSpender: toBiggestSpender(response.biggestSpender),
        runningCount: response.concurrency.running,
        concurrencyLimit: response.concurrency.limit,
        queuedCount: response.concurrency.queued,
      };
    },
  };
}

export function createFixtureFleetDataSource(
  summary: FleetSummary,
): FleetDataSource {
  return {
    load(): Promise<FleetSummary> {
      return Promise.resolve(summary);
    },
  };
}
