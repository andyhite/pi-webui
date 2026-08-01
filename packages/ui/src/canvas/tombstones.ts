/**
 * Tombstones for deleted canvas nodes/edges (spec §5, principle 10).
 *
 * The canvas's prop→state sync effect is additive by design: any id present
 * in the host's input arrays but missing from internal xyflow state gets
 * appended, so a gesture result (or, eventually, a live server feed) can add
 * to a running canvas without disturbing an in-progress arrangement. But the
 * host is never told about a Backspace/Delete gesture — that only mutates
 * xyflow's internal state — so a deleted id stays in the host's input array
 * forever. Without a tombstone, the very next unrelated render (a zoom
 * change, a click) finds that id "missing" from internal state and
 * re-appends it: deletion silently reverts, and if the delete is still on
 * the undo stack, Cmd+Z re-appends it a *second* time, producing a
 * duplicate id in xyflow state.
 *
 * A tombstone set closes that gap: deleted ids are recorded here, the sync
 * effect filters candidates through it before appending, and undoing the
 * delete clears the tombstone for exactly the ids it restores (so a later
 * legitimate re-add — e.g. the host truly recreating that id — isn't
 * permanently blocked either).
 */

export function addTombstones(
  tombstones: ReadonlySet<string>,
  ids: readonly string[],
): Set<string> {
  if (ids.length === 0) return new Set(tombstones);
  const next = new Set(tombstones);
  for (const id of ids) next.add(id);
  return next;
}

export function clearTombstones(
  tombstones: ReadonlySet<string>,
  ids: readonly string[],
): Set<string> {
  if (ids.length === 0) return new Set(tombstones);
  const next = new Set(tombstones);
  for (const id of ids) next.delete(id);
  return next;
}

/** Filters out any item whose id is currently tombstoned. */
export function withoutTombstoned<T extends { readonly id: string }>(
  items: readonly T[],
  tombstones: ReadonlySet<string>,
): T[] {
  if (tombstones.size === 0) return [...items];
  return items.filter((item) => !tombstones.has(item.id));
}
