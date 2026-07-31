/**
 * Rigid-body push solver (spec §5).
 *
 * Nodes are solid rectangles that never overlap. Pushing one pushes what it
 * touches, and the push travels through a chain. No attraction, no repulsion
 * at a distance, no continuous simulation — this is a pure function from an
 * arrangement plus one moved node to the displacements that restore
 * non-overlap. An arrangement at rest stays exactly where it is: nodes the
 * drag chain never reaches are never moved, even if they already overlap.
 */

export interface NodeExtent {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Penetration below this is treated as touching, not overlapping. */
const EPSILON = 1e-6;

/** Hard cap so a pathological arrangement terminates as best-effort. */
const MAX_PASSES = 1000;

interface Box {
  readonly id: string;
  x: number;
  y: number;
  readonly width: number;
  readonly height: number;
  /** Chain distance from the dragged node; Infinity = untouched by the drag. */
  depth: number;
}

function overlapAmount(a: Box, b: Box): { x: number; y: number } {
  return {
    x: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    y: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/** Push `mover` out of `stayer` along the axis of least penetration. */
function separate(stayer: Box, mover: Box): void {
  const overlap = overlapAmount(stayer, mover);

  if (overlap.x <= overlap.y) {
    const moverCenter = mover.x + mover.width / 2;
    const stayerCenter = stayer.x + stayer.width / 2;
    const direction = moverCenter >= stayerCenter ? 1 : -1;
    mover.x += direction * overlap.x;
  } else {
    const moverCenter = mover.y + mover.height / 2;
    const stayerCenter = stayer.y + stayer.height / 2;
    const direction = moverCenter >= stayerCenter ? 1 : -1;
    mover.y += direction * overlap.y;
  }
}

/**
 * Given every node's extent — with the dragged node already at its new
 * position — returns the new positions of every *other* node that must move
 * so no reached pair overlaps. The dragged node is never displaced (it is
 * under the cursor), and nodes outside the push chain are never displaced
 * (at rest stays put). An arrangement with no overlaps returns an empty map.
 */
export function solvePush(
  extents: readonly NodeExtent[],
  movedId: string,
): ReadonlyMap<string, Point> {
  const boxes: Box[] = extents.map((e) => ({
    id: e.id,
    x: e.x,
    y: e.y,
    width: e.width,
    height: e.height,
    depth: e.id === movedId ? 0 : Infinity,
  }));

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;

    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i] as Box;
        const b = boxes[j] as Box;

        // Only pairs reached by the drag chain participate; a pre-existing
        // overlap between two untouched nodes is left exactly as it was.
        if (a.depth === Infinity && b.depth === Infinity) continue;

        const overlap = overlapAmount(a, b);
        if (overlap.x <= EPSILON || overlap.y <= EPSILON) continue;

        // The node closer to the dragged node stays; the other is pushed.
        const [stayer, mover] = a.depth <= b.depth ? [a, b] : [b, a];
        separate(stayer, mover);
        mover.depth = Math.min(mover.depth, stayer.depth + 1);
        changed = true;
      }
    }

    if (!changed) break;
  }

  const displaced = new Map<string, Point>();
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i] as Box;
    const original = extents[i] as NodeExtent;
    if (box.id === movedId) continue;
    if (box.x !== original.x || box.y !== original.y) {
      displaced.set(box.id, { x: box.x, y: box.y });
    }
  }
  return displaced;
}
