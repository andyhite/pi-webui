/**
 * Which canvas node has focus (§11: "every interactive surface is
 * keyboard-reachable"). xyflow renders nodes as real DOM (AGENTS.md's canvas
 * notes say so deliberately, and this is one of the reasons why): every node
 * wrapper is tabbable and carries `data-id`, so a keyboard gesture on "the
 * focused node" is a plain DOM read rather than a second selection model.
 *
 * Pure over the one method it needs, so the rule is testable without a DOM.
 */

/** The bit of `Element` this needs: `closest`, and the node's own id. */
export interface ClosestQueryable {
  closest(
    selector: string,
  ): { getAttribute(name: string): string | null } | null;
}

/** xyflow's own node wrapper class and id attribute — not ours to rename. */
export const CANVAS_NODE_SELECTOR = ".react-flow__node";

/**
 * The id of the node the focused element sits inside, or `null` when focus is
 * somewhere else entirely (a panel, the pane, the body). `null` is the honest
 * answer — a keyboard gesture with no focused node does nothing rather than
 * guessing at the route selection.
 */
export function focusedCanvasNodeId(
  focused: ClosestQueryable | null | undefined,
): string | null {
  const wrapper = focused?.closest(CANVAS_NODE_SELECTOR) ?? null;
  return wrapper?.getAttribute("data-id") ?? null;
}
