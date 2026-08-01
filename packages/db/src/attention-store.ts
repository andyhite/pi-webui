import { and, asc, eq, inArray } from "drizzle-orm";
import {
  systemClock,
  type Author,
  type Clock,
  type NotificationRoute,
  type NotificationRouteHealth,
  type SessionId,
  type TriageLedger,
  type TriageRecord,
  type TriageVerb,
  type VersionId,
} from "@plotroom/core";
import type { AttentionState } from "@plotroom/core";
import type { PlotroomDatabase } from "./client.js";
import { EntityNotFound } from "./errors.js";
import {
  attentionTriage,
  notificationRouteFires,
  notificationRoutes,
  type AttentionTriageRow,
  type NotificationRouteRow,
} from "./schema.js";

/**
 * Triage and outbound routes at rest (§4.5, §7.3).
 *
 * The triage half is `@plotroom/core`'s `TriageLedger` durable: one row per
 * (item, consumer), keyed by the attention item's own stable id, so a mute
 * survives a restart and a snooze survives one too — a snooze held in memory
 * would come back the moment the server did, which is the failure "bring it back
 * later" exists to avoid.
 *
 * The routes half keeps §7.3's edge-trigger honest across restarts for the same
 * reason: what a route has already sent has to be a fact somewhere, or a reboot
 * re-notifies every open item at once.
 */
export const OPERATOR_CONSUMER = "operator";

export class AttentionStore {
  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {}

  /** The whole ledger for one consumer, in core's own shape. */
  ledger(consumer: string = OPERATOR_CONSUMER): TriageLedger {
    const rows = this.state.db
      .select()
      .from(attentionTriage)
      .where(eq(attentionTriage.consumer, consumer))
      .all();

    return new Map(rows.map((row) => [row.itemId, toTriageRecord(row)]));
  }

  record(
    itemId: string,
    consumer: string = OPERATOR_CONSUMER,
  ): TriageRecord | undefined {
    const row = this.state.db
      .select()
      .from(attentionTriage)
      .where(
        and(
          eq(attentionTriage.itemId, itemId),
          eq(attentionTriage.consumer, consumer),
        ),
      )
      .get();
    return row === undefined ? undefined : toTriageRecord(row);
  }

  /**
   * Apply one triage verb. Replaced rather than appended, because the ledger
   * answers "what is the state of this item now" and a history of verbs would
   * make the answer a fold nobody needs — the events already carry the history.
   */
  triage(input: {
    readonly itemId: string;
    readonly consumer?: string;
    readonly verb: TriageVerb;
    readonly at: number;
    readonly by: Author;
    readonly baselineVersionId?: VersionId | null;
    readonly snoozedUntil?: number | null;
  }): TriageRecord {
    const consumer = input.consumer ?? OPERATOR_CONSUMER;
    const row: AttentionTriageRow = {
      itemId: input.itemId,
      consumer,
      verb: input.verb,
      at: input.at,
      byKind: input.by.kind,
      bySession: input.by.kind === "session" ? input.by.sessionId : null,
      baselineVersionId:
        input.verb === "acknowledge" ? (input.baselineVersionId ?? null) : null,
      snoozedUntil:
        input.verb === "snooze" ? (input.snoozedUntil ?? null) : null,
    };

    this.state.db
      .insert(attentionTriage)
      .values(row)
      .onConflictDoUpdate({
        target: [attentionTriage.itemId, attentionTriage.consumer],
        set: {
          verb: row.verb,
          at: row.at,
          byKind: row.byKind,
          bySession: row.bySession,
          baselineVersionId: row.baselineVersionId,
          snoozedUntil: row.snoozedUntil,
        },
      })
      .run();

    return toTriageRecord(row);
  }

  /** Undo a triage decision — a mute you regret is recoverable like anything else. */
  clearTriage(itemId: string, consumer: string = OPERATOR_CONSUMER): void {
    this.state.db
      .delete(attentionTriage)
      .where(
        and(
          eq(attentionTriage.itemId, itemId),
          eq(attentionTriage.consumer, consumer),
        ),
      )
      .run();
  }

  /* ------------------------------------------------------- outbound routes */

  routes(): readonly NotificationRoute[] {
    return this.state.db
      .select()
      .from(notificationRoutes)
      .orderBy(asc(notificationRoutes.createdAt))
      .all()
      .map(toRoute);
  }

  route(routeId: string): NotificationRoute {
    const row = this.state.db
      .select()
      .from(notificationRoutes)
      .where(eq(notificationRoutes.id, routeId))
      .get();
    if (!row) throw new EntityNotFound("notification_route", routeId);
    return toRoute(row);
  }

