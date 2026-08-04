/**
 * Durable placement, the write side (spec §5, §12): a drag gesture settles
 * every node the rigid-body push chain reached, but `getNodes()` at drag-stop
 * always returns *every* node currently mounted — including every node this
 * gesture never touched. Persisting all of them every time would author a
 * position for a node nobody moved (the derived fallback, frozen in place as
 * if it were a human's choice) and would turn one drag into an
 * ever-growing write.
 *
 * This is the pure diff that keeps a drag's write to exactly what changed:
 * the dragged node itself, plus whatever it pushed. `before` is a snapshot
 * taken at the moment the gesture started (`PlotCanvas`'s own
 * `dragStartPositionsRef`); `after` is where everything sits once the drag
 * has settled.
 */

import type { Point } from "../solver/push.js";
import type { Placements } from "../placement/store.js";
import type { PositionedNode } from "./arrangement-reset.js";

export function diffDraggedPositions(
  before: ReadonlyMap<string, Point>,
  after: readonly PositionedNode[],
): Placements {
  const changed: Record<string, Point> = {};
  for (const node of after) {
    const prior = before.get(node.id);
    if (!prior || prior.x !== node.position.x || prior.y !== node.position.y) {
      changed[node.id] = { x: node.position.x, y: node.position.y };
    }
  }
  return changed;
}
