import { and, asc, eq, isNotNull, isNull, or } from "drizzle-orm";
import {
  systemClock,
  type Approval,
  type ApprovalAsk,
  type ApprovalId,
  type ApprovalKind,
  type ApprovalWriteExtent,
  type Clock,
  type PiercedPreGrant,
  type PreGrant,
  type PreGrantId,
  type RuntimeRequestId,
  type SessionId,
  type WorkstreamId,
} from "@plotroom/core";
import type { PlotroomDatabase } from "./client.js";
import { EntityNotFound } from "./errors.js";
import {
  approvals,
  preGrants,
  type ApprovalRow,
  type PreGrantRow,
} from "./schema.js";

/**
 * Approvals and pre-grants at rest (§6.6).
 *
 * `@plotroom/core`'s `approvals/` subtree owns every rule — what is being asked,
 * who may answer, whether a standing decision covers it, and the piercing rule
 * that no pre-grant can cover an irreversible ask. This store keeps the records
 * and decides nothing: `answer()` takes the record `answerApproval` returned,
 * exactly as `QuestionStore.save` does, because a store that re-derived the
 * answer would be the second evaluator principle 8 exists to prevent.
 *
 * Two lookups matter and neither is "by session". An approval is matched by its
 * **id** or by the **call id** it blocks, because a session's approvals are not
 * interchangeable: `settlesAsk` degrades to tool-only matching for an ask with no
 * target, so answering "some approval this session has" could settle a call
 * nobody agreed to.
 */
export class ApprovalStore {
  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {}

  /**
   * Record an approval core has already built. Idempotent in the approval's own
   * id **and** in the call it blocks: a runtime that re-raises the same call finds
   * the approval already waiting rather than stacking a second row the operator
   * would have to answer twice (principle 9).
   */
  raise(approval: Approval): Approval {
    const existing =
      approval.callId === null
        ? undefined
        : this.forCall(approval.sessionId, approval.callId);
    if (existing !== undefined) return existing;

    this.state.db
      .insert(approvals)
      .values(toApprovalRow(approval))
      .onConflictDoNothing()
      .run();
    return this.get(approval.id);
  }

  /** Persist the answered record core produced. */
  answer(approval: Approval): Approval {
    const row = toApprovalRow(approval);
    this.state.db
      .update(approvals)
      .set({
        answerDecision: row.answerDecision,
        answerReason: row.answerReason,
        answerByKind: row.answerByKind,
        answeredAt: row.answeredAt,
      })
      .where(eq(approvals.id, approval.id))
      .run();
    return this.get(approval.id);
  }

  /**
   * Persist the failed-effect record core produced (§6.6).
   *
   * A write of its own rather than part of `answer()`: the answer is what the
   * operator decided and the failure is what happened afterwards, and one
   * statement writing both would make a store that could not represent the
   * ordinary case — answered, effect applied, nothing failed.
   */
  recordEffectFailure(approval: Approval): Approval {
    const row = toApprovalRow(approval);
    this.state.db
      .update(approvals)
      .set({
        effectFailureMessage: row.effectFailureMessage,
        effectFailedAt: row.effectFailedAt,
      })
      .where(eq(approvals.id, approval.id))
      .run();
    return this.get(approval.id);
  }

  get(approvalId: string): Approval {
    const found = this.find(approvalId);
    if (!found) throw new EntityNotFound("approval", approvalId);
    return found;
  }

  find(approvalId: string): Approval | undefined {
    const row = this.state.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .get();
    return row === undefined ? undefined : toApproval(row);
  }

  /** The approval blocking one adapter call, which is what the gate matches on. */
  forCall(sessionId: string, callId: string): Approval | undefined {
    const row = this.state.db
      .select()
      .from(approvals)
      .where(
        and(eq(approvals.sessionId, sessionId), eq(approvals.callId, callId)),
      )
      .get();
    return row === undefined ? undefined : toApproval(row);
  }

  forSession(sessionId: string): readonly Approval[] {
    return this.state.db
      .select()
      .from(approvals)
      .where(eq(approvals.sessionId, sessionId))
      .orderBy(asc(approvals.raisedAt))
      .all()
      .map(toApproval);
  }

  /** Everything still asking — the attention feed's own list (§7.1). */
  pending(sessionId?: string): readonly Approval[] {
    return this.state.db
      .select()
      .from(approvals)
      .where(
        sessionId === undefined
          ? isNull(approvals.answeredAt)
          : and(
              eq(approvals.sessionId, sessionId),
              isNull(approvals.answeredAt),
            ),
      )
      .orderBy(asc(approvals.raisedAt))
      .all()
      .map(toApproval);
  }

  /**
   * Answered, and the effect never happened (§7.1). Not part of `pending()`,
   * because these are answered and that list is what is still being asked; the
   * queue joins the two, and the two are what §7.1 has to show — a question, and a
   * decision that did not take effect.
   */
  effectFailures(sessionId?: string): readonly Approval[] {
    const failed = isNotNull(approvals.effectFailedAt);
    return this.state.db
      .select()
      .from(approvals)
      .where(
        sessionId === undefined
          ? failed
          : and(eq(approvals.sessionId, sessionId), failed),
      )
      .orderBy(asc(approvals.effectFailedAt))
      .all()
      .map(toApproval);
  }

