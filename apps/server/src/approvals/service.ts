import {
  answerApproval,
  approvalAttention,
  approvalOutcome,
  decideDestructionByName,
  declarePreGrant,
  newApprovalId,
  newPreGrantId,
  raiseApproval,
  sessionAuthor,
  settlesAsk,
  type Approval,
  type ApprovalAsk,
  type ApprovalAttention,
  type ApprovalDecision,
  type ApprovalId,
  type ApprovalKind,
  type ApprovalWriteExtent,
  type Author,
  type DestructionRouting,
  type PiercedPreGrant,
  type PreGrant,
  type PreGrantEffect,
  type PreGrantId,
  type RuntimeRequestId,
  type SessionId,
  type WorkstreamId,
} from "@plotroom/core";
import type { DomainEvent } from "@plotroom/core";
import type { EventBus, Unsubscribe } from "../events/bus.js";
import { badRequest, notFound, refused } from "../http/errors.js";
import type { Logger } from "../logging/logger.js";
import type { ApiStores } from "../routes/api.js";
import type { SessionHub } from "../sessions/hub.js";
import { performDestruction } from "./destruction.js";

/**
 * Approvals as a service (§6.6, Epic 6.3's server half).
 *
 * Every rule is `@plotroom/core`'s: what is being asked (`ApprovalAsk`), whether
 * anything standing covers it (`decideApproval`, and its piercing rule), what an
 * answer means (`answerApproval`), and what the blocked call is told
 * (`approvalOutcome`). This wires those decisions to the three things only the
 * server has — the records, the live runtime handles, and the effects a
 * destruction approval authorizes.
 *
 * ## An approval is matched by what it blocks, never by whose it is
 *
 * `settlesAsk` compares the tool and the target, and an ask with **no** target —
 * a tool-permission or integration-write raise — therefore degrades to matching
 * on the tool alone. So nothing here ever looks an approval up "by session": the
 * gate matches by **call id**, the queue answers by **approval id**, and only a
 * destruction ask (which always names its target) is matched by target. Looking
 * one up by session would let an approved `shell` call authorize a different
 * `shell` call the operator never saw.
 *
 * ## Nothing resolves without a person
 *
 * There is no timeout, no default, and no expiry anywhere in this file. An
 * approval that timed out into "allow" would be the product spending with nobody
 * behind it (principle 2); one that timed out into "deny" would be a stalled
 * session reported as refused.
 */
export interface ApprovalServiceDeps {
  readonly stores: ApiStores;
  readonly bus: EventBus;
  readonly logger: Logger;
  readonly hub: SessionHub;
  /** Answering a claim approval settles the wait it stands for (§3.4). */
  readonly claims?: ClaimApprovalAnswerer;
}

/** The half of `ClaimService` this needs, so the two are not circular. */
export interface ClaimApprovalAnswerer {
  answerApproval(answer: {
    readonly waitId: string;
    readonly decision: "grant" | "deny";
    readonly by: Author;
  }): unknown;
  waitExists(waitId: string): boolean;
  /**
   * Whether this actor may write this path right now (§3.4). Asked again when an
   * approval is answered, because **an approval answers whether capability was
   * granted and never who may write a path** — the same rule that stops a
   * pre-grant piercing a claim (principle 4). Time passes between a raise and an
   * answer, and somebody else may hold the path by then.
   */
  checkWrite(
    workstreamId: string,
    actor: Author,
    path: string,
  ): {
    readonly allowed: boolean;
    readonly refusal?: { readonly message: string };
  };
}

export interface RaiseApprovalRequest {
  readonly sessionId: string;
  readonly workstreamId?: string;
  readonly ask: ApprovalAsk;
  readonly requestId?: string | null;
  readonly callId?: string | null;
  readonly pierced?: PiercedPreGrant | null;
}

export interface AnswerApprovalRequest {
  readonly approvalId: string;
  readonly decision: ApprovalDecision;
  readonly reason?: string | null;
  readonly actor: Author;
}

export interface AnsweredApproval {
  readonly approval: Approval;
  /** True when a blocked runtime call was told the answer. */
  readonly settled: boolean;
  /** True when approving executed the destruction it authorized. */
  readonly executed: boolean;
}

export class ApprovalService {
  constructor(private readonly deps: ApprovalServiceDeps) {}

