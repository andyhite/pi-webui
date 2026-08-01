/**
 * Ordered context inputs, rearrangeable by drag (spec §3.5): edge order is
 * the order content is assembled for the agent. Pure reorder over an
 * edge's `ordinal` field so the canvas and any future assembly code agree
 * on what "order" means.
 */

export interface OrderedEdge {
  readonly id: string;
  readonly ordinal: number;
}

/**
 * Moves the edge with `edgeId` to `toIndex` among its siblings (edges
 * targeting the same command/session) and renumbers ordinals 0..n-1 so gaps
 * never accumulate. Unknown edge ids leave order unchanged but still
 * renumber, defending against ordinals drifting out of a dense sequence.
 */
export function reorderContextEdges<T extends OrderedEdge>(
  edges: readonly T[],
  edgeId: string,
  toIndex: number,
): T[] {
  const sorted = [...edges].sort((a, b) => a.ordinal - b.ordinal);
  const fromIndex = sorted.findIndex((edge) => edge.id === edgeId);

  if (fromIndex !== -1) {
    const [moved] = sorted.splice(fromIndex, 1);
    const clamped = Math.max(0, Math.min(toIndex, sorted.length));
    sorted.splice(clamped, 0, moved as T);
  }

  return sorted.map((edge, index) => ({ ...edge, ordinal: index }));
}
