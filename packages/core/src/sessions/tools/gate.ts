import { sessionAuthor } from "../../author.js";
import type { ClaimManager } from "../../claims/manager.js";
import type { ClaimState } from "../../claims/model.js";
import type { SessionId, WorkstreamId } from "../../ids.js";
import { toolCallAsk, type ApprovalAsk } from "../approvals/ask.js";
import { decideApproval } from "../approvals/decide.js";
import type { PiercedPreGrant, PreGrant } from "../approvals/pre-grants.js";
import type { ApprovalAuthority } from "../approvals/decide.js";
import {
  NO_TOOL_WORLD_DECLARATIONS,
  type ToolWorldDeclarations,
} from "../outside-world.js";
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
 *
 * ## Two axes, and only one of them is claims (§6.6)
 *
 * A call is answered along two independent axes, because the two questions are
 * independent:
 *
 * - **How far it writes** (`WriteIntent`) — claims territory (§3.4). One writer per
 *   path, and an extent nobody could bound raises an approval.
 * - **What it does to the world** (`ToolWorldDeclaration`) — approvals territory
 *   (§6.6, §9.2). A declared **irreversible** integration write *always* asks,
 *   whatever was pre-granted, and this is where that rule bites: an outside-world
 *   write typically writes no workspace path at all, so before this the intent-`none`
 *   shortcut allowed a merge outright. Building the ask first is what closed that.
 *
 * A pre-grant answers the *approval* question and never the claim one: a covered
 * call still goes through the claim manager, because isolation is a guarantee rather
 * than a convention (principle 4) and a pre-grant that pierced a claim would be a
 * second writer on one path.
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
   * An approval PlotRoom already holds for this call — answered from the queue
   * (§6.6). Absent means not answered, which is a denial, not a pass.
   */
  readonly approvedCallIds?: ReadonlySet<string>;
  /** Identifies this call for the approval above; adapters supply their call id. */
  readonly callId?: string;
  /**
   * What this adapter's tools do to the outside world (§9.2). Absent means nothing
   * is declared, which costs certainty about fork cleanliness (§6.3) and never
   * grants anything: an undeclared tool is still bounded by its write extent.
   */
  readonly world?: ToolWorldDeclarations;
  /** Standing decisions made in advance (§6.6). Empty is the safe default. */
  readonly preGrants?: readonly PreGrant[];
  /** Which workstream's pre-grants bind, alongside the session's own. */
  readonly workstreamId?: WorkstreamId;
}

export interface ToolGateDecision {
  readonly outcome: RequestOutcome;
  /** True when PlotRoom should raise an approval rather than only denying (§6.6). */
  readonly raisesApproval: boolean;
  /** The paths that decided it, for the transcript and the claims panel. */
  readonly paths: readonly string[];
  /**
   * What is being asked, structured — non-null whenever this was a tool call, so a
   * raise has the record's content without rebuilding it (§6.6, answerable in place).
   */
  readonly ask: ApprovalAsk | null;
  /** Set when a standing decision answered it: the log line for a silent allow. */
  readonly coveredBy: ApprovalAuthority | null;
  /** Set when a pre-grant would have covered it and irreversibility pierced it. */
  readonly piercedPreGrant: PiercedPreGrant | null;
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
      ...bare,
      outcome: {
        kind: "deny",
        reason:
          "this gate answers tool permissions; a question is answered by a human (§6.4)",
      },
    };
  }

  const intent = context.intents.intentOf(request.toolName, request.input);
  const paths = intent.kind === "paths" ? intent.paths : [];
  const ask = toolCallAsk({
    toolName: request.toolName,
    summary: summarize(request.toolName, intent),
    intent,
    world: (context.world ?? NO_TOOL_WORLD_DECLARATIONS).forTool(
      request.toolName,
    ),
  });

  const actor = sessionAuthor(context.sessionId);
  const approved =
    context.callId !== undefined &&
    context.approvedCallIds?.has(context.callId) === true;

  // §6.6, in one call: an answered approval settles it, an irreversible ask can
  // never be covered in advance, deny wins among what was, and an ask nothing
  // would have raised needs no approval at all. `decideApproval` is the only place
  // any of that is decided — the destruction path asks the same function.
  const verdict = decideApproval(ask, {
    actor,
    sessionId: context.sessionId,
    // Absent: a workstream-scoped grant matches nothing rather than everything.
    workstreamId: context.workstreamId ?? null,
    preGrants: context.preGrants ?? [],
  });

  if (verdict.kind === "denied") {
    return { ...bare, outcome: { kind: "deny", reason: verdict.reason }, ask };
  }

  if (verdict.kind === "must-ask" && !approved) {
    return {
      ...bare,
      outcome: { kind: "deny", reason: verdict.reason },
      raisesApproval: true,
      ask,
      piercedPreGrant: verdict.pierced,
    };
  }

  const coveredBy =
    verdict.kind === "allowed" && verdict.by.kind === "pre-grant"
      ? verdict.by
      : null;

  // The claim check still runs. A pre-grant answers whether an approval is needed;
  // it never answers who may write a path (principle 4).
  const denials: string[] = [];
  for (const path of paths) {
    const check = context.manager.checkWrite(context.claims, actor, path);
    if (!check.allowed) denials.push(check.refusal.message);
  }

  if (denials.length > 0) {
    return {
      ...bare,
      outcome: { kind: "deny", reason: denials.join(" ") },
      // A claim conflict is not an approval: the holder or the waitlist clears
      // it, and §3.4's own tools are how the session asks.
      paths,
      ask,
    };
  }

  return { ...bare, outcome: { kind: "allow" }, paths, ask, coveredBy };
}

const bare = {
  raisesApproval: false,
  paths: [] as readonly string[],
  ask: null,
  coveredBy: null,
  piercedPreGrant: null,
} satisfies Omit<ToolGateDecision, "outcome">;

/**
 * One line about the input, for a row the operator answers without opening the
 * session (§6.6). Built from the *declared* extent rather than from the raw input,
 * because the raw input is where a credential would be (§9.3) and a summary that
 * leaked one would leak it to every outbound notification route (§7.3).
 */
function summarize(toolName: string, intent: WriteIntent): string {
  switch (intent.kind) {
    case "none":
    case "paths":
      return toolName;
    case "unbounded":
      return `${toolName} (${intent.reason})`;
  }
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
