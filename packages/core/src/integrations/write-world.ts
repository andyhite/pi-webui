import {
  declareToolWorld,
  type ToolWorldDeclarations,
} from "../sessions/outside-world.js";
import { toolCallAsk, type ApprovalAsk } from "../sessions/approvals/ask.js";
import type { IntegrationWriteActionDeclaration } from "./types.js";

/**
 * The write-action seam onto §6.6's gate (§9.2).
 *
 * "Every integration write action declares whether it is reversible (§9.2)...
 * The same declarations are what mark where a session touched the outside world
 * (§6.3), so fork-cleanliness comes from the source of truth rather than a
 * heuristic" (`sessions/outside-world.ts`). This module is that source of truth,
 * built from a plugin's own declarations rather than invented per call site — the
 * Batch-4 external-write machinery (`decideToolPermission`, `toolCallAsk`,
 * `decideApproval`) is exactly the seam a write action plugs into, and this is
 * the plug.
 *
 * A stable, greppable tool name per (producer, action) pair, so a running
 * session's call to it and an approval raised for it agree on what they are
 * talking about — and so `deriveOutsideWorldMarkers` can name it in a fork's
 * cleanliness description without guessing.
 */
export function integrationToolName(
  producerId: string,
  actionId: string,
): string {
  return `integration:${producerId}:${actionId}`;
}

/**
 * Parse a tool name this module minted, or `null` for anything else. Used by the
 * gate wiring to recognise an integration-write call without maintaining a
 * second list of which tool names are integration actions.
 */
export function parseIntegrationToolName(
  toolName: string,
): { readonly producerId: string; readonly actionId: string } | null {
  const match = /^integration:([^:]+):(.+)$/.exec(toolName);
  if (match === null) return null;
  return { producerId: match[1] as string, actionId: match[2] as string };
}

/**
 * Build the `ToolWorldDeclarations` a write-action registry answers with —
 * `declareToolWorld` over every declared action's own reversibility, so
 * `decideToolPermission` (and, downstream, `deriveOutsideWorldMarkers`) reads
 * exactly what the plugin declared and nothing a call site guessed.
 *
 * `"unknown"` reversibility passes through unchanged: `isIrreversibleWrite`
 * already treats it as irreversible everywhere it is asked (principle 7), and
 * this function is not a second place that decides that.
 */
export function integrationToolWorldDeclarations(
  producerId: string,
  actions: readonly IntegrationWriteActionDeclaration[],
): ToolWorldDeclarations {
  const entries: Record<
    string,
    {
      kind: "outside-world";
      system: string;
      action: string;
      reversibility: IntegrationWriteActionDeclaration["reversibility"];
    }
  > = {};

  for (const action of actions) {
    entries[integrationToolName(producerId, action.id)] = {
      kind: "outside-world",
      system: action.system,
      action: action.action,
      reversibility: action.reversibility,
    };
  }

  return declareToolWorld(entries);
}

/**
 * The ask behind one write-action call (§6.6, §9.2).
 *
 * `intent: { kind: "none" }` because an integration write typically writes no
 * workspace path at all — the same fact `gate.ts`'s docstring names as the reason
 * `external-write` exists as its own trigger, distinct from a bounded workspace
 * write. Claims have nothing to say about a call to a system outside the
 * workspace; this is the approval half alone.
 */
export function integrationWriteAsk(input: {
  readonly producerId: string;
  readonly action: IntegrationWriteActionDeclaration;
  readonly summary: string;
}): ApprovalAsk {
  return toolCallAsk({
    toolName: integrationToolName(input.producerId, input.action.id),
    summary: input.summary,
    intent: { kind: "none" },
    world: {
      kind: "outside-world",
      system: input.action.system,
      action: input.action.action,
      reversibility: input.action.reversibility,
    },
  });
}