  createRoute(input: {
    readonly id: string;
    readonly name: string;
    readonly state: AttentionState;
    readonly url: string;
    readonly enabled: boolean;
    readonly at: number;
  }): NotificationRoute {
    this.state.db
      .insert(notificationRoutes)
      .values({
        id: input.id,
        name: input.name,
        state: input.state,
        destinationKind: "webhook",
        destinationUrl: input.url,
        enabled: input.enabled,
        createdAt: input.at,
        updatedAt: input.at,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureReason: null,
        consecutiveFailures: 0,
      })
      .onConflictDoNothing()
      .run();
    return this.route(input.id);
  }

  updateRoute(
    routeId: string,
    changes: {
      readonly name?: string;
      readonly state?: AttentionState;
      readonly url?: string;
      readonly enabled?: boolean;
      readonly at: number;
    },
  ): NotificationRoute {
    this.route(routeId);
    this.state.db
      .update(notificationRoutes)
      .set({
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.state === undefined ? {} : { state: changes.state }),
        ...(changes.url === undefined ? {} : { destinationUrl: changes.url }),
        ...(changes.enabled === undefined ? {} : { enabled: changes.enabled }),
        updatedAt: changes.at,
      })
      .where(eq(notificationRoutes.id, routeId))
      .run();
    return this.route(routeId);
  }

  deleteRoute(routeId: string): void {
    this.route(routeId);
    this.state.db
      .delete(notificationRoutes)
      .where(eq(notificationRoutes.id, routeId))
      .run();
  }

  /**
   * Record what a delivery attempt did. A failure is a column, never an
   * exception: an unreachable webhook must not be able to stop the derivation
   * that feeds it (§7.3).
   */
  recordDelivery(
    routeId: string,
    result:
      { readonly ok: true } | { readonly ok: false; readonly reason: string },
    at: number,
  ): NotificationRoute {
    const current = this.route(routeId);
    this.state.db
      .update(notificationRoutes)
      .set(
        result.ok
          ? {
              lastAttemptAt: at,
              lastSuccessAt: at,
              consecutiveFailures: 0,
              lastFailureReason: null,
            }
          : {
              lastAttemptAt: at,
              lastFailureAt: at,
              lastFailureReason: result.reason,
              consecutiveFailures: current.health.consecutiveFailures + 1,
            },
      )
      .where(eq(notificationRoutes.id, routeId))
      .run();
    return this.route(routeId);
  }

  /** What this route has already sent and is still visible (§7.3's edge trigger). */
  firedItems(routeId: string): ReadonlySet<string> {
    return new Set(
      this.state.db
        .select()
        .from(notificationRouteFires)
        .where(eq(notificationRouteFires.routeId, routeId))
        .all()
        .map((row) => row.itemId),
    );
  }

  /**
   * Replace what a route has fired with the set that is still visible. Removing
   * the rest is what lets a genuinely new occurrence of the same item notify
   * again, and keeping the rest is what stops a re-derivation re-firing.
   */
  saveFired(routeId: string, itemIds: ReadonlySet<string>, at: number): void {
    const keep = [...itemIds];
    const existing = this.state.db
      .select()
      .from(notificationRouteFires)
      .where(eq(notificationRouteFires.routeId, routeId))
      .all();

    const gone = existing
      .filter((row) => !itemIds.has(row.itemId))
      .map((row) => row.itemId);

    if (gone.length > 0) {
      this.state.db
        .delete(notificationRouteFires)
        .where(
          and(
            eq(notificationRouteFires.routeId, routeId),
            inArray(notificationRouteFires.itemId, gone),
          ),
        )
        .run();
    }

    for (const itemId of keep) {
      this.state.db
        .insert(notificationRouteFires)
        .values({ routeId, itemId, firedAt: at })
        .onConflictDoNothing()
        .run();
    }
  }

  clock(): number {
    return this.now();
  }
}

function toTriageRecord(row: AttentionTriageRow): TriageRecord {
  return {
    verb: row.verb,
    at: row.at,
    by:
      row.byKind === "human"
        ? { kind: "human" }
        : { kind: "session", sessionId: (row.bySession ?? "") as SessionId },
    baselineVersionId:
      row.baselineVersionId === null
        ? null
        : (row.baselineVersionId as VersionId),
    snoozedUntil: row.snoozedUntil,
  };
}

function toRoute(row: NotificationRouteRow): NotificationRoute {
  const health: NotificationRouteHealth = {
    lastAttemptAt: row.lastAttemptAt,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    lastFailureReason: row.lastFailureReason,
    consecutiveFailures: row.consecutiveFailures,
  };

  return {
    id: row.id,
    name: row.name,
    state: row.state,
    destination: { kind: "webhook", url: row.destinationUrl },
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    health,
  };
}
