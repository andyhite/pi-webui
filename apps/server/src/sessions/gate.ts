import {
  approvalOutcome,
  createOmpWriteIntents,
  decideToolPermission,
  isApproved,
  NO_TOOL_WORLD_DECLARATIONS,
  OMP_ADAPTER_ID,
  sessionAuthor,
  UNKNOWN_WRITE_INTENTS,
  type Approval,
  type ApprovalAsk,
  type PiercedPreGrant,
  type PreGrant,
  type RequestOutcome,
  type RuntimeRequest,
  type SessionId,
  type ToolGateDecision,
  type ToolWorldDeclarations,
  type WorkstreamId,
  type WriteIntentDeclaration,
} from "@plotroom/core";
import type { SessionStore } from "@plotroom/db";
import type { ClaimService } from "../claims/service.js";
import type { Logger } from "../logging/logger.js";
import {
  SCRIPTED_ADAPTER_ID,
  scriptedWriteIntents,
} from "../runtime/scripted.js";

/**
 * Where a session's writes meet its claims (§3.4, decision 0001's C6).
 *
 * "Sessions get tools to request, yield, and inspect [claims]" — and everything
 * *else* the runtime wants to do to a file is answered here, per call, before it
 * runs. `decideToolPermission` in `@plotroom/core` is the decision; the claim
 * manager is what it asks; this module is only the wiring that gives it a
 * session's real claim state and the adapter's own declaration of what its tools
 * write.
 *
 * Fail-safe by construction, inherited rather than reimplemented: an adapter with
 * no declaration gets `UNKNOWN_WRITE_INTENTS`, under which every write is
 * unbounded and therefore raises an approval instead of being allowed because
 * nobody recognized it.
 */
export interface SessionGateDecision extends ToolGateDecision {
  /** True when the decision consulted claims rather than an approval. */
  readonly claimChecked: boolean;
  /**
   * The approval this call is waiting on (§6.6). Set whenever the gate raised
   * one **or** found one already raised for this call and still unanswered —
   * which is what tells the pump to leave the request blocked rather than
   * settling it with the refusal that accompanies a raise.
   */
  readonly pendingApprovalId: string | null;
}

export interface SessionGate {
  decide(input: {
    readonly sessionId: string;
    readonly adapterId: string;
    readonly requestId: string;
    readonly request: RuntimeRequest;
  }): SessionGateDecision;
}

export interface SessionGateDeps {
  readonly claims: ClaimService;
  readonly sessions: SessionStore;
  readonly logger: Logger;
  /** Per-adapter declarations, so a new adapter registers one rather than none. */
  readonly intents?: ReadonlyMap<string, WriteIntentDeclaration>;
  /**
   * §6.6's half of the gate: the standing decisions that may answer for a call,
   * the approval already raised for it, and where a new one is recorded.
   *
   * Optional only so a test can drive the gate without it — and absent, nothing
   * is pre-granted and nothing is approved, which is the safe direction: an ask
   * that needs an answer is refused rather than allowed because there was
   * nowhere to look for one.
   */
  readonly approvals?: GateApprovals;
  /**
   * What a runtime's tools do to the outside world (§9.2, §6.3), across every
   * adapter — unlike `intents`, this is not keyed by adapter id, because a
   * declared write action's reversibility is the plugin's fact, not the
   * adapter's. Absent means nothing is declared, which is the same honest
   * default `decideToolPermission` already has (`NO_TOOL_WORLD_DECLARATIONS`):
   * it costs certainty about fork cleanliness (§6.3) and grants nothing.
   */
  readonly world?: ToolWorldDeclarations;
}

/**
 * What the gate needs from `ApprovalService`, as an interface so the two are not
 * circular — and so what the gate may do with approvals is exactly three things:
 * read the standing decisions, find the approval for **this call**, and raise one.
 *
 * The lookup is by **call id**, never by session. An ask with no target (a
 * tool-permission or integration-write raise) matches on the tool alone in
 * `settlesAsk`, so "an approval this session has for this tool" would let one
 * approved `shell` call authorize a different one the operator never saw.
 */
export interface GateApprovals {
  preGrantsFor(
    sessionId: string,
    workstreamId: string | null,
  ): readonly PreGrant[];
  forCall(sessionId: string, callId: string): Approval | undefined;
  raise(input: {
    readonly sessionId: string;
    readonly workstreamId?: string;
    readonly ask: ApprovalAsk;
    readonly requestId?: string | null;
    readonly callId?: string | null;
    readonly pierced?: PiercedPreGrant | null;
  }): Approval;
}

export function defaultWriteIntents(): ReadonlyMap<
  string,
  WriteIntentDeclaration
