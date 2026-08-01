/**
 * Live deletion reconciliation (Phase 3 polish; the Batch 1 finding): the
 * additive sync effect only ever adds ids missing from internal xyflow
 * state, so a node or edge another client deletes never disappears from an
 * already-open canvas — the host's arrays stop naming it, but nothing ever
 * tells `current` to drop it.
 *
 * The fix cannot be "remove anything missing from the incoming arrays": a
 * just-drawn edge (`onConnect`'s optimistic local id, added to `current`
 * before the host has confirmed it under its own id) is *always* "missing"
 * from the host's arrays by that definition, and a locally deleted node
 * stays in the host's arrays too (deletion is not yet surfaced to the host —
 * Epic 3.3's recorded deferral) — either rule would misfire on one of those.
 *
 * The distinguishing fact is whether the host ever named that id at all:
 * track every id ever seen in an incoming snapshot (`confirmed`), and only
 * remove a `current` id that is *both* confirmed and now absent from the
 * incoming set. An optimistic local-only id was never confirmed, so it is
 * never a removal candidate; a locally tombstoned id is already gone from
 * `current` by the time this runs, so it is a no-op either way.
 */

export function withConfirmed(
  confirmed: ReadonlySet<string>,
  ids: readonly string[],
): Set<string> {
  if (ids.length === 0) return new Set(confirmed);
  const next = new Set(confirmed);
  for (const id of ids) next.add(id);
  return next;
}

/** Ids to drop from `current`: previously confirmed, now missing upstream. */
export function remotelyDeletedIds(
  currentIds: readonly string[],
  incomingIds: readonly string[],
  confirmed: ReadonlySet<string>,
): string[] {
  const incoming = new Set(incomingIds);
  return currentIds.filter((id) => confirmed.has(id) && !incoming.has(id));
}
