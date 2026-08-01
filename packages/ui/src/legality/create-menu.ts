/**
 * Drag-to-empty-canvas create menu (spec §5), filtered to what that edge
 * could legally connect to. This never reimplements the legality rule — it
 * calls the same `checkConnection` predicate the mid-drag refusal and the
 * (future) API and agent tools call, against a synthetic candidate node for
 * each creatable kind.
 */

import type { GraphNode, NodeId, NodeRole } from "@plotroom/core";
import { checkConnection } from "@plotroom/core";

export interface CreateMenuOption {
  /** What the menu item creates, e.g. "ticket", "note", "document", "command". */
  readonly kind: string;
  readonly role: NodeRole;
}

/** The creatable kinds today; more land as object kinds get canvas affordances. */
export const CREATE_MENU_OPTIONS: readonly CreateMenuOption[] = [
  { kind: "ticket", role: "content" },
  { kind: "note", role: "content" },
  { kind: "document", role: "content" },
  { kind: "command", role: "command" },
];

const CANDIDATE_ID = "__create_menu_candidate__" as NodeId;

/**
 * Given the node an edge is being dragged from, returns only the menu
 * options whose role `checkConnection` accepts as a legal target. A newly
 * created session always starts running, so a "session" option (once one
 * exists) is checked as a running session.
 */
export function legalCreateMenuOptions(
  source: GraphNode,
  options: readonly CreateMenuOption[] = CREATE_MENU_OPTIONS,
): CreateMenuOption[] {
  return options.filter((option) => {
    const candidate: GraphNode = {
      id: CANDIDATE_ID,
      role: option.role,
      ...(option.role === "session" ? { running: true } : {}),
    };
    return checkConnection(source, candidate).legal;
  });
}
