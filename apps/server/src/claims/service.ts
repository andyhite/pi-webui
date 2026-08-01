import {
  claimWaitReason,
  createClaimManager,
  systemClock,
  type Author,
  type Claim,
  type ClaimApprovalAnswer,
  type ClaimEffect,
  type ClaimForceReleaseRequest,
  type ClaimGrantRequest,
  type ClaimId,
  type ClaimInspection,
  type ClaimManager,
  type ClaimOutcome,
  type ClaimPath,
  type ClaimPolicyDeclaration,
  type ClaimPolicyId,
  type ClaimRequest,
  type ClaimState,
  type ClaimWaitId,
  type ClaimWaitMetrics,
  type ClaimWriteCheck,
  type Clock,
  type PathRead,
  type PathWrite,
  type SessionId,
  type WorkstreamId,
} from "@plotroom/core";
import type { ClaimStore } from "@plotroom/db";
import type { EventBus } from "../events/bus.js";
import { refused } from "../http/errors.js";
import { forbidden } from "../http/errors.js";
import type { Logger } from "../logging/logger.js";

/**
 * Path claims, mounted (§3.4, Epic 4.4's server half).
 *
 * The decisions are `@plotroom/core`'s `ClaimManager` and nothing else. This
 * service is the three things a pure decision function cannot be: the place the
 * state is loaded from and written back to, the place the effects become events,
 * and the place the lease is swept before anyone decides anything.
 *
 * **`expire` runs before every decision**, as the contract says: "a claim whose
 * lease ran out authorizes nothing, swept or not". The manager is lapse-aware, so
 * the sweep is not what makes a verdict correct — it is what stops a stale row
 * sitting beside a new claim on the same path, which is the shape that let a
 * granted-off-the-waitlist claim become immortal in Epic 4.4's review round.
 */
export interface ClaimServiceDeps {
  readonly claims: ClaimStore;
  readonly bus: EventBus;
  readonly logger: Logger;
  readonly clock?: Clock;
}

export interface ClaimRequestInput {
  readonly workstreamId: string;
  readonly sessionId: string;
  readonly path: string;
  readonly leaseSeconds?: number;
}

export class ClaimService {
  private readonly manager: ClaimManager;

  private readonly clock: Clock;