  /**
   * Raise one, idempotently. The same call raising twice — a runtime retrying,
   * a request replayed after a reconnect — finds the approval already waiting
   * rather than asking the operator the same question twice (principle 9).
   */
  raise(request: RaiseApprovalRequest): Approval {
    const stores = this.deps.stores;
    const session = stores.sessions.get(request.sessionId);
    const workstreamId = (request.workstreamId ??
      session.session.workstreamId) as WorkstreamId;

    const raised = stores.approvals.raise(
      raiseApproval({
        id: newApprovalId(),
        sessionId: request.sessionId as SessionId,
        workstreamId,
        ask: request.ask,
        requestId: (request.requestId ?? null) as RuntimeRequestId | null,
        callId: request.callId ?? null,
        piercedPreGrant: request.pierced ?? null,
        at: stores.clock(),
      }),
    );

    this.publish(raised, "created");
    return raised;
  }

  /**
   * Answer it. Two answers only — approve **once**, or deny **with a reason** —
   * and both are `answerApproval`'s to refuse: a second answer, a session
   * answering, and a bare denial are all its refusals, not this file's.
   *
   * The order below is the whole method and each step depends on the last: record
   * the answer, act on what it authorized, then tell the blocked call. Telling the
   * runtime first would let a session proceed on a decision that had not been
   * written down.
   */
  async answer(request: AnswerApprovalRequest): Promise<AnsweredApproval> {
    const stores = this.deps.stores;
    const approval = stores.approvals.find(request.approvalId);
    if (approval === undefined) {
      throw notFound(`no approval ${request.approvalId}`);
    }

    const answered = answerApproval(approval, {
      decision: request.decision,
      reason: request.reason ?? null,
      by: request.actor,
      at: stores.clock(),
    });
    // A refusal is an answer, not a crash: `refused` carries the predicate's own
    // machine-readable reason, so "somebody already answered this" is something a
    // queue row can branch on rather than a message it has to read.
    if (!answered.ok) throw refused(answered.refusal);

    const saved = stores.approvals.answer(answered.value);
    this.publish(saved, "updated");

    const executed = this.applyAnswer(saved);
    const settled = await this.settle(saved);

    return { approval: saved, settled, executed };
  }

  pending(sessionId?: string): readonly Approval[] {
    return this.deps.stores.approvals.pending(sessionId);
  }

  forSession(sessionId: string): readonly Approval[] {
    return this.deps.stores.approvals.forSession(sessionId);
  }

  get(approvalId: string): Approval {
    const approval = this.deps.stores.approvals.find(approvalId);
    if (approval === undefined) throw notFound(`no approval ${approvalId}`);
    return approval;
  }

  /**
   * The attention rows (§7.1), wording each approval once. A claim approval whose
   * wait is gone is left out: the wait was withdrawn or granted elsewhere, so
   * there is nothing left to answer — the record stays as history rather than
   * sitting in the queue asking about something that no longer exists.
   */
  attention(): readonly { approval: Approval; attention: ApprovalAttention }[] {
    const rows: { approval: Approval; attention: ApprovalAttention }[] = [];
    for (const approval of this.pending()) {
      if (!this.stillAsking(approval)) continue;
      const attention = approvalAttention(approval);
      if (attention === null) continue;
      rows.push({ approval, attention });
    }
    return rows;
  }

  /**
   * The session's own record, or null when nothing is stored under that id. Used
   * by the destruction guard to name the workstream a pre-grant may be scoped to;
   * an unknown session is `null` rather than an error, because refusing here
   * would be this service deciding something it was not asked about.
   */
  sessionOf(sessionId: string): { readonly workstreamId: string } | null {
    try {
      return {
        workstreamId:
          this.deps.stores.sessions.get(sessionId).session.workstreamId,
      };
    } catch {
      return null;
    }
  }

  /* ---------------------------------------------------------- the gate's half */

  /** The approval blocking one adapter call, which is how the gate matches. */
  forCall(sessionId: string, callId: string): Approval | undefined {
    return this.deps.stores.approvals.forCall(sessionId, callId);
  }

  /** Live standing decisions binding this session and its workstream (§6.6). */
  preGrantsFor(
    sessionId: string,
    workstreamId: string | null,
  ): readonly PreGrant[] {
    return this.deps.stores.approvals.preGrantsFor(sessionId, workstreamId);
  }

  /* --------------------------------------------------------------- destruction */

  /**
   * Route a destructive tool call (§6.6, principle 10). The decision is core's
   * `decideDestructionByName`, handed this gesture's own approval — matched by
   * **target**, which a destruction ask always has, so an approved delete of one
   * object cannot delete another.
   */
  decideDestruction(input: {
    readonly toolName: string;
    readonly targetId: string;
    readonly actor: Author;
    readonly sessionId: string;
    readonly workstreamId: string | null;
  }): DestructionRouting {
    return decideDestructionByName(input.toolName, input.targetId, {
      actor: input.actor,
      sessionId: input.sessionId as SessionId,
      workstreamId: (input.workstreamId ?? null) as WorkstreamId | null,
      preGrants: this.preGrantsFor(input.sessionId, input.workstreamId),
      approval: this.destructionApprovalFor(
        input.sessionId,
        input.toolName,
        input.targetId,
      ),
    });
  }