> {
  return new Map<string, WriteIntentDeclaration>([
    [SCRIPTED_ADAPTER_ID, scriptedWriteIntents()],
    // The omp session-host's own declaration (issue #81): a real workspace
    // path bounds to a claim, an `xd://` tool device does not, and an
    // undeclared tool is unbounded there too.
    [OMP_ADAPTER_ID, createOmpWriteIntents()],
  ]);
}

export function createSessionGate(deps: SessionGateDeps): SessionGate {
  const intents = deps.intents ?? defaultWriteIntents();

  return {
    decide(input) {
      const session = deps.sessions.get(input.sessionId);
      const workstreamId = session.session.workstreamId;
      const declaration = intents.get(input.adapterId) ?? UNKNOWN_WRITE_INTENTS;

      // The approval for **this call**, if one was already raised. Answered, it
      // is what `approvedCallIds` reports; unanswered, it is what keeps the call
      // blocked instead of raising a second row for one question.
      const raised = deps.approvals?.forCall(input.sessionId, input.requestId);
      const approvedCallIds =
        raised !== undefined && isApproved(raised)
          ? new Set([input.requestId])
          : undefined;

      const decision = decideToolPermission(input.request, {
        sessionId: input.sessionId as SessionId,
        // The live state, swept: a lapsed lease authorizes nothing (§3.4).
        claims: deps.claims.stateForGate(workstreamId),
        manager: deps.claims.claimManager,
        intents: declaration,
        callId: input.requestId,
        workstreamId: workstreamId as WorkstreamId,
        preGrants:
          deps.approvals?.preGrantsFor(input.sessionId, workstreamId) ?? [],
        world: deps.world ?? NO_TOOL_WORLD_DECLARATIONS,
        ...(approvedCallIds === undefined ? {} : { approvedCallIds }),
      });

      // An allowed, path-bounded write is recorded as a write and renews the
      // claim it was written under. This is the last point PlotRoom observes it:
      // a tool that was allowed and then failed cannot be told apart from one
      // that wrote, and over-recording is the safe direction — it stales a
      // reader that might not need to be stale, rather than leaving one falsely
      // fresh (§3.4, principle 7).
      if (decision.outcome.kind === "allow" && decision.paths.length > 0) {
        for (const path of decision.paths) {
          deps.claims.recordWrite(
            workstreamId,
            sessionAuthor(input.sessionId as SessionId),
            path,
          );
        }
      }

      // **An answered denial settles the call rather than re-asking it.**
      //
      // A re-raise of a call id whose approval was already denied would otherwise
      // take the raise branch below: `raise` is idempotent in the call id, so it
      // hands back the *denied* row, the pump reads a pending approval and leaves
      // the request open — blocked on an approval nobody can answer a second time
      // (`answerApproval` refuses one). That is a wedged session waiting on a
      // decision that has already been made. What it is owed instead is the
      // decision: the operator's own reason, carried back as the tool's result,
      // which is what §6.6 means by "deny is feedback, not failure".
      const settledDenial =
        raised !== undefined && raised.answer !== null && !isApproved(raised)
          ? approvalOutcome(raised)
          : null;

      if (settledDenial !== null) {
        deps.logger.info("a re-raised call was settled by its own denial", {
          sessionId: input.sessionId,
          requestId: input.requestId,
          approvalId: raised?.id,
        });
        return {
          ...decision,
          outcome: settledDenial,
          raisesApproval: false,
          claimChecked: decision.paths.length > 0,
          pendingApprovalId: null,
        };
      }

      // §6.6: a call the gate cannot answer **asks**, and the record outlives the
      // call it blocks. Raising is idempotent in the call id, so a runtime that
      // re-raises finds the approval already waiting rather than asking the
      // operator the same question twice (principle 9).
      let pendingApprovalId: string | null = null;
      if (decision.raisesApproval && decision.ask !== null) {
        pendingApprovalId =
          deps.approvals?.raise({
            sessionId: input.sessionId,
            workstreamId,
            ask: decision.ask,
            requestId: input.requestId,
            callId: input.requestId,
            pierced: decision.piercedPreGrant,
          }).id ?? null;
      } else if (raised !== undefined && raised.answer === null) {
        pendingApprovalId = raised.id;
      }

      if (decision.outcome.kind === "deny") {
        deps.logger.info("a runtime write was refused", {
          sessionId: input.sessionId,
          reason: decision.outcome.reason,
          raisesApproval: decision.raisesApproval,
          approvalId: pendingApprovalId,
        });
      }

      return {
        ...decision,
        claimChecked: decision.paths.length > 0,
        pendingApprovalId,
      };
    },
  };
}

/** What the gate answers a request with, for a caller that only wants that. */
export function outcomeOf(decision: SessionGateDecision): RequestOutcome {
  return decision.outcome;
}
