/**
 * Rigid-body push **inside a container** (spec §5, §3.3).
 *
 * Push itself is `solvePush` and stays there: nodes are solid rectangles,
 * pushing one pushes what it touches, and an arrangement at rest stays put.
 * One thing is different inside a container, and it is the reason this module
 * exists — the space is **bounded**. A child node is positioned relative to
 * its container and xyflow clamps it to that frame (`extent: "parent"`), so a
 * push with nowhere left to go must stop at the wall rather than shove a
 * sibling out through it.
 *
 * The clamp is xyflow's own, applied to the solver's output before it is
 * rendered or persisted, which is the whole point: a position the canvas would
 * clamp on the way to the screen must never be the position that gets written
 * down, or the arrangement that comes back after a reload is not the one the
 * operator saw settle.
 *
 * A push that runs out of room therefore leaves an overlap. That is the honest
 * outcome of a bounded space — the alternative is moving a node the drag never
 * reached, or letting a child escape its own workstream's frame — and it is
 * exactly what dragging a child into the wall already does.
 */

import type { NodeExtent, Point } from "../solver/push.js";

export interface ParentFrame {
  readonly width: number;
  readonly height: number;
}

/**
 * One position, clamped into `parent` the way xyflow clamps an `extent:
 * "parent"` child — `min(max(v, 0), frame - size)`, with no floor under the
 * upper bound (`clampPositionToParent` in `@xyflow/system`). A card wider than
 * its container really does get a negative relative coordinate there, and
 * flooring it at zero would be a *second* clamp rule that disagrees with the
 * one doing the rendering, which is the exact drift this module exists to
 * prevent. Named because both callers below must apply the identical formula.
 */
function clampPoint(
  position: Point,
  size: NodeExtent,
  parent: ParentFrame,
): Point {
  return {
    x: Math.min(Math.max(0, position.x), parent.width - size.width),
    y: Math.min(Math.max(0, position.y), parent.height - size.height),
  };
}

/**
 * The solver's **input**, with every extent moved to where the container
 * actually draws it.
 *
 * A child's stored position can sit outside its frame — a third node in one
 * workstream derives to `y = 300` inside a 280-tall container
 * (`placement/derive.ts`) — and xyflow renders it clamped without ever writing
 * the clamped value back. Solving against the stored value would then compute
 * physics for an arrangement nobody can see: no overlap reported for a pair
 * that visibly overlaps, which is §5's "solid rectangles that never overlap"
 * failing on screen. Extents are inputs only, so clamping them moves nothing.
 */
export function clampExtentsInsideParent(
  extents: readonly NodeExtent[],
  parent: ParentFrame,
): readonly NodeExtent[] {
  return extents.map((extent) => {
    const clamped = clampPoint(extent, extent, parent);
    return clamped.x === extent.x && clamped.y === extent.y
      ? extent
      : { ...extent, x: clamped.x, y: clamped.y };
  });
}

/** The solver's **output**, with every position clamped inside `parent`. */
export function clampInsideParent(
  displaced: ReadonlyMap<string, Point>,
  extents: readonly NodeExtent[],
  parent: ParentFrame,
): ReadonlyMap<string, Point> {
  const clamped = new Map<string, Point>();
  for (const [id, position] of displaced) {
    const extent = extents.find((candidate) => candidate.id === id);
    // No extent means the id is not in this gesture's own coordinate group:
    // nothing to clamp it against, so it passes through rather than being
    // guessed at.
    clamped.set(id, extent ? clampPoint(position, extent, parent) : position);
  }
  return clamped;
}
