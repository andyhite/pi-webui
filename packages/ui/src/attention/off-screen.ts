/**
 * Off-screen attention markers with clustering (spec §5, §7). Pure: given
 * node positions that want attention and the current viewport rectangle,
 * compute one marker per compass sector with a count. A node withdraws from
 * every marker the instant its position falls inside the viewport — no
 * separate "withdraw" action, just recomputing from the current viewport.
 * Fed by real attention derivation in Phase 6; this is the mechanic only.
 */

export interface ViewportRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AttentionNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

export type Sector = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export interface OffScreenMarker {
  readonly sector: Sector;
  readonly count: number;
  readonly nodeIds: readonly string[];
}

function sectorFor(node: AttentionNode, viewport: ViewportRect): Sector | null {
  const withinX = node.x >= viewport.x && node.x <= viewport.x + viewport.width;
  const withinY =
    node.y >= viewport.y && node.y <= viewport.y + viewport.height;
  if (withinX && withinY) return null;

  const dx =
    node.x < viewport.x ? -1 : node.x > viewport.x + viewport.width ? 1 : 0;
  const dy =
    node.y < viewport.y ? -1 : node.y > viewport.y + viewport.height ? 1 : 0;

  if (dx === -1 && dy === -1) return "nw";
  if (dx === 1 && dy === -1) return "ne";
  if (dx === -1 && dy === 1) return "sw";
  if (dx === 1 && dy === 1) return "se";
  if (dx === -1) return "w";
  if (dx === 1) return "e";
  if (dy === -1) return "n";
  return "s";
}

/**
 * Clusters attention-wanting nodes by which side of the viewport they sit
 * off-screen in. A node inside the viewport produces no marker at all —
 * that is the withdrawal, expressed as "not in the result" rather than as a
 * separate transition to track.
 */
export function clusterOffScreenAttention(
  nodes: readonly AttentionNode[],
  viewport: ViewportRect,
): OffScreenMarker[] {
  const bySector = new Map<Sector, string[]>();

  for (const node of nodes) {
    const sector = sectorFor(node, viewport);
    if (sector === null) continue;
    const list = bySector.get(sector) ?? [];
    list.push(node.id);
    bySector.set(sector, list);
  }

  return [...bySector.entries()].map(([sector, nodeIds]) => ({
    sector,
    count: nodeIds.length,
    nodeIds,
  }));
}
