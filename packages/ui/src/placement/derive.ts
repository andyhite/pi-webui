/**
 * Derived initial arrangement (spec §5, Epic 3.1's remaining leftover): "an
 * initial arrangement is derived from the graph's structure so a new node
 * appears somewhere sensible; reset arrangement is the only automatic-
 * layout verb, and it re-derives from structure." Pure and deterministic —
 * the same graph always derives the same positions, independent of array
 * order, so it can run both as the fallback for a node with no stored
 * placement and as the whole of "reset arrangement".
 *
 * The layout itself is a plain topological layering: a node with no
 * incoming edge is column 0; every other node's column is one past the
 * deepest predecessor's — the same idea `checkConnection`'s acyclicity
 * check already walks, just laid out left-to-right instead of refused.
 * Contained nodes are laid out the same way within their own container,
 * in the parent-relative coordinates `extent: "parent"` expects; bare
 * nodes and containers share one top-level layering pass.
 */

import type { Point } from "../solver/push.js";
import type { Placements } from "./store.js";

export interface ArrangementNode {
  readonly id: string;
  readonly containerId?: string;
}

export interface ArrangementEdge {
  readonly source: string;
  readonly target: string;
}

export interface ArrangementContainer {
  readonly id: string;
}

const COLUMN_SPACING = 220;
const ROW_SPACING = 120;
/** Contained nodes are positioned relative to their container's own frame. */
const CONTAINER_PADDING: Point = { x: 40, y: 60 };

/**
 * Longest-path layering over a DAG, bounded so a cycle (illegal for
 * commands, but this function does not assume the caller filtered one out)
 * still terminates: at most one relaxation pass per node.
 */
function layerNodes(
  ids: readonly string[],
  edges: readonly ArrangementEdge[],
): ReadonlyMap<string, number> {
  const idSet = new Set(ids);
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  const relevant = edges.filter(
    (edge) => idSet.has(edge.source) && idSet.has(edge.target),
  );

  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const edge of relevant) {
      const sourceLayer = layer.get(edge.source) ?? 0;
      const targetLayer = layer.get(edge.target) ?? 0;
      if (sourceLayer + 1 > targetLayer) {
        layer.set(edge.target, sourceLayer + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return layer;
}

function gridPositions(
  ids: readonly string[],
  edges: readonly ArrangementEdge[],
  origin: Point,
  /** Lower sorts first within a row, ahead of the id tie-break; 0 by default. */
  rowPriority: (id: string) => number = () => 0,
): Placements {
  if (ids.length === 0) return {};

  const layer = layerNodes(ids, edges);
  const byLayer = new Map<number, string[]>();
  for (const id of ids) {
    const l = layer.get(id) ?? 0;
    const bucket = byLayer.get(l) ?? [];
    bucket.push(id);
    byLayer.set(l, bucket);
  }

  const placements: Record<string, Point> = {};
  for (const [column, bucket] of byLayer) {
    // Sorted so the arrangement is deterministic regardless of the input
    // array's order: priority group first, then alphabetically within it.
    const sorted = [...bucket].sort(
      (a, b) => rowPriority(a) - rowPriority(b) || a.localeCompare(b),
    );
    sorted.forEach((id, row) => {
      placements[id] = {
        x: origin.x + column * COLUMN_SPACING,
        y: origin.y + row * ROW_SPACING,
      };
    });
  }
  return placements;
}

/** Derives positions for every node and container, purely from structure. */
export function deriveInitialArrangement(
  nodes: readonly ArrangementNode[],
  edges: readonly ArrangementEdge[],
  containers: readonly ArrangementContainer[] = [],
): Placements {
  const bareNodeIds = nodes
    .filter((node) => node.containerId === undefined)
    .map((node) => node.id);
  const containerIds = containers.map((container) => container.id);

  // Containers and bare (containerless) nodes share one top-level layout —
  // there are no edges between containers themselves, so containers always
  // land in column 0; `rowPriority` puts them ahead of bare nodes within
  // that shared column regardless of id ordering.
  const containerIdSet = new Set(containerIds);
  const topLevelPlacements = gridPositions(
    [...containerIds, ...bareNodeIds],
    edges,
    { x: 0, y: 0 },
    (id) => (containerIdSet.has(id) ? 0 : 1),
  );

  const byContainer = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.containerId === undefined) continue;
    const bucket = byContainer.get(node.containerId) ?? [];
    bucket.push(node.id);
    byContainer.set(node.containerId, bucket);
  }

  let placements: Placements = topLevelPlacements;
  for (const [, memberIds] of byContainer) {
    placements = {
      ...placements,
      ...gridPositions(memberIds, edges, CONTAINER_PADDING),
    };
  }

  return placements;
}
