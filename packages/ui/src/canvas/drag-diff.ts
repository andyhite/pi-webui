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

/**
 * A container has no durable placement of its own yet (spec §5, §12): the
 * server has no row to write a workstream's position onto — its own
 * `defaultPosition` (`build-snapshot.ts`) is a derived default, never an
 * authored one, and there is no `PATCH .../workstreams/:id/position` the
 * way a `PlacedNode` has. Persisting one anyway sends `PATCH
 * /api/arrangement` a node id it does not recognise, which refuses the
 * *whole* batch (one transaction, §5) and loses every box node's own
 * legitimate move riding along in it — found live, via
 * `canvas-arrangement-durability.spec.ts`'s real-UI fixture: dragging a
 * bare ticket into a workstream's own extent pushed the container too, and
 * the container's id in the batch 404'd the entire write.
 *
 * The rigid-body push solver still moves a container visually, live, for
 * this session's own physics (`PlotCanvas.tsx`'s `onNodeDrag`); this is
 * strictly the write-back's own filter, applied to `diffDraggedPositions`'s
 * output right before it reaches the API.
 */
export function excludeContainers<
  T extends { readonly id: string; readonly type?: string },
>(changed: Placements, nodes: readonly T[]): Placements {
  const containerIds = new Set(
    nodes.filter((node) => node.type === "container").map((node) => node.id),
  );
  if (![...containerIds].some((id) => id in changed)) return changed;

  const persistable: Record<string, Point> = {};
  for (const [id, position] of Object.entries(changed)) {
    if (!containerIds.has(id)) persistable[id] = position;
  }
  return persistable;
}
