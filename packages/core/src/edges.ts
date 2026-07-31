import type { EdgeId, NodeId } from "./ids.js";
import type { Author } from "./author.js";

/**
 * What a node on the graph is, for legality purposes (spec §3.7).
 *
 * "Content" is any object node — a ticket, a note, a transcript, a produced
 * output. Commands and sessions are the only things content can flow into.
 */
export type NodeRole = "content" | "command" | "session";

export interface GraphNode {
  readonly id: NodeId;
  readonly role: NodeRole;
  /** Sessions only: a running session accepts injection, a finished one does not. */
  readonly running?: boolean;
}

/**
 * Spec §3.7: provenance relationships are recorded with meaning. Only
 * transfers of context create one.
 */
export type ProvenanceKind =
  | "command_started_session"
  | "session_created_object"
  | "session_forked_from"
  | "session_handoff"
  | "session_sibling"
  | "session_delegated";

export type Edge =
  | {
      readonly id: EdgeId;
      readonly kind: "context";
      readonly from: NodeId;
      readonly to: NodeId;
      /** §15 invariant 2: never absent. */
      readonly author: Author;
      /** Assembly order of this input into its target (§3.5). */
      readonly ordinal: number;
      readonly createdAt: number;
    }
  | {
      readonly id: EdgeId;
      readonly kind: "provenance";
      readonly from: NodeId;
      readonly to: NodeId;
      readonly relation: ProvenanceKind;
      readonly createdAt: number;
    };

/** Why a proposed connection is refused. Shown mid-drag, so it must be short. */
export type ConnectionRefusal =
  | { readonly reason: "self"; readonly message: string }
  | { readonly reason: "illegal_target"; readonly message: string }
  | { readonly reason: "session_not_running"; readonly message: string }
  | { readonly reason: "source_not_content"; readonly message: string }
  | { readonly reason: "would_cycle"; readonly message: string }
  | { readonly reason: "duplicate"; readonly message: string };

export type ConnectionCheck =
  | { readonly legal: true }
  | { readonly legal: false; readonly refusal: ConnectionRefusal };

const LEGAL = { legal: true } as const;

function refuse(
  reason: ConnectionRefusal["reason"],
  message: string,
): ConnectionCheck {
  return { legal: false, refusal: { reason, message } };
}

/**
 * The legal connections, exhaustively (spec §3.7): content → command, and
 * content → running session. Nothing else.
 *
 * One function the canvas, the API, and agent tools all call — an illegal
 * connection is refused while being dragged, never after it lands (§5).
 */
export function checkConnection(
  from: GraphNode,
  to: GraphNode,
): ConnectionCheck {
  if (from.id === to.id) {
    return refuse("self", "a node cannot be its own context");
  }

  if (from.role !== "content") {
    return refuse("source_not_content", "only content can be wired as context");
  }

  switch (to.role) {
    case "command":
      return LEGAL;
    case "session":
      return to.running
        ? LEGAL
        : refuse(
            "session_not_running",
            "that session has ended; fork or re-run it instead",
          );
    case "content":
      return refuse("illegal_target", "content cannot be wired into content");
  }
}

/**
 * Spec §3.7: no cycles in command topology — a command's output cannot be,
 * transitively, its own input. Explicitly not about running sessions:
 * session ↔ session injection is legitimately bidirectional (§6.5).
 *
 * `commandInputs` maps a command node to the command nodes that produced its
 * current inputs; the caller resolves produced-output nodes back to their
 * producing command.
 */
export function wouldCycle(
  commandInputs: ReadonlyMap<NodeId, readonly NodeId[]>,
  producerCommand: NodeId,
  consumerCommand: NodeId,
): boolean {
  if (producerCommand === consumerCommand) return true;

  const seen = new Set<NodeId>();
  const stack: NodeId[] = [producerCommand];

  while (stack.length > 0) {
    const current = stack.pop() as NodeId;
    if (current === consumerCommand) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(commandInputs.get(current) ?? []));
  }

  return false;
}
