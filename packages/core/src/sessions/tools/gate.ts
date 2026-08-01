import { sessionAuthor } from "../../author.js";
import type { ClaimManager } from "../../claims/manager.js";
import type { ClaimState } from "../../claims/model.js";
import type { SessionId } from "../../ids.js";
import type { RequestOutcome, RuntimeRequest } from "../runtime.js";

/**
 * Where claims gate the runtime (§3.4, decision 0001's C6).
 *
 * "Sessions get tools to request, yield, and inspect [claims]" — and everything
 * *else* the runtime wants to do to a file is answered here, per call, before it
 * runs. The pi adapter's `tool_call` handler blocks until PlotRoom answers
 * (`adapters/pi/permission-gate.ts`); this is the answer.
 *
 * Fail-safe by construction: a tool whose write extent cannot be determined is
 * `unbounded`, and unbounded needs an approval. Nothing is allowed because it was
 * not recognized.
 */

export type WriteIntent =
  /** Reads, or touches nothing in the workspace. */
  | { readonly kind: "none" }
  /** Writes exactly these paths, as the tool's own input declares them. */
  | { readonly kind: "paths"; readonly paths: readonly string[] }
  /** Could write anything — a shell, an unknown tool. Requires an approval (§6.6). */
  | { readonly kind: "unbounded"; readonly reason: string };

/**
 * What a runtime's tools do, declared per adapter.
 *
 * A declaration, not an inference: an adapter states what it knows about its own
 * tool surface, and anything it does not know is `unbounded`. Guessing that an
 * unrecognized tool is read-only would be exactly the inference principle 7
 * forbids, with a corrupted workspace as the failure mode.
 */
export interface WriteIntentDeclaration {
  readonly adapterId: string;
  intentOf(toolName: string, input: unknown): WriteIntent;
}

export interface ToolGateContext {
  readonly sessionId: SessionId;
  readonly claims: ClaimState;
  readonly manager: ClaimManager;
  readonly intents: WriteIntentDeclaration;
  /**
   * An approval PlotRoom already holds for this call — pre-granted per session or
   * per workstream, or answered from the queue (§6.6). Absent means not answered,
   * which is a denial, not a pass.
   */
  readonly approvedCallIds?: ReadonlySet<string>;
  /** Identifies this call for the approval above; adapters supply their call id. */
  readonly callId?: string;
}

export interface ToolGateDecision {
  readonly outcome: RequestOutcome;
  /** True when PlotRoom should raise an approval rather than only denying (§6.6). */
  readonly raisesApproval: boolean;
  /** The paths that decided it, for the transcript and the claims panel. */
  readonly paths: readonly string[];
}

/**
 * Decide one runtime request.
 *
 * Questions (§6.4) are the human's to answer and are not this function's
 * business; it answers only tool-permission requests, and says so rather than
 * quietly allowing.
 */
export function decideToolPermission(
  request: RuntimeRequest,
  context: ToolGateContext,
): ToolGateDecision {
  if (request.kind !== "tool-permission") {
    return {
      outcome: {
        kind: "deny",
        reason:
          "this gate answers tool permissions; a question is answered by a human (§6.4)",
      },
      raisesApproval: false,
      paths: [],
    };
  }

  const intent = context.intents.intentOf(request.toolName, request.input);

  if (intent.kind === "none") {
    return { outcome: { kind: "allow" }, raisesApproval: false, paths: [] };
  }

  if (intent.kind === "unbounded") {
    const approved =
      context.callId !== undefined &&
      context.approvedCallIds?.has(context.callId) === true;
    if (approved) {
      return { outcome: { kind: "allow" }, raisesApproval: false, paths: [] };
    }
    return {
      outcome: {
        kind: "deny",
        reason: `${request.toolName} could write anywhere (${intent.reason}); PlotRoom raises an approval for it (§6.6)`,
      },
      raisesApproval: true,
      paths: [],
    };
  }

  const actor = sessionAuthor(context.sessionId);
  const denials: string[] = [];
  for (const path of intent.paths) {
    const check = context.manager.checkWrite(context.claims, actor, path);
    if (!check.allowed) denials.push(check.refusal.message);
  }

  if (denials.length > 0) {
    return {
      outcome: {
        kind: "deny",
        reason: denials.join(" "),
      },
      // A claim conflict is not an approval: the holder or the waitlist clears
      // it, and §3.4's own tools are how the session asks.
      raisesApproval: false,
      paths: intent.paths,
    };
  }

  return {
    outcome: { kind: "allow" },
    raisesApproval: false,
    paths: intent.paths,
  };
}

/**
 * A conservative declaration usable by any adapter that has not enumerated its
 * tool surface yet: everything is unbounded, so every write raises an approval.
 * Slow and correct, never wrong.
 */
export const UNKNOWN_WRITE_INTENTS: WriteIntentDeclaration = {
  adapterId: "unknown",
  intentOf: (toolName) => ({
    kind: "unbounded",
    reason: `${toolName} has no declared write extent`,
  }),
};
