import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, isNull } from "drizzle-orm";
import {
  systemClock,
  type Author,
  type BroadcastActivityEntry,
  type BroadcastPlan,
  type BroadcastSend,
  type Clock,
  type DraftedHandoffBrief,
  type HandoffBrief,
  type HandoffBriefOrigin,
  type ReviewedHandoffBrief,
  type SessionBroadcastCategory,
  type SessionBroadcastScope,
  type SessionId,
  type WorkstreamId,
} from "@plotroom/core";
import type { PlotroomDatabase } from "./client.js";
import { EntityNotFound } from "./errors.js";
import {
  broadcastRecipients,
  broadcasts,
  broadcastSends,
  handoffBriefs,
  type BroadcastRow,
  type HandoffBriefRow,
} from "./schema.js";

/**
 * Broadcasts, their rate window, and handoff briefs at rest (§6.5, §6.3).
 *
 * `@plotroom/core`'s `broadcast.ts` and `handoff.ts` decide everything: who may
 * send, to what scope, how often, who pays, and — for a handoff — that only a
 * reviewed brief may be sent. This store keeps what those decisions produced.
 *
 * The rate window is a table of sends rather than a counter, because the bound is
 * "n per window" and a counter cannot answer "how many in the last hour" after a
 * restart. `checkBroadcastRate` reads this list; nothing here bounds anything.
 */
export class BroadcastStore {
  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {}

  /* ------------------------------------------------------------ broadcasts */

  /**
   * Persist one broadcast and its recipients. The content object and node are
   * already written by the caller (they are ordinary graph writes); this records
   * the send itself, so a broadcast is a thing that happened rather than n
   * injections that happen to read alike.
   */
  record(
    plan: BroadcastPlan,
    baselines: ReadonlyMap<string, number> = new Map(),
  ): void {
    this.state.db.transaction(() => {
      this.state.db
        .insert(broadcasts)
        .values({
          id: plan.broadcastId,
          origin: plan.origin,
          senderSessionId: plan.senderSessionId,
          category: plan.category,
          scopeJson: plan.scope === null ? null : JSON.stringify(plan.scope),
          targetJson: plan.target === null ? null : JSON.stringify(plan.target),
          authorKind: plan.author.kind,
          authorSession:
            plan.author.kind === "session" ? plan.author.sessionId : null,
          text: plan.text,
          objectId: plan.content.objectId,
          nodeId: plan.content.nodeId,
          at: plan.at,
        })
        .onConflictDoNothing()
        .run();

      for (const delivery of plan.deliveries) {
        this.state.db
          .insert(broadcastRecipients)
          .values({
            broadcastId: plan.broadcastId,
            sessionId: delivery.sessionId,
            workstreamId: delivery.workstreamId,
            injectionId: delivery.ledgerEntry.id,
            // What this recipient had spent before the broadcast reached it, so the
            // turn it induces can be told from the work it was already doing.
            baselineCostMicros: baselines.get(delivery.sessionId) ?? 0,
            inducedMicros: null,
          })
          .onConflictDoNothing()
          .run();
      }

      // The window only counts what a *session* sent: "the operator's own
      // broadcasts are unbounded" (§6.5).
      if (plan.origin === "session" && plan.senderSessionId !== null) {
        this.state.db
          .insert(broadcastSends)
          .values({
            id: `bsend_${plan.broadcastId}`,
            senderSessionId: plan.senderSessionId,
            at: plan.at,
          })
          .onConflictDoNothing()
          .run();
      }
    });
  }

  broadcast(broadcastId: string): BroadcastRow {
    const row = this.state.db
      .select()
      .from(broadcasts)
      .where(eq(broadcasts.id, broadcastId))
      .get();
    if (!row) throw new EntityNotFound("broadcast", broadcastId);
    return row;
  }

  found(broadcastId: string): BroadcastRow | undefined {
    return this.state.db
      .select()
      .from(broadcasts)
      .where(eq(broadcasts.id, broadcastId))
      .get();
  }

