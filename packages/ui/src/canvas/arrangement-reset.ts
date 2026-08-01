/**
 * The one-shot "reset arrangement" apply step (spec §5's only automatic-
 * layout verb; Batch 2 Stage 1 review finding B1). Durable placement means
 * the additive sync effect in `PlotCanvas.tsx` seeds a node's position
 * exactly once — on mount, or when the node itself is newly added — and
 * never again reacts to `placements` changing for a node already on the
 * canvas. That is correct for every *other* placement change (a drag
 * elsewhere settling, a live snapshot updating some other node's stored
 * spot), but wrong for exactly one gesture: "reset arrangement" itself,
 * which must move every already-mounted node to its freshly derived
 * position.
 *
 * This is that gesture's pure core: given the currently mounted nodes and
 * the placements to reset to, return the array with every node's position
 * replaced by its entry in `placements`. A node `placements` has nothing to
 * say about (an id `deriveInitialArrangement` did not cover) keeps its
 * current position rather than losing it. `PlotCanvas` applies this exactly
 * once per bump of `arrangementEpoch` — a one-shot signal, never a react-to-
 * placements-changed effect (see that prop's own doc comment) — so reset
 * only ever runs on an explicit gesture, not on every unrelated snapshot.
 */

import type { Point } from "../solver/push.js";
import type { Placements } from "../placement/store.js";

export interface PositionedNode {
  readonly id: string;
  readonly position: Point;
}

export function applyArrangementReset<T extends PositionedNode>(
  nodes: readonly T[],
  placements: Placements,
): T[] {
  return nodes.map((node) => {
    const next = placements[node.id];
    if (!next) return node;
    if (node.position.x === next.x && node.position.y === next.y) {
      return node;
    }
    return { ...node, position: next };
  });
}
