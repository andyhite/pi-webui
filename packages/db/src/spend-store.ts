import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  attributeSpend,
  systemClock,
  type Clock,
  type SessionId,
  type SessionSpend,
  type SpendAttributionEntry,
} from "@plotroom/core";
import type { PlotroomDatabase } from "./client.js";
import { sessions, spendAttributions } from "./schema.js";

/**
 * Spend attributed up the initiating chain (§3.6, principle 2, Epic 4.5).
 *
 * "Every delegated or dispatched session is visible on the graph with its
 * provenance... its spend counts against every budget that binds the initiating
 * work." `attributeSpend` in `@plotroom/core` decides which rows exist; this
 * store keeps them, so what a chain cost stays answerable after the fact — the
 * same reasoning as §15-1's full run record.
 *
 * Money is integer micros, like every other money column. Enforcement is Phase
 * 6's; this is the data it will enforce against, recorded from the first
 * delegation rather than retrofitted onto a history that never had it.
 */
export interface AttributedSpend {
  readonly sessionId: SessionId;
  readonly sourceSessionId: SessionId;
  readonly basis: "own" | "descendant";
  readonly amountMicros: number;
  readonly costBasis: "reported" | "priced";
  readonly at: number;
}

export interface SpendTotal {
  readonly amountMicros: number;
  /** How many sessions contributed, own work included. */
  readonly sources: number;
}

export class SpendStore {
  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {}

  /**
   * Attribute one session's observed spend to every session in its chain.
   *
   * Idempotent per (charged session, spender): a session whose total grew is
   * re-attributed by *replacing* its rows, never by adding a second one — the
   * accounting fold recomputes a total from the log, so the same spend observed
   * twice must not be charged twice (principle 9, applied to money).
   */
  attribute(input: {
    readonly chain: readonly SessionId[];
    readonly workstreamId: string;
    readonly spend: SessionSpend;
  }): readonly SpendAttributionEntry[] {
    const entries = attributeSpend(input.chain, input.spend);
    if (entries.length === 0) return entries;

    this.state.db.transaction(() => {
      for (const entry of entries) {
        this.state.db
          .insert(spendAttributions)
          .values({
            id: `spend_${randomUUID()}`,
            sessionId: entry.sessionId,
            sourceSessionId: entry.sourceSessionId,
            workstreamId: input.workstreamId,
            basis: entry.basis,
            amountMicros: Math.round(entry.amountUsd * 1_000_000),
            costBasis: entry.costBasis,
            at: entry.at,
          })
          .onConflictDoUpdate({
            target: [
              spendAttributions.sessionId,
              spendAttributions.sourceSessionId,
            ],
            set: {
              amountMicros: Math.round(entry.amountUsd * 1_000_000),
              costBasis: entry.costBasis,
              at: entry.at,
            },
          })
          .run();
      }
    });

    return entries;
  }

  /** Every row charged to a session: its own work and everything it delegated. */
  forSession(sessionId: string): readonly AttributedSpend[] {
    return this.state.db
      .select()
      .from(spendAttributions)
      .where(eq(spendAttributions.sessionId, sessionId))
      .all()
      .map((row) => ({
        sessionId: row.sessionId as SessionId,
        sourceSessionId: row.sourceSessionId as SessionId,
        basis: row.basis,
        amountMicros: row.amountMicros,
        costBasis: row.costBasis,
        at: row.at,
      }));
  }

  /** What a session's budgets must count (§8), delegates included. */
  sessionTotal(sessionId: string): SpendTotal {
    const row = this.state.db
      .select({
        amountMicros: sql<number>`coalesce(sum(${spendAttributions.amountMicros}), 0)`,
        sources: sql<number>`count(*)`,
      })
      .from(spendAttributions)
      .where(eq(spendAttributions.sessionId, sessionId))
      .get();

    return {
      amountMicros: row?.amountMicros ?? 0,
      sources: row?.sources ?? 0,
    };
  }

  /**
   * What a workstream's budget must count: every `own` row for a session in it.
   *
   * `own` rows only, deliberately — summing `descendant` rows as well would
   * count a delegated dollar once per ancestor, which is right for one session's
   * budget and wrong for the workstream's total.
   */
  workstreamTotal(workstreamId: string): SpendTotal {
    const row = this.state.db
      .select({
        amountMicros: sql<number>`coalesce(sum(${spendAttributions.amountMicros}), 0)`,
        sources: sql<number>`count(*)`,
      })
      .from(spendAttributions)
      .where(
        sql`${spendAttributions.workstreamId} = ${workstreamId} and ${spendAttributions.basis} = 'own'`,
      )
      .get();

    return {
      amountMicros: row?.amountMicros ?? 0,
      sources: row?.sources ?? 0,
    };
  }

  /** The fleet's total (§8): every session's own spend, once each. */
  fleetTotal(): SpendTotal {
    const row = this.state.db
      .select({
        amountMicros: sql<number>`coalesce(sum(${spendAttributions.amountMicros}), 0)`,
        sources: sql<number>`count(*)`,
      })
      .from(spendAttributions)
      .where(eq(spendAttributions.basis, "own"))
      .get();

    return {
      amountMicros: row?.amountMicros ?? 0,
      sources: row?.sources ?? 0,
    };
  }

  /**
   * The workstream a session belongs to — needed to file an attribution row,
   * and read here rather than passed in so a caller cannot file it under the
   * wrong one.
   */
  workstreamOf(sessionId: string): string | null {
    const row = this.state.db
      .select({ workstreamId: sessions.workstreamId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    return row?.workstreamId ?? null;
  }

  /** Unix seconds, for a caller that wants the store's own clock. */
  clock(): number {
    return this.now();
  }
}