  /**
   * The sends inside a sender's window, for `checkBroadcastRate`. Bounded by
   * `since` so the query is the window rather than the whole history.
   */
  sendsSince(
    senderSessionId: string,
    sinceSeconds: number,
  ): readonly BroadcastSend[] {
    return this.state.db
      .select()
      .from(broadcastSends)
      .where(
        and(
          eq(broadcastSends.senderSessionId, senderSessionId),
          gte(broadcastSends.at, sinceSeconds),
        ),
      )
      .orderBy(asc(broadcastSends.at))
      .all()
      .map((row) => ({
        senderSessionId: row.senderSessionId as SessionId,
        at: row.at,
      }));
  }

  /**
   * §7.3's per-workstream activity, as a query over the recipient rows. Derived
   * rather than stored a second time: two tables describing one broadcast is two
   * tables that can disagree about it.
   */
  activityFor(workstreamId: string): readonly BroadcastActivityEntry[] {
    const rows = this.state.db
      .select({ broadcast: broadcasts, recipient: broadcastRecipients })
      .from(broadcastRecipients)
      .innerJoin(broadcasts, eq(broadcasts.id, broadcastRecipients.broadcastId))
      .where(eq(broadcastRecipients.workstreamId, workstreamId))
      .orderBy(desc(broadcasts.at))
      .all();

    const byBroadcast = new Map<string, BroadcastActivityEntry>();
    for (const row of rows) {
      const existing = byBroadcast.get(row.broadcast.id);
      if (existing) {
        byBroadcast.set(row.broadcast.id, {
          ...existing,
          recipientSessionIds: [
            ...existing.recipientSessionIds,
            row.recipient.sessionId as SessionId,
          ],
        });
        continue;
      }
      byBroadcast.set(row.broadcast.id, {
        workstreamId: workstreamId as WorkstreamId,
        broadcastId: row.broadcast.id,
        origin: row.broadcast.origin,
        senderSessionId:
          row.broadcast.senderSessionId === null
            ? null
            : (row.broadcast.senderSessionId as SessionId),
        category: row.broadcast.category as SessionBroadcastCategory | null,
        recipientSessionIds: [row.recipient.sessionId as SessionId],
        text: row.broadcast.text,
        at: row.broadcast.at,
      });
    }

    return [...byBroadcast.values()];
  }

  /**
   * Broadcasts this session received whose induced turn has not been charged yet
   * (§6.5, principle 2). Only session-originated ones: the operator's gesture has
   * no chain behind it, so there is nobody to charge.
   */
  unchargedFor(sessionId: string): readonly {
    readonly broadcastId: string;
    readonly senderSessionId: SessionId;
    readonly baselineCostMicros: number;
  }[] {
    return this.state.db
      .select({
        broadcastId: broadcastRecipients.broadcastId,
        senderSessionId: broadcasts.senderSessionId,
        baselineCostMicros: broadcastRecipients.baselineCostMicros,
      })
      .from(broadcastRecipients)
      .innerJoin(broadcasts, eq(broadcasts.id, broadcastRecipients.broadcastId))
      .where(
        and(
          eq(broadcastRecipients.sessionId, sessionId),
          isNull(broadcastRecipients.inducedMicros),
          eq(broadcasts.origin, "session"),
        ),
      )
      .all()
      .flatMap((row) =>
        row.senderSessionId === null
          ? []
          : [
              {
                broadcastId: row.broadcastId,
                senderSessionId: row.senderSessionId as SessionId,
                baselineCostMicros: row.baselineCostMicros,
              },
            ],
      );
  }

  /** Record what a recipient's induced turn cost. Charged once, never re-charged. */
  markInduced(
    broadcastId: string,
    sessionId: string,
    inducedMicros: number,
  ): void {
    this.state.db
      .update(broadcastRecipients)
      .set({ inducedMicros })
      .where(
        and(
          eq(broadcastRecipients.broadcastId, broadcastId),
          eq(broadcastRecipients.sessionId, sessionId),
        ),
      )
      .run();
  }

  /** Which sessions received a broadcast — what the induced spend is charged for. */
  recipientsOf(broadcastId: string): readonly SessionId[] {
    return this.state.db
      .select({ sessionId: broadcastRecipients.sessionId })
      .from(broadcastRecipients)
      .where(eq(broadcastRecipients.broadcastId, broadcastId))
      .all()
      .map((row) => row.sessionId as SessionId);
  }

