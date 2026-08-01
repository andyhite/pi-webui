import {
  createPiWriteIntents,
  decideToolPermission,
  sessionAuthor,
  UNKNOWN_WRITE_INTENTS,
  type RequestOutcome,
  type RuntimeRequest,
  type SessionId,
  type ToolGateDecision,
  type WriteIntentDeclaration,
} from "@plotroom/core";
import type { SessionStore } from "@plotroom/db";
import type { ClaimService } from "../claims/service.js";
import type { Logger } from "../logging/logger.js";
import { PI_ADAPTER_ID } from "../runtime/pi.js";
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
}

export function defaultWriteIntents(): ReadonlyMap<
  string,
  WriteIntentDeclaration
> {
  return new Map<string, WriteIntentDeclaration>([
    // What pi's tools write, verified by the C6 spike; everything undeclared is
    // unbounded there too.
    [PI_ADAPTER_ID, createPiWriteIntents()],
    [SCRIPTED_ADAPTER_ID, scriptedWriteIntents()],
  ]);
}

export function createSessionGate(deps: SessionGateDeps): SessionGate {
  const intents = deps.intents ?? defaultWriteIntents();

  return {
    decide(input) {
      const session = deps.sessions.get(input.sessionId);
      const workstreamId = session.session.workstreamId;
      const declaration = intents.get(input.adapterId) ?? UNKNOWN_WRITE_INTENTS;

      const decision = decideToolPermission(input.request, {
        sessionId: input.sessionId as SessionId,
        // The live state, swept: a lapsed lease authorizes nothing (§3.4).
        claims: deps.claims.stateForGate(workstreamId),
        manager: deps.claims.claimManager,
        intents: declaration,
        callId: input.requestId,
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

      if (decision.outcome.kind === "deny") {
        deps.logger.info("a runtime write was refused", {
          sessionId: input.sessionId,
          reason: decision.outcome.reason,
          raisesApproval: decision.raisesApproval,
        });
      }

      return { ...decision, claimChecked: decision.paths.length > 0 };
    },
  };
}

/** What the gate answers a request with, for a caller that only wants that. */
export function outcomeOf(decision: SessionGateDecision): RequestOutcome {
  return decision.outcome;
}
