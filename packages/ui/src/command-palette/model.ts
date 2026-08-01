/**
 * The command palette (spec §11): one keyboard entry point for navigation
 * and every verb. Navigation items carry the node id they move to; the host
 * always resolves them through the same `onSelectNode` the canvas click and
 * the queue use — the one navigation primitive (§5) — so the palette is
 * never a second way to get somewhere.
 */

export interface CommandPaletteItem {
  readonly id: string;
  readonly label: string;
  readonly kind: "navigate" | "verb";
  /** Navigate items only: the node the selection-as-route primitive moves to. */
  readonly nodeId?: string;
}

/** Case-insensitive substring match over the label; empty query matches all. */
export function filterCommandPaletteItems(
  items: readonly CommandPaletteItem[],
  query: string,
): readonly CommandPaletteItem[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === "") return items;
  return items.filter((item) => item.label.toLowerCase().includes(normalized));
}
