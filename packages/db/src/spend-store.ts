import { randomUUID } from "node:crypto";
import { eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  attributeSpend,
  dayStartSeconds,
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
 * Money is integer micros, like every other money column. **Spend outlives the
 * session that spent it** (§8): rows are never zeroed, sessions are only ever
 * soft-deleted, and nothing about run retention touches this table — a compacted
 * run takes no spend with it. Every "today's total" here is therefore a *window*
 * over the ledger evaluated at read time, never a reset.
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

/**
 * The window a total covers (§8's "today's total", and a budget's period).
 *
 * A window rather than a reset: totals are never zeroed, and "today" is a lower
 * bound on attribution timestamps applied at read time. Nothing schedules
 * anything, which is what keeps a daily ceiling clear of principle 2.
 */
export interface SpendWindow {
  /** Unix seconds; rows at or after this are counted. Absent means all of it. */
  readonly since?: number | undefined;
}

/** One session's own spend, for §8's "the biggest spender". */
export interface SessionSpendTotal {
  readonly sessionId: SessionId;
  readonly workstreamId: string;
  readonly amountMicros: number;
  readonly at: number;
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
  sessionTotal(sessionId: string, window: SpendWindow = {}): SpendTotal {
    return this.total(
      sql`${spendAttributions.sessionId} = ${sessionId}`,
      window,
    );
  }

  /**
   * What a workstream's budget must count: every `own` row for a session in it.
   *
   * `own` rows only, deliberately — summing `descendant` rows as well would
   * count a delegated dollar once per ancestor, which is right for one session's
   * budget and wrong for the workstream's total.
   */
  workstreamTotal(workstreamId: string, window: SpendWindow = {}): SpendTotal {
    return this.total(
      sql`${spendAttributions.workstreamId} = ${workstreamId} and ${spendAttributions.basis} = 'own'`,
      window,
    );
  }

  /** The fleet's total (§8): every session's own spend, once each. */
  fleetTotal(window: SpendWindow = {}): SpendTotal {
    return this.total(sql`${spendAttributions.basis} = 'own'`, window);
  }

  /**
   * What was spent today (§8's fleet view). A window over the ledger, taken from
   * the store's own clock at the UTC boundary `@plotroom/core` states — so a daily
   * ceiling and the number shown beside it measure the same day.
   */
  todayTotal(): SpendTotal {
    return this.fleetTotal({ since: dayStartSeconds(this.now()) });
  }

  /**
   * What a batch's cap must count: the own spend of every session in it.
   *
   * Keyed on the *spender* rather than the charged session, so a batch whose
   * sessions delegated counts each delegated dollar once rather than once per
   * ancestor inside the batch.
   */
  sessionsTotal(
    sessionIds: readonly string[],
    window: SpendWindow = {},
  ): SpendTotal {
    if (sessionIds.length === 0) return { amountMicros: 0, sources: 0 };
    return this.total(
      sql`${inArray(spendAttributions.sourceSessionId, [...sessionIds])} and ${spendAttributions.basis} = 'own'`,
      window,
    );
  }

  /**
   * Every session's own spend, biggest first (§8: "the biggest spender").
   *
   * `own` rows only, for the same reason the workstream total uses them: the
   * biggest spender is the session that spent the money, not the one that
   * delegated the most of it.
   */
  bySession(window: SpendWindow = {}): SessionSpendTotal[] {
    return this.state.db
      .select({
        sessionId: spendAttributions.sourceSessionId,
        workstreamId: spendAttributions.workstreamId,
        amountMicros: sql<number>`coalesce(sum(${spendAttributions.amountMicros}), 0)`,
        at: sql<number>`max(${spendAttributions.at})`,
      })
      .from(spendAttributions)
      .where(this.scoped(sql`${spendAttributions.basis} = 'own'`, window))
      .groupBy(spendAttributions.sourceSessionId)
      .orderBy(sql`sum(${spendAttributions.amountMicros}) DESC`)
      .all()
      .map((row) => ({
        sessionId: row.sessionId as SessionId,
        workstreamId: row.workstreamId,
        amountMicros: row.amountMicros,
        at: row.at,
      }));
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

  private total(where: SQL, window: SpendWindow): SpendTotal {
    const row = this.state.db
      .select({
        amountMicros: sql<number>`coalesce(sum(${spendAttributions.amountMicros}), 0)`,
        sources: sql<number>`count(*)`,
      })
      .from(spendAttributions)
      .where(this.scoped(where, window))
      .get();

    return {
      amountMicros: row?.amountMicros ?? 0,
      sources: row?.sources ?? 0,
    };
  }

  private scoped(where: SQL, window: SpendWindow): SQL {
    if (window.since === undefined) return where;
    return sql`${where} and ${spendAttributions.at} >= ${window.since}`;
  }
}