  /* ------------------------------------------------------------ pre-grants */

  declarePreGrant(preGrant: PreGrant): PreGrant {
    this.state.db
      .insert(preGrants)
      .values(toPreGrantRow(preGrant))
      .onConflictDoNothing()
      .run();
    return this.preGrant(preGrant.id);
  }

  /** Withdrawn rather than deleted: "revoked" and "never granted" differ. */
  withdrawPreGrant(preGrantId: string, at: number): PreGrant {
    this.preGrant(preGrantId);
    this.state.db
      .update(preGrants)
      .set({ withdrawnAt: at })
      .where(eq(preGrants.id, preGrantId))
      .run();
    return this.preGrant(preGrantId);
  }

  preGrant(preGrantId: string): PreGrant {
    const row = this.state.db
      .select()
      .from(preGrants)
      .where(eq(preGrants.id, preGrantId))
      .get();
    if (!row) throw new EntityNotFound("pre_grant", preGrantId);
    return toPreGrant(row);
  }

  /** Every standing decision, withdrawn ones included: the operator's own list. */
  preGrantList(): readonly PreGrant[] {
    return this.state.db
      .select()
      .from(preGrants)
      .orderBy(asc(preGrants.grantedAt))
      .all()
      .map(toPreGrant);
  }

  /**
   * What binds one call: this session's grants and its workstream's, live ones
   * only. Withdrawn rows are excluded here rather than filtered by the caller,
   * because a withdrawn deny that still bit would be a prohibition nobody could
   * lift.
   */
  preGrantsFor(
    sessionId: string,
    workstreamId: string | null,
  ): readonly PreGrant[] {
    const scope =
      workstreamId === null
        ? eq(preGrants.sessionId, sessionId)
        : or(
            eq(preGrants.sessionId, sessionId),
            eq(preGrants.workstreamId, workstreamId),
          );

    return this.state.db
      .select()
      .from(preGrants)
      .where(and(scope, isNull(preGrants.withdrawnAt)))
      .orderBy(asc(preGrants.grantedAt))
      .all()
      .map(toPreGrant);
  }

  clock(): number {
    return this.now();
  }
}

function toApprovalRow(approval: Approval): ApprovalRow {
  return {
    id: approval.id,
    sessionId: approval.sessionId,
    workstreamId: approval.workstreamId,
    kind: approval.kind,
    askJson: JSON.stringify(approval.ask),
    requestId: approval.requestId,
    callId: approval.callId,
    piercedJson:
      approval.piercedPreGrant === null
        ? null
        : JSON.stringify(approval.piercedPreGrant),
    raisedAt: approval.raisedAt,
    answerDecision: approval.answer?.decision ?? null,
    answerReason: approval.answer?.reason ?? null,
    answerByKind: approval.answer === null ? null : "human",
    answeredAt: approval.answer?.at ?? null,
    effectFailureMessage: approval.effectFailure?.message ?? null,
    effectFailedAt: approval.effectFailure?.at ?? null,
  };
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id as ApprovalId,
    sessionId: row.sessionId as SessionId,
    workstreamId: row.workstreamId as WorkstreamId,
    kind: row.kind as ApprovalKind,
    ask: JSON.parse(row.askJson) as ApprovalAsk,
    requestId:
      row.requestId === null ? null : (row.requestId as RuntimeRequestId),
    callId: row.callId,
    raisedAt: row.raisedAt,
    answer:
      row.answerDecision === null || row.answeredAt === null
        ? null
        : {
            decision: row.answerDecision,
            reason: row.answerReason,
            by: { kind: "human" },
            at: row.answeredAt,
          },
    piercedPreGrant:
      row.piercedJson === null
        ? null
        : (JSON.parse(row.piercedJson) as PiercedPreGrant),
    effectFailure:
      row.effectFailureMessage === null || row.effectFailedAt === null
        ? null
        : { message: row.effectFailureMessage, at: row.effectFailedAt },
  };
}

function toPreGrantRow(preGrant: PreGrant): PreGrantRow {
  return {
    id: preGrant.id,
    scope: preGrant.scope.kind,
    sessionId:
      preGrant.scope.kind === "session" ? preGrant.scope.sessionId : null,
    workstreamId:
      preGrant.scope.kind === "workstream" ? preGrant.scope.workstreamId : null,
    effect: preGrant.effect,
    kindsJson: JSON.stringify(preGrant.kinds),
    toolPattern: preGrant.toolPattern,
    extentsJson: JSON.stringify(preGrant.extents),
    grantedBy: "human",
    grantedAt: preGrant.grantedAt,
    withdrawnAt: preGrant.withdrawnAt,
  };
}

function toPreGrant(row: PreGrantRow): PreGrant {
  return {
    id: row.id as PreGrantId,
    scope:
      row.scope === "session"
        ? { kind: "session", sessionId: row.sessionId as SessionId }
        : {
            kind: "workstream",
            workstreamId: row.workstreamId as WorkstreamId,
          },
    effect: row.effect,
    kinds: JSON.parse(row.kindsJson) as ApprovalKind[],
    toolPattern: row.toolPattern,
    extents: JSON.parse(row.extentsJson) as ApprovalWriteExtent[],
    grantedBy: { kind: "human" },
    grantedAt: row.grantedAt,
    withdrawnAt: row.withdrawnAt,
  };
}