  constructor(private readonly deps: ClaimServiceDeps) {
    this.clock = deps.clock ?? systemClock;
    this.manager = createClaimManager({ clock: this.clock });
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * A workstream's claims begin as the operator's root claim and nothing else.
   * Idempotent: the root claim is a fact about the workstream, so asking twice
   * is asking once (principle 9).
   */
  open(workstreamId: string): ClaimState {
    const existing = this.deps.claims.claimState(workstreamId);
    if (existing.claims.length > 0) return existing;

    const opened = this.manager.open(workstreamId as WorkstreamId);
    this.deps.claims.apply(workstreamId, opened.effects);
    this.publish(workstreamId, opened.effects, { kind: "human" }, opened.state);
    return this.deps.claims.claimState(workstreamId);
  }

  /**
   * §3.4's single-writer default, at provisioning: "a workstream begins with one
   * session holding the **root claim**, and every claim is a subdivision of a
   * claim someone already holds."
   *
   * It is the *operator's* grant, because that is what makes principle 1 hold
   * rather than merely look held — the reach every downstream claim subdivides
   * came from a human. The second session in a workstream gets nothing here: it
   * asks, and the root holder's policies or the operator answer.
   *
   * Returns null when the root path is already held by a session, which is not a
   * refusal: the workstream already has its writer.
   */
  grantRootClaim(workstreamId: string, sessionId: string): Claim | null {
    const state = this.open(workstreamId);
    const held = state.claims.find(
      (claim) =>
        claim.holder.kind === "session" && claim.path.segments.length === 0,
    );
    if (held !== undefined) return null;

    const outcome = this.decide(workstreamId, { kind: "human" }, (current) =>
      this.manager.grant(current, {
        path: ".",
        to: sessionId as SessionId,
        by: { kind: "human" },
      }),
    );

    return outcome.kind === "granted" || outcome.kind === "already-held"
      ? outcome.claim
      : null;
  }

  /** Everything a session held is released when it ends (§3.4). */
  endSession(workstreamId: string, sessionId: string): void {
    this.decide(
      workstreamId,
      { kind: "session", sessionId: sessionId as SessionId },
      (state) => this.manager.endSession(state, sessionId as SessionId),
    );
  }

  /* ---------------------------------------------------------------- verbs */

  request(input: ClaimRequestInput) {
    const request: ClaimRequest = {
      sessionId: input.sessionId as SessionId,
      path: input.path,
      ...(input.leaseSeconds === undefined
        ? {}
        : { leaseSeconds: input.leaseSeconds }),
    };
    this.open(input.workstreamId);
    // Attributed to the requesting session: a claim event carries who caused it,
    // like every other event on the stream (§15-2's rule, one vocabulary).
    return this.decide(
      input.workstreamId,
      { kind: "session", sessionId: input.sessionId as SessionId },
      (state) => this.manager.request(state, request),
    );
  }

  grant(workstreamId: string, request: ClaimGrantRequest) {
    this.requireOperator(request.by, "granting a claim");
    this.open(workstreamId);
    return this.decide(workstreamId, request.by, (state) =>
      this.manager.grant(state, request),
    );
  }

  answerApproval(answer: ClaimApprovalAnswer) {
    const workstreamId = this.workstreamOfWait(answer.waitId);
    return this.decide(workstreamId, answer.by, (state) =>
      this.manager.answerApproval(state, answer),
    );
  }

  yieldClaim(claimId: string, by: Author) {
    const workstreamId = this.workstreamOfClaim(claimId);
    return this.decide(workstreamId, by, (state) =>
      this.manager.yieldClaim(state, { claimId: claimId as ClaimId, by }),
    );
  }

  forceRelease(request: ClaimForceReleaseRequest) {
    this.requireOperator(request.by, "force-releasing a claim");
    const workstreamId = this.workstreamOfClaim(request.claimId);
    return this.decide(workstreamId, request.by, (state) =>
      this.manager.forceRelease(state, request),
    );
  }

  /**
   * Is this wait still on the list? Asked by the approvals path (§6.6): a claim
   * wait no policy covers is raised as an approval, and one that was granted or
   * withdrawn some other way leaves nothing to answer — so the row stops asking
   * rather than sitting in the queue about something that no longer exists.
   */
  waitExists(waitId: string): boolean {
    return this.deps.claims.workstreamOfWait(waitId) !== undefined;
  }

  withdrawWait(waitId: string, by: Author) {
    const workstreamId = this.workstreamOfWait(waitId);
    return this.decide(workstreamId, by, (state) =>
      this.manager.withdrawWait(state, { waitId: waitId as ClaimWaitId, by }),
    );
  }

  declarePolicy(declaration: ClaimPolicyDeclaration) {
    const workstreamId = this.workstreamOfClaim(declaration.claimId);
    return this.decide(workstreamId, declaration.by, (state) =>
      this.manager.declarePolicy(state, declaration),
    );
  }

  withdrawPolicy(policyId: string, by: Author) {
    const workstreamId = this.workstreamOfPolicy(policyId);
    return this.decide(workstreamId, by, (state) =>
      this.manager.withdrawPolicy(state, {
        policyId: policyId as ClaimPolicyId,
        by,
      }),
    );
  }

  /* ---------------------------------------------------------------- reads */

  inspect(workstreamId: string, sessionId?: string): ClaimInspection {
    // Swept first: an inspection that showed a lapsed claim as held would be the
    // claims panel disagreeing with what a write would be allowed to do.
    this.sweep(workstreamId);
    const state = this.deps.claims.claimState(workstreamId);
    return this.manager.inspect(
      state,
      sessionId === undefined ? {} : { sessionId: sessionId as SessionId },
    );
  }

  waitMetrics(workstreamId: string): ClaimWaitMetrics {
    this.sweep(workstreamId);
    return this.manager.waitMetrics(this.deps.claims.claimState(workstreamId));
  }

  /* -------------------------------------------------------- the write gate */

  /**
   * Is this actor allowed to write this path? The gate's own question, answered
   * by the manager (`checkWrite`), never by this service.
   */
  checkWrite(
    workstreamId: string,
    actor: Author,
    path: string | ClaimPath,
  ): ClaimWriteCheck {
    this.sweep(workstreamId);
    return this.manager.checkWrite(
      this.deps.claims.claimState(workstreamId),
      actor,
      path,
    );
  }

  /**
   * Record an observed write, and renew the claim it was written under.
   *
   * Both halves matter: the ledger is what makes claim-precise divergence a
   * query instead of a guess (§3.4), and "a claim expires without activity and
   * is renewed by it" means a writing holder must not lose its path.
   */
  recordWrite(
    workstreamId: string,
    actor: Author,
    path: string | ClaimPath,
  ): PathWrite | null {
    const outcome = this.decideQuietly(workstreamId, actor, (state) =>
      this.manager.recordWrite(state, { actor, path }),
    );
    if (outcome === null) return null;
    return this.deps.claims.recordWrite(workstreamId, outcome.write);
  }

  /** Record an observed read, so staleness can say when the session looked. */
  recordRead(
    workstreamId: string,
    sessionId: string,
    read: PathRead,
  ): PathRead {
    return this.deps.claims.recordRead(workstreamId, sessionId, read);
  }

  /**
   * §3.6's phase input. Derived by the manager from the wait rows, so the phase
   * a card shows and the queue's blocked-on accounting cannot disagree.
   */
  isWaitingOnClaim(sessionId: string): boolean {
    const workstreamId = this.deps.claims.workstreamOfWaitingSession(sessionId);
    if (workstreamId === undefined) return false;
    return this.manager.isWaitingOnClaim(
      this.deps.claims.claimState(workstreamId),
      sessionId as SessionId,
    );
  }

  /** The claim state as stored, for a caller that wants to ask core directly. */
  state(workstreamId: string): ClaimState {
    return this.deps.claims.claimState(workstreamId);
  }

  /**
   * Swept state for the per-call permission gate.
   *
   * The gate calls `decideToolPermission`, which needs the state *and* the
   * manager, because the decision is the manager's `checkWrite` and nothing else.
   * Handing those two out is deliberate: a gate that took a boolean from here
   * would be a second implementation of the rule, and §3.4 has exactly one.
   */
  stateForGate(workstreamId: string): ClaimState {
    return this.sweep(workstreamId);
  }

  /** The decider itself, for `decideToolPermission`'s context. */
  get claimManager(): ClaimManager {
    return this.manager;
  }

  /* --------------------------------------------------------------- private */

  /**
   * Sweep lapsed leases. Every decision goes through here first, as Epic 4.4's
   * own note requires: `request` and `grant` sweep before they grant "so a stale
   * row can never sit beside a new claim".
   */
  private sweep(workstreamId: string): ClaimState {
    const state = this.deps.claims.claimState(workstreamId);
    const expired = this.manager.expire(state);
    if (!expired.ok) return state;
    if (expired.effects.length === 0) return state;

    this.deps.claims.apply(workstreamId, expired.effects);
    this.publish(
      workstreamId,
      expired.effects,
      { kind: "human" },
      expired.state,
    );
    return this.deps.claims.claimState(workstreamId);
  }

  /** Decide, persist, publish — or throw the manager's own refusal verbatim. */
  private decide<T>(
    workstreamId: string,
    author: Author,
    decision: (state: ClaimState) => ClaimOutcome<T>,
  ): T {
    const swept = this.sweep(workstreamId);
    const outcome = decision(swept);

    if (!outcome.ok) {
      // The predicate's own reason, unchanged: an agent branches on exactly the
      // value the claims panel shows (principle 8).
      throw refused(outcome.refusal);
    }

    this.deps.claims.apply(workstreamId, outcome.effects);
    this.publish(workstreamId, outcome.effects, author, outcome.state);
    return outcome.result;
  }

  /**
   * The same, for a decision whose refusal is not an answer to a request — an
   * observed write outside every claim, say. It is logged rather than thrown,
   * because the caller is a ledger, not a gesture.
   */
  private decideQuietly<T>(
    workstreamId: string,
    author: Author,
    decision: (state: ClaimState) => ClaimOutcome<T>,
  ): T | null {
    const swept = this.sweep(workstreamId);
    const outcome = decision(swept);

    if (!outcome.ok) {
      this.deps.logger.warn("a claim decision was refused", {
        workstreamId,
        reason: outcome.refusal.reason,
        message: outcome.refusal.message,
      });
      return null;
    }

    this.deps.claims.apply(workstreamId, outcome.effects);
    this.publish(workstreamId, outcome.effects, author, outcome.state);
    return outcome.result;
  }

  /**
   * Effects become events in the one vocabulary — claim, wait, and policy are
   * entities on the same stream as nodes and sessions, because "a waitlist
   * nobody can see is a new invisible stall" (§3.4) and a surface that had to
   * poll for one would be exactly that.
   */
  private publish(
    workstreamId: string,
    effects: readonly ClaimEffect[],
    author: Author,
    state: ClaimState,
  ): void {
    const metrics = this.manager.waitMetrics(state);
    const positions = new Map(
      this.manager
        .inspect(state)
        .waiting.map((view) => [view.wait.id as string, view.position]),
    );
    const refusals = new Map<string, string>();
    for (const effect of effects) {
      if (effect.kind === "deadlock-refused") {
        refusals.set(effect.wait.id, effect.message);
      }
    }

    for (const effect of effects) {
      switch (effect.kind) {
        case "claim-granted":
          this.deps.bus.publish({
            entity: "claim",
            verb: "created",
            claim: effect.claim,
            author,
          });
          break;

        case "claim-released":
          this.deps.bus.publish({
            entity: "claim",
            verb: "deleted",
            claimId: effect.claimId,
            workstreamId: workstreamId as WorkstreamId,
            reason: effect.reason,
            author,
          });
          break;

        case "claim-reattached":
        case "claim-renewed": {
          const claim = state.claims.find(
            (candidate) => candidate.id === effect.claimId,
          );
          if (claim !== undefined) {
            this.deps.bus.publish({
              entity: "claim",
              verb: "updated",
              claim,
              author,
            });
          }
          break;
        }

        case "wait-added":
        case "wait-updated":
          this.deps.bus.publish({
            entity: "claim_wait",
            verb: effect.kind === "wait-added" ? "created" : "updated",
            wait: effect.wait,
            position: positions.get(effect.wait.id) ?? 1,
            blockedOnHuman:
              metrics.waits.find((metric) => metric.waitId === effect.wait.id)
                ?.blockedOnHuman ?? claimWaitReason(effect.wait) === "approval",
            refusal: refusals.get(effect.wait.id) ?? null,
            author,
          });
          break;

        case "wait-removed":
          this.deps.bus.publish({
            entity: "claim_wait",
            verb: "deleted",
            waitId: effect.waitId,
            workstreamId: workstreamId as WorkstreamId,
            reason: effect.reason,
            author,
          });
          break;

        case "policy-declared":
          this.deps.bus.publish({
            entity: "claim_policy",
            verb: "created",
            policy: effect.policy,
            workstreamId: workstreamId as WorkstreamId,
            author,
          });
          break;

        case "policy-withdrawn":
          this.deps.bus.publish({
            entity: "claim_policy",
            verb: "deleted",
            policyId: effect.policyId,
            workstreamId: workstreamId as WorkstreamId,
            reason: effect.reason,
            author,
          });
          break;

        case "approval-required":
          // §6.6's approval is raised at request time, in parallel with the wait
          // rather than after it. The wait event above already carries the
          // blocked-on-human fact the queue renders; this is the log line that
          // says whose answer it is waiting for.
          this.deps.logger.info("a claim request needs an answer", {
            workstreamId,
            waitId: effect.wait.id,
            grantorClaimId: effect.grantorClaimId,
          });
          break;

        case "deadlock-refused":
          this.deps.logger.warn("a claim wait would deadlock", {
            workstreamId,
            waitId: effect.wait.id,
            message: effect.message,
          });
          break;
      }
    }
  }

  private requireOperator(actor: Author, gesture: string): void {
    if (actor.kind === "human") return;
    // The escape hatch is the operator's alone (§3.4). Refused, not advised —
    // and refused here as well as in the tool catalog, because an endpoint that
    // trusted the catalog would be enforcing a rule the catalog only describes.
    throw forbidden(
      `${gesture} is the operator's gesture; a session cannot make it (§3.4)`,
    );
  }

  private workstreamOfClaim(claimId: string): string {
    const workstreamId = this.deps.claims.workstreamOfClaim(claimId);
    if (workstreamId === undefined) {
      throw refused({
        reason: "no_such_claim",
        message: `no claim ${claimId}`,
      });
    }
    return workstreamId;
  }

  private workstreamOfWait(waitId: string): string {
    const workstreamId = this.deps.claims.workstreamOfWait(waitId);
    if (workstreamId === undefined) {
      throw refused({
        reason: "no_such_wait",
        message: `no claim wait ${waitId}`,
      });
    }
    return workstreamId;
  }

  private workstreamOfPolicy(policyId: string): string {
    const workstreamId = this.deps.claims.workstreamOfPolicy(policyId);
    if (workstreamId === undefined) {
      throw refused({
        reason: "no_such_claim",
        message: `no claim policy ${policyId}`,
      });
    }
    return workstreamId;
  }
}
