/**
 * `FleetDataSource` (§8, §11 Fleet panel). `createApiFleetDataSource` is
 * live over what exists on main today: `GET /api/sessions` (running vs
 * total), `GET /api/sessions/:id/spend` per session (today's total, the
 * biggest spender — real per-entry timestamps, not a guess), and
 * `GET /api/run-queue` (how many are admitted-but-waiting). The
 * concurrency limit's *value* has no read endpoint at all yet (see
 * `types.ts`) — taken here as a constructor option, defaulting to the
 * shipped default, with a `TODO` naming exactly what Track A should add.
 */

import { isQueuedRunStartable, type QueuedRunState } from "@plotroom/core";

import type { HttpClient } from "../transport/http.js";
import {
  DEFAULT_CONCURRENCY_LIMIT_FALLBACK,
  deriveFleetSummary,
} from "./derive.js";
import type {
  FleetDataSource,
  FleetSessionSpend,
  FleetSessionSummary,
  FleetSummary,
} from "./types.js";

export interface ApiFleetDataSourceOptions {
  readonly http: HttpClient;
  readonly now?: () => number;
  /**
   * TODO(Track A, Epic 6.2 Stage 2): replace with a read off a real fleet
   * aggregate endpoint (e.g. `GET /api/fleet` returning `concurrencyLimit`
   * alongside whatever else the derivation needs) — there is nowhere to
   * read the *configured* limit from today (`apps/server/src/config.ts`
   * resolves it at boot and never publishes it).
   */
  readonly concurrencyLimit?: number;
}

export function createApiFleetDataSource(
  options: ApiFleetDataSourceOptions,
): FleetDataSource {
  const { http } = options;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const concurrencyLimit =
    options.concurrencyLimit ?? DEFAULT_CONCURRENCY_LIMIT_FALLBACK;

  return {
    async load(): Promise<FleetSummary> {
      const sessionsResponse = await http.get<{
        readonly sessions: readonly {
          readonly session: { readonly id: string };
          readonly end: unknown;
        }[];
      }>("/api/sessions");

      const sessions: FleetSessionSummary[] = sessionsResponse.sessions.map(
        (entry) => ({
          sessionId: entry.session.id,
          running: entry.end === null,
        }),
      );

      const spend: FleetSessionSpend[] = await Promise.all(
        sessions.map(async (session) => {
          const response = await http.get<{
            readonly entries: readonly {
              readonly amountMicros: number;
              readonly at: number;
              readonly basis: "own" | "descendant";
            }[];
          }>(`/api/sessions/${encodeURIComponent(session.sessionId)}/spend`);
          return {
            sessionId: session.sessionId,
            // `own` only: a fleet total counting `descendant` rows too would
            // count a delegated dollar once per ancestor (the same reasoning
            // `SpendStore.fleetTotal` already applies server-side).
            entries: response.entries
              .filter((entry) => entry.basis === "own")
              .map((entry) => ({
                amountMicros: entry.amountMicros,
                at: entry.at,
              })),
          };
        }),
      );

      const queue = await http.get<{
        readonly queued: readonly { readonly state: QueuedRunState }[];
      }>("/api/run-queue");

      return deriveFleetSummary({
        sessions,
        spend,
        nowSeconds: now(),
        concurrencyLimit,
        // `GET /api/run-queue`'s `queued` array is "everything a queue
        // surface shows: waiting, in flight, and re-asking"
        // (`apps/server/src/runs/queue.ts#open`'s own doc comment) —
        // `starting`/`running`/`needs_reask`/`paused` entries hold a
        // concurrency slot or are mid-flight, not admitted-but-waiting.
        // `isQueuedRunStartable` is `@plotroom/core`'s own predicate for
        // "still queued" (principle 8: the same rule the drain loop and
        // the cancel verb use, never reimplemented here).
        queuedCount: queue.queued.filter((entry) =>
          isQueuedRunStartable(entry.state),
        ).length,
      });
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
