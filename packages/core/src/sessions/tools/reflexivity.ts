import type { Author } from "../../author.js";
import type { ProposalId } from "../../claims/ids.js";
import type { SessionId } from "../../ids.js";
import {
  ancestorsOf,
  checkAuthoring,
  type LineageIndex,
} from "../../lineage.js";
import { toolByName, type AgentTool } from "./catalog.js";

/**
 * Reflexivity enforcement for tool calls (Epic 4.5, principle 1).
 *
 * "A session may not author intent into itself, its ancestors, or its descendants
 * — it cannot wire its own inputs, grant itself capabilities, raise its own
 * budget, or route around any of this through a chain it started."
 *
 * The lineage model from Epic 1.2 is the substrate; this layer is what turns it
 * into a refusal at the one place a session acts. Two things make it enforcement
 * rather than advice:
 *
 * - the *target* is resolved to the sessions it would reach (a command node
 *   resolves to the sessions it feeds, a budget to the sessions it binds), so
 *   routing an edit through a chain the caller started is the same refusal as
 *   naming itself;
 * - a tool whose target inherently includes the author does not get a narrower
 *   check, it gets a different shape: `propose`, and a human accepts.
 */

export interface ToolTarget {
  readonly kind:
    "session" | "command" | "node" | "edge" | "workstream" | "budget" | "claim";
  readonly id: string;
}

/**
 * Which sessions a call would author into. Supplied by the caller (Track A over
 * the graph) rather than derived here: `core` states the rule, and the graph
 * answers what a node feeds.
 */
export interface ToolTargetIndex {
  sessionsAffected(target: ToolTarget): readonly SessionId[];
}

export const EMPTY_TARGET_INDEX: ToolTargetIndex = {
  sessionsAffected: () => [],
};

export interface ToolCall {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** What the call acts on, when the tool's reflexivity class needs it resolved. */
  readonly target?: ToolTarget;
}

export interface ToolCallContext {
  readonly actor: Author;
  readonly lineage: LineageIndex;
  readonly targets?: ToolTargetIndex;
}

export const TOOL_CALL_REFUSAL_REASONS = [
  "unknown_tool",
  /** Principle 1: the call would reach the caller's own initiation chain. */
  "own_chain",
  /** The operator's gesture; a session may not make it (principle 8's asymmetry). */
  "human_only",
  /** The target includes the author: propose it and let a human accept. */
  "proposal_required",
] as const;

export type ToolCallRefusalReason = (typeof TOOL_CALL_REFUSAL_REASONS)[number];

export interface ToolCallRefusal {
  readonly reason: ToolCallRefusalReason;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export type ToolCallCheck =
  | { readonly allowed: true; readonly tool: AgentTool }
  | { readonly allowed: false; readonly refusal: ToolCallRefusal };

/**
 * The gate every agent tool call passes through.
 *
 * Humans are unconstrained — they are the authority the whole system terminates
 * at. A session is refused when the tool is the operator's, when the call reaches
 * its own chain, or when the tool's target inherently includes it.
 */
export function checkToolCall(
  context: ToolCallContext,
  call: ToolCall,
): ToolCallCheck {
  const tool = toolByName(call.tool);
  if (tool === undefined) {
    return refuse("unknown_tool", `no tool named ${JSON.stringify(call.tool)}`);
  }

  if (context.actor.kind === "human") return { allowed: true, tool };

  if (tool.requires.humanOnly) {
    return refuse(
      "human_only",
      `${tool.name} is the operator's gesture; a session cannot make it`,
      { tool: tool.name },
    );
  }

  const actorSession = context.actor.sessionId;

  if (tool.requires.reflexivity === "self-proposal") {
    return refuse(
      "proposal_required",
      `${tool.name} would author into the caller itself; propose it and a human accepts (principle 1)`,
      { tool: tool.name, proposeWith: "proposal_create" },
    );
  }

  if (tool.requires.reflexivity === "none") return { allowed: true, tool };

  const targets = context.targets ?? EMPTY_TARGET_INDEX;
  const affected = call.target ? targets.sessionsAffected(call.target) : [];

  for (const affectedSession of affected) {
    const authoring = checkAuthoring(
      context.lineage,
      context.actor,
      affectedSession,
    );
    if (!authoring.allowed) {
      return refuse(
        "own_chain",
        messageFor(tool, affectedSession, actorSession),
        {
          tool: tool.name,
          targetSessionId: affectedSession,
          chain: [actorSession, ...ancestorsOf(context.lineage, actorSession)],
        },
      );
    }
  }

  return { allowed: true, tool };
}

function messageFor(
  tool: AgentTool,
  target: SessionId,
  actor: SessionId,
): string {
  const what =
    tool.requires.reflexivity === "capability"
      ? "grant capability to"
      : tool.requires.reflexivity === "budget"
        ? "raise the budget of"
        : "author context into";
  const relation =
    target === actor ? "itself" : "a session in its own initiation chain";
  return `${tool.name} would ${what} ${relation} (${target}); principle 1 refuses this, including routed through a chain it started`;
}

function refuse(
  reason: ToolCallRefusalReason,
  message: string,
  details?: Record<string, unknown>,
): ToolCallCheck {
  return {
    allowed: false,
    refusal:
      details === undefined
        ? { reason, message }
        : { reason, message, details },
  };
}

/* ------------------------------------------------------- propose and accept */

/**
 * "Where the target of authoring includes the author itself — a standing
 * instruction that applies everywhere, a default derived for its own parameters —
 * the agent **proposes and a human accepts**; a proposal is confirmed, never
 * applied silently" (principle 1).
 */
export interface ToolProposal {
  readonly id: ProposalId;
  readonly proposedBy: SessionId;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly target: ToolTarget | null;
  readonly rationale: string | null;
  readonly proposedAt: number;
  readonly state: "pending" | "accepted" | "rejected";
  readonly decidedAt: number | null;
}

export function proposeToolCall(input: {
  readonly id: ProposalId;
  readonly proposedBy: SessionId;
  readonly call: ToolCall;
  readonly rationale?: string;
  readonly at: number;
}): ToolProposal {
  return {
    id: input.id,
    proposedBy: input.proposedBy,
    tool: input.call.tool,
    input: input.call.input,
    target: input.call.target ?? null,
    rationale: input.rationale ?? null,
    proposedAt: input.at,
    state: "pending",
    decidedAt: null,
  };
}

export type ProposalDecision =
  | { readonly ok: true; readonly proposal: ToolProposal }
  | { readonly ok: false; readonly refusal: ProposalRefusal };

export interface ProposalRefusal {
  readonly reason: "human_only" | "already_decided";
  readonly message: string;
}

/**
 * Accepting is a human API call, and only a human's: a session accepting its own
 * (or a descendant's) proposal would be principle 1 with extra steps.
 */
export function decideProposal(
  proposal: ToolProposal,
  decision: "accept" | "reject",
  by: Author,
  at: number,
): ProposalDecision {
  if (by.kind !== "human") {
    return {
      ok: false,
      refusal: {
        reason: "human_only",
        message:
          "a proposal is confirmed by a human; a session accepting one applies it silently",
      },
    };
  }
  if (proposal.state !== "pending") {
    return {
      ok: false,
      refusal: {
        reason: "already_decided",
        message: `this proposal was already ${proposal.state}`,
      },
    };
  }
  return {
    ok: true,
    proposal: {
      ...proposal,
      state: decision === "accept" ? "accepted" : "rejected",
      decidedAt: at,
    },
  };
}
