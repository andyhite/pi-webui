/**
 * Multi-select by marquee or modified click (spec §5), plus the contextual
 * action bar of actions that apply to the whole selection. Pure so the
 * selection math and the action filtering are testable without xyflow.
 */

import type { NodeRole } from "@plotroom/core";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface NodeBox {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Nodes whose extents intersect the marquee rectangle (any overlap qualifies). */
export function nodesInMarquee(
  nodes: readonly NodeBox[],
  rect: Rect,
): string[] {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return nodes
    .filter(
      (node) =>
        node.x < right &&
        node.x + node.width > rect.x &&
        node.y < bottom &&
        node.y + node.height > rect.y,
    )
    .map((node) => node.id);
}

export type ClickModifier = "replace" | "toggle" | "add";

/** A single node click: replace the selection, toggle, or add (shift/cmd). */
export function applySelectionClick(
  current: ReadonlySet<string>,
  nodeId: string,
  modifier: ClickModifier,
): ReadonlySet<string> {
  switch (modifier) {
    case "replace":
      return new Set([nodeId]);
    case "add": {
      const next = new Set(current);
      next.add(nodeId);
      return next;
    }
    case "toggle": {
      const next = new Set(current);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    }
  }
}

export type MarqueeModifier = "replace" | "add";

/** A completed marquee drag: replace the selection, or add to it (shift-drag). */
export function applyMarqueeSelection(
  current: ReadonlySet<string>,
  marqueeIds: readonly string[],
  modifier: MarqueeModifier,
): ReadonlySet<string> {
  if (modifier === "replace") return new Set(marqueeIds);
  const next = new Set(current);
  for (const id of marqueeIds) next.add(id);
  return next;
}

export type SelectionActionId =
  "delete" | "promote" | "wireAsContext" | "stop" | "close" | "archive";

/**
 * Which actions apply to a whole selection, by the roles present. Delete
 * always applies to any non-empty selection; role-specific actions only
 * apply when every selected node shares that role — an action bar never
 * offers something that would silently no-op on part of the selection.
 */
export function actionsForSelection(
  roles: readonly NodeRole[],
): SelectionActionId[] {
  if (roles.length === 0) return [];

  const actions: SelectionActionId[] = ["delete"];

  if (roles.every((role) => role === "content")) {
    actions.push("promote", "wireAsContext");
  } else if (roles.every((role) => role === "session")) {
    actions.push("stop", "close", "archive");
  }

  return actions;
}