  /* ---------------------------------------------------------------- pre-grants */

  declare(input: {
    readonly scope:
      | { readonly kind: "session"; readonly sessionId: string }
      | { readonly kind: "workstream"; readonly workstreamId: string };
    readonly effect: PreGrantEffect;
    readonly kinds: readonly ApprovalKind[];
    readonly toolPattern: string;
    readonly extents?: readonly ApprovalWriteExtent[];
    readonly actor: Author;
  }): PreGrant {
    const declared = declarePreGrant({
      id: newPreGrantId(),
      scope:
        input.scope.kind === "session"
          ? { kind: "session", sessionId: input.scope.sessionId as SessionId }
          : {
              kind: "workstream",
              workstreamId: input.scope.workstreamId as WorkstreamId,
            },
      effect: input.effect,
      kinds: input.kinds,
      ...(input.extents === undefined ? {} : { extents: input.extents }),
      toolPattern: input.toolPattern,
      by: input.actor,
      at: this.deps.stores.clock(),
    });
    if (!declared.ok) throw badRequest(declared.refusal.message);

    const stored = this.deps.stores.approvals.declarePreGrant(declared.value);
    this.deps.bus.publish({
      entity: "pre_grant",
      verb: "created",
      preGrant: stored,
      author: input.actor,
    });
    return stored;
  }

  withdraw(preGrantId: string, actor: Author): PreGrant {
    if (actor.kind !== "human") {
      throw badRequest(
        "a pre-grant is withdrawn by the operator; a session withdrawing one is deciding its own capability (§6.6, principle 1)",
      );
    }
    const withdrawn = this.deps.stores.approvals.withdrawPreGrant(
      preGrantId,
      this.deps.stores.clock(),
    );
    this.deps.bus.publish({
      entity: "pre_grant",
      verb: "deleted",
      preGrant: withdrawn,
      author: actor,
    });
    return withdrawn;
  }

  preGrants(): readonly PreGrant[] {
    return this.deps.stores.approvals.preGrantList();
  }

  preGrant(preGrantId: string): PreGrant {
    return this.deps.stores.approvals.preGrant(preGrantId as PreGrantId);
  }

  /* ------------------------------------------------------------ claim waits */