  /** Every broadcast a session received, newest first — its own induced history. */
  receivedBy(sessionId: string): readonly BroadcastRow[] {
    return this.state.db
      .select({ broadcast: broadcasts })
      .from(broadcastRecipients)
      .innerJoin(broadcasts, eq(broadcasts.id, broadcastRecipients.broadcastId))
      .where(eq(broadcastRecipients.sessionId, sessionId))
      .orderBy(desc(broadcasts.at))
      .all()
      .map((row) => row.broadcast);
  }

  /** The scope a session declared, parsed — for a surface that renders it. */
  scopeOf(row: BroadcastRow): SessionBroadcastScope | null {
    return row.scopeJson === null
      ? null
      : (JSON.parse(row.scopeJson) as SessionBroadcastScope);
  }

  /* -------------------------------------------------------- handoff briefs */

  /**
   * Record a drafted brief. Drafting sends nothing (§6.3) — this row exists so the
   * operator has something to edit, and so `reviewHandoffBrief` has an id to
   * review rather than a body of text passed around.
   */
  draft(brief: DraftedHandoffBrief): DraftedHandoffBrief {
    this.state.db
      .insert(handoffBriefs)
      .values({
        id: brief.id,
        sourceSessionId: brief.sourceSessionId,
        text: brief.text,
        origin: brief.origin,
        draftedByKind: brief.draftedBy?.kind ?? null,
        draftedBySession:
          brief.draftedBy?.kind === "session"
            ? brief.draftedBy.sessionId
            : null,
        draftedAt: brief.draftedAt,
        reviewedByKind: null,
        reviewedAt: null,
        draftText: null,
        edited: null,
        sentAt: null,
      })
      .onConflictDoNothing()
      .run();
    return brief;
  }

  /**
   * Record the review. The text may have changed — the point of the step is that
   * the operator edits it — so it is written back with the review.
   */
  review(brief: ReviewedHandoffBrief): ReviewedHandoffBrief {
    this.state.db
      .update(handoffBriefs)
      .set({
        text: brief.text,
        reviewedByKind: "human",
        reviewedAt: brief.reviewedAt,
        draftText: brief.draftText,
        edited: brief.edited,
      })
      .where(eq(handoffBriefs.id, brief.id))
      .run();
    return brief;
  }

  /** Mark a brief sent, so a second send is visible rather than silent. */
  markSent(briefId: string, at: number): void {
    this.state.db
      .update(handoffBriefs)
      .set({ sentAt: at })
      .where(eq(handoffBriefs.id, briefId))
      .run();
  }

  brief(briefId: string): HandoffBriefRow {
    const row = this.state.db
      .select()
      .from(handoffBriefs)
      .where(eq(handoffBriefs.id, briefId))
      .get();
    if (!row) throw new EntityNotFound("handoff brief", briefId);
    return row;
  }

  briefsFor(sessionId: string): readonly HandoffBriefRow[] {
    return this.state.db
      .select()
      .from(handoffBriefs)
      .where(eq(handoffBriefs.sourceSessionId, sessionId))
      .orderBy(asc(handoffBriefs.draftedAt))
      .all();
  }

  /**
   * A stored brief as core's own value.
   *
   * The return type is the union on purpose: a caller that wants to *send* one has
   * to narrow it, and the only thing that accepts a `ReviewedHandoffBrief` is
   * `planHandoff`. Widening this to always claim reviewed would defeat the type
   * that enforces §6.3's order.
   */
  toBrief(row: HandoffBriefRow): HandoffBrief {
    const draftedBy: Author | null =
      row.draftedByKind === null
        ? null
        : row.draftedByKind === "session"
          ? { kind: "session", sessionId: row.draftedBySession as SessionId }
          : { kind: "human" };

    const base = {
      id: row.id,
      sourceSessionId: row.sourceSessionId as SessionId,
      text: row.text,
      origin: row.origin as HandoffBriefOrigin,
      draftedBy,
      draftedAt: row.draftedAt,
    };

    if (row.reviewedAt === null) return { ...base, state: "drafted" };
    return {
      ...base,
      state: "reviewed",
      reviewedBy: { kind: "human" },
      reviewedAt: row.reviewedAt,
      draftText: row.draftText ?? row.text,
      edited: row.edited ?? false,
    };
  }

  /** Unix seconds, for a caller that wants the store's own clock. */
  clock(): number {
    return this.now();
  }

  /** An id for a send row, when a caller needs one outside a plan. */
  newSendId(): string {
    return `bsend_${randomUUID()}`;
  }
}
