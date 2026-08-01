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
 *
 * **The parent must be in the array, not just its children.** A regression
 * once filtered `PlotCanvas`'s call site to box nodes only, before this
 * function ever ran — every contained node's `parentId` still resolved
 * (looked legitimate), but `ownPositionById` below never had an entry for
 * the container that id named, so every contained node's "absolute"
 * position silently fell back to its bare parent-relative one, offset by
 * exactly the missing container's position. `toExtentAwareNodes` is the
 * one place `PlotCanvas` builds this function's input, verbatim, so that
 * mistake cannot recur at the call site — it passes every node, container
 * and box alike, and only this function's own `hidden` filter decides what
 * drops out.
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

/** The subset of xyflow's `Node` shape this module's call-site wiring reads. */
export interface CanvasNodeLike {
  readonly id: string;
  readonly type?: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly measured?: { readonly width?: number; readonly height?: number };
  readonly parentId?: string | undefined;
  readonly hidden?: boolean | undefined;
}

export interface FallbackNodeSize {
  readonly width: number;
  readonly height: number;
}

export interface ToExtentAwareNodesOptions {
  /** Which `node.type` gets `containerSize`'s fallback instead of `boxSize`'s. */
  readonly containerType: string;
  /** Used when a node has not been measured by xyflow yet (the first frame). */
  readonly boxSize: FallbackNodeSize;
  readonly containerSize: FallbackNodeSize;
}

/**
 * The exact call-site wiring `PlotCanvas` uses to turn its live xyflow node
 * array into `computeAbsoluteScreenExtents`'s input — extracted so it is
 * tested directly, not just this module's own math. Every node is included,
 * container and box alike (see the file doc comment's "the parent must be
 * in the array" note): a caller filtering *before* calling this is exactly
 * the regression this exists to make a test failure instead of a silent
 * position bug.
 */
export function toExtentAwareNodes(
  nodes: readonly CanvasNodeLike[],
  options: ToExtentAwareNodesOptions,
): ExtentAwareNode[] {
  return nodes.map((node) => {
    const fallback =
      node.type === options.containerType
        ? options.containerSize
        : options.boxSize;
    return {
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      width: node.measured?.width ?? fallback.width,
      height: node.measured?.height ?? fallback.height,
      parentId: node.parentId,
      hidden: node.hidden,
    };
  });
}