  /**
   * A claim wait nobody's policy covers is §6.6's approval in §3.4's clothing
   * ("`claimWaitReason` returning `approval`"), so it becomes one record here
   * rather than a second feed that happens to look alike.
   *
   * Subscribed to the event stream rather than called from `ClaimService`: the
   * fact is already published, with `blockedOnHuman` already derived by the claim
   * manager, and a second notification path would be a second place to keep the
   * derivation right.
   */
  subscribeToClaimWaits(): Unsubscribe {
    return this.deps.bus.subscribe((event: DomainEvent) => {
      if (event.entity !== "claim_wait") return;
      if (event.verb === "deleted") return;
      // Only a wait the **operator** must answer, which the claim manager has
      // already decided (`blockedOnHuman`), and only one the manager accepted: a
      // wait it refused to avoid a deadlock is not a question for anybody.
      if (!event.blockedOnHuman || event.refusal !== null) return;

      const wait = event.wait;
      try {
        this.raise({
          sessionId: wait.sessionId,
          ask: {
            kind: "claim",
            trigger: "outside-policy",
            tool: null,
            summary: `${wait.sessionId} is waiting for a write claim on ${String(wait.path)} that no standing policy covers`,
            writeExtent: "paths",
            paths: [String(wait.path)],
            world: null,
            // The wait is the target, so answering settles that wait and no
            // other — the same precision `settlesAsk` gives a destruction ask.
            target: { kind: "claim-wait", id: wait.id },
          },
        });
      } catch (error) {
        this.deps.logger.error("could not raise a claim approval", {
          waitId: wait.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  /* ------------------------------------------------------------------ internals */

  private destructionApprovalFor(
    sessionId: string,
    toolName: string,
    targetId: string,
  ): Approval | null {
    // Matched on the target, which a destruction ask always carries. This is the
    // one lookup by session that is safe, and it is safe *because* of the target
    // comparison `settlesAsk` makes — a null-target ask would match any call to
    // the same tool, which is why the gate matches those by call id instead.
    const candidates = this.deps.stores.approvals
      .forSession(sessionId)
      .filter(
        (approval) =>
          approval.kind === "destruction" &&
          approval.ask.tool === toolName &&
          approval.ask.target?.id === targetId,
      );

    // The most recent, so a fresh raise after a denial is what the next call
    // sees rather than the denial for ever.
    return candidates.at(-1) ?? null;
  }

  /** Whether this approval still has something to answer about. */
  private stillAsking(approval: Approval): boolean {
    if (approval.kind !== "claim") return true;
    const waitId = approval.ask.target?.id;
    if (waitId === undefined) return true;
    return this.deps.claims?.waitExists(waitId) ?? true;
  }

  /**
   * What an approval authorizes, once it is answered. Only an approve-once does
   * anything: a denial is feedback, and feedback changes no state (§6.6).
   */
  private applyAnswer(approval: Approval): boolean {
    if (approval.answer?.decision !== "approve-once") {
      if (approval.kind === "claim" && approval.answer !== null) {
        this.answerClaimWait(approval, "deny");
      }
      return false;
    }

    if (approval.kind === "claim") {
      this.answerClaimWait(approval, "grant");
      return true;
    }

    const target = approval.ask.target;
    if (approval.kind !== "destruction" || target === null) return false;

    // Attributed to the session that asked, not to the operator who agreed: the
    // operator authorized the gesture, the agent made it (§15-2, principle 1).
    const outcome = performDestruction(
      this.deps.stores,
      this.deps.bus,
      target.kind as never,
      target.id,
      sessionAuthor(approval.sessionId),
      // Stated, not inferred: this branch is reached only for an `approve-once`
      // answer, which is exactly what `checkDeletion` is asking about.
      { approved: true },
    );
    return outcome.changed;
  }

  private answerClaimWait(
    approval: Approval,
    decision: "grant" | "deny",
  ): void {
    const waitId = approval.ask.target?.id;
    const answerer = this.deps.claims;
    if (waitId === undefined || answerer === undefined) return;
    if (!answerer.waitExists(waitId)) return;

    try {
      answerer.answerApproval({
        waitId,
        decision,
        by: approval.answer?.by ?? { kind: "human" },
      });
    } catch (error) {
      this.deps.logger.error("could not settle a claim wait from an approval", {
        approvalId: approval.id,
        waitId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Tell the blocked runtime call. An approval raised over HTTP has none, and
   * says so rather than pretending to have settled something — the same shape
   * `SteeringService.answer` reports for a question.
   */
  private async settle(approval: Approval): Promise<boolean> {
    const outcome = this.settlingOutcome(approval);
    const live = this.deps.hub.get(approval.sessionId);
    if (approval.requestId === null || outcome === null || live === null) {
      return false;
    }

    try {
      await live.handle.respond(approval.requestId, outcome);
      return true;
    } catch (error) {
      this.deps.logger.error("a runtime would not take an approval answer", {
        sessionId: approval.sessionId,
        approvalId: approval.id,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * What the blocked call is told — the answer, and then the claim check it
   * never got.
   *
   * A `must-ask` verdict returns before `decideToolPermission`'s claim loop, so
   * for an ask that declared paths the claim question is still open when the
   * operator answers. Approving is a decision about **capability** (§6.6); it is
   * not a decision about who may write a path (§3.4), and an allow that skipped
   * the check would be a second writer on one path — the exact hole
   * `evaluatePreGrants` is kept out of (principle 4). Refusing here returns the
   * claim manager's own words, so the session is told which gate is closed.
   */
  private settlingOutcome(approval: Approval) {
    const outcome = approvalOutcome(approval);
    if (outcome === null || outcome.kind !== "allow") return outcome;

    const claims = this.deps.claims;
    if (claims === undefined || approval.ask.paths.length === 0) return outcome;

    const actor = sessionAuthor(approval.sessionId);
    for (const path of approval.ask.paths) {
      const check = claims.checkWrite(approval.workstreamId, actor, path);
      if (check.allowed) continue;
      return {
        kind: "deny" as const,
        reason:
          check.refusal?.message ??
          `the operator approved this, but ${path} is held by someone else (§3.4)`,
      };
    }

    return outcome;
  }

  private publish(approval: Approval, verb: "created" | "updated"): void {
    this.deps.bus.publish({
      entity: "approval",
      verb,
      approval,
      attention: approvalAttention(approval),
      // Raised by the session that asked; answered by the operator who did.
      author: approval.answer?.by ?? sessionAuthor(approval.sessionId),
    });
  }
}

/** Exported for the gate: whether this answered approval settles that ask. */
export function approvalSettles(approval: Approval, ask: ApprovalAsk): boolean {
  return approval.answer !== null && settlesAsk(approval, ask);
}

export type { ApprovalId };
