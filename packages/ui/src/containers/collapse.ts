/**
 * Collapsing workstream containers (spec §3.3, §5): xyflow parent/child
 * nodes give us containment; these pure helpers decide which nodes are
 * visible and where edges into a collapsed container draw — to its frame,
 * never to a hidden inner node.
 */

export interface ContainerEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

/** Node id → id of the workstream container that contains it (or absent for top-level nodes/containers). */
export type ParentOf = ReadonlyMap<string, string>;

/**
 * The manual collapse toggle and the zoom level are two independent forces
 * that can each demand a container be collapsed (spec §5: "zoomed out: one
 * card per workstream"; §3.3: "containers collapse and expand" by gesture).
 * This combines them into the one set every other collapse helper reads:
 * a container collapses if the human collapsed it, or if `collapseAll` says
 * the zoom level does it for every container regardless of the manual
 * toggle. The manual set itself is untouched, so zooming back in restores
 * exactly what the human had chosen before zooming out.
 */
export function effectiveCollapsedContainers(
  containerIds: readonly string[],
  manuallyCollapsed: ReadonlySet<string>,
  collapseAll: boolean,
): Set<string> {
  if (collapseAll) return new Set(containerIds);
  return new Set(containerIds.filter((id) => manuallyCollapsed.has(id)));
}

/** A node collapses out of view when its container is collapsed. */
export function isNodeHidden(
  nodeId: string,
  collapsed: ReadonlySet<string>,
  parentOf: ParentOf,
): boolean {
  const parent = parentOf.get(nodeId);
  return parent !== undefined && collapsed.has(parent);
}

export function visibleNodeIds(
  allNodeIds: readonly string[],
  collapsed: ReadonlySet<string>,
  parentOf: ParentOf,
): string[] {
  return allNodeIds.filter((id) => !isNodeHidden(id, collapsed, parentOf));
}

/** An endpoint inside a collapsed container remaps to the container's frame. */
function remapEndpoint(
  nodeId: string,
  collapsed: ReadonlySet<string>,
  parentOf: ParentOf,
): string {
  const parent = parentOf.get(nodeId);
  return parent !== undefined && collapsed.has(parent) ? parent : nodeId;
}

/**
 * Remaps every edge endpoint that falls inside a collapsed container to the
 * container's frame, drops edges that collapse to a self-loop (both ends
 * land on the same frame), and dedupes parallel edges the collapse produces.
 */
export function remapEdgesForCollapse<T extends ContainerEdge>(
  edges: readonly T[],
  collapsed: ReadonlySet<string>,
  parentOf: ParentOf,
): T[] {
  const seen = new Set<string>();
  const remapped: T[] = [];

  for (const edge of edges) {
    const source = remapEndpoint(edge.source, collapsed, parentOf);
    const target = remapEndpoint(edge.target, collapsed, parentOf);
    if (source === target) continue;

    const key = `${source}->${target}`;
    if (seen.has(key)) continue;
    seen.add(key);

    remapped.push({ ...edge, source, target });
  }

  return remapped;
}
