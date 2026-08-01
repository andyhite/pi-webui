import { destructionAsk, type ApprovalTarget } from "./ask.js";
import {
  decideApproval,
  type ApprovalContext,
  type ApprovalVerdict,
} from "./decide.js";
import {
  isDestructionTool,
  toolByName,
  type AgentTool,
  type DestructionTargetKind,
} from "../tools/catalog.js";

/**
 * Agent-requested destruction of authored state (§6.6, principle 10).
 *
 * "Destructive gestures against authored state requested by an agent go through
 * this same channel." So a session calling `object_delete` does not delete an
 * object: it raises an approval, and the soft delete runs when the operator
 * approves it. Two things are worth being explicit about, because they look like
 * they overlap and do not:
 *
 * - **Recoverable regardless.** Principle 10 holds whoever did the deleting, so
 *   what an approval gates is not whether the state can come back — it always can
 *   (`SoftDeleteState`) — but whether the operator's arrangement gets taken apart
 *   without them. That is also why a destruction ask is *reversible* and therefore
 *   pre-grantable: §6.6's piercing rule has nothing to pierce where every gesture
 *   has an inverse.
 * - **`checkDeletion` is not this.** That predicate is the store's last line: a
 *   session-authored deletion with no approval behind it is refused there, so a
 *   call site that forgot to route through here fails closed rather than deleting.
 *   This function is the routing decision — which is what turns the refusal into an
 *   approval the operator can answer, instead of a dead end.
 *
 * Which tools are destruction-class is catalog metadata (`requires.destroys`), so
 * this needs no list of its own and a new destructive verb is covered the moment it
 * declares one.
 */

export interface DestructionRequest {
  /** The tool being called. Non-destruction tools are answered `not-destruction`. */
  readonly tool: AgentTool;
  /** The record it would remove — the `:id` path parameter, in practice. */
  readonly targetId: string;
  /** Optional one-liner for the queue row; defaults to tool + target. */
  readonly summary?: string | undefined;
}

export type DestructionRouting =
  /** Not a destruction-class tool: nothing here applies, carry on. */
  | { readonly kind: "not-destruction" }
  /**
   * Route it through §6.6. `verdict.kind` says what happens: `allowed` executes the
   * soft delete, `must-ask` raises the approval and leaves the gesture unexecuted,
   * `denied` returns the operator's reason to the session as feedback.
   */
  | {
      readonly kind: "destruction";
      readonly target: ApprovalTarget;
      readonly verdict: ApprovalVerdict;
    };

export function decideDestruction(
  request: DestructionRequest,
  context: ApprovalContext,
): DestructionRouting {
  if (!isDestructionTool(request.tool)) return { kind: "not-destruction" };

  const target: ApprovalTarget = {
    kind: request.tool.requires.destroys,
    id: request.targetId,
  };
  const ask = destructionAsk({
    toolName: request.tool.name,
    target,
    summary: request.summary,
  });

  return { kind: "destruction", target, verdict: decideApproval(ask, context) };
}

/**
 * The same decision from a tool *name*, which is the shape a runtime call arrives
 * in. An unknown name is `not-destruction`, and deliberately not a refusal: this
 * function answers "does §6.6 apply", and whether a tool exists at all is the
 * bridge's question, answered where a typo can be reported as a typo.
 */
export function decideDestructionByName(
  toolName: string,
  targetId: string,
  context: ApprovalContext,
  summary?: string,
): DestructionRouting {
  const tool = toolByName(toolName);
  if (tool === undefined) return { kind: "not-destruction" };
  return decideDestruction({ tool, targetId, summary }, context);
}

/** What a destruction routing would remove, for a log line or a queue row. */
export function describeDestruction(
  kind: DestructionTargetKind,
  targetId: string,
): string {
  return `remove ${kind} ${targetId} (recoverable; principle 10)`;
}
