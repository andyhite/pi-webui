/**
 * Absolute (screen-space) node extents for the bubble layer (spec §5).
 *
 * `bubbles/placement.ts` needs one rect per node currently visible on
 * screen, in the same coordinate space `PlotCanvas` computes its reserved
 * regions in (a minimap's rect is screen-anchored, not flow-anchored). A
 * top-level node's xyflow `position` already is that node's own position;
 * a *contained* (workstream-child) node's `position` is parent-relative,
 * per xyflow's own model for `parentId`/`extent: "parent"` nodes — reading
 * it as absolute would place every bubble on a contained session or
 * command at the wrong spot, or (as this module replaces) skip it
 * entirely. Containers in this canvas are always top-level — a workstream
 * frame never nests inside another (§3.3) — so a child's absolute position
 * is exactly its parent's own position plus its own parent-relative one;
 * no recursive walk is needed.
 *
 * A node hidden by container collapse (`PlotCanvas`'s `hidden` flag) is
 * excluded: nothing is drawn for it, so nothing should be computed for it
 * either — a bubble "attached" to an invisible node would be exactly the
 * kind of position that looks attached but isn't.
 */

import type { NodeExtent } from "../solver/push.js";

export interface ExtentAwareNode {
  readonly id: string;
  /** This node's own xyflow position — parent-relative for a contained node, absolute otherwise. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly parentId?: string | undefined;
  readonly hidden?: boolean | undefined;
}

export interface ViewportTransform {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/**
 * Every visible node's screen-space extent, contained ones resolved to
 * their absolute canvas position first. A node naming a `parentId` that
 * is not itself in `nodes` (should not happen — containers are always
 * passed alongside their children — but this is a pure function, not a
 * place to assume its caller never errs) is treated as having no parent
 * offset, rather than throwing.
 */
export function computeAbsoluteScreenExtents(
  nodes: readonly ExtentAwareNode[],
  viewport: ViewportTransform,
): NodeExtent[] {
  const ownPositionById = new Map(
    nodes.map((node) => [node.id, { x: node.x, y: node.y }]),
  );

  return nodes
    .filter((node) => !node.hidden)
    .map((node) => {
      const parentPosition = node.parentId
        ? ownPositionById.get(node.parentId)
        : undefined;
      const absoluteX = (parentPosition?.x ?? 0) + node.x;
      const absoluteY = (parentPosition?.y ?? 0) + node.y;
      return {
        id: node.id,
        x: absoluteX * viewport.zoom + viewport.x,
        y: absoluteY * viewport.zoom + viewport.y,
        width: node.width * viewport.zoom,
        height: node.height * viewport.zoom,
      };
    });
}
