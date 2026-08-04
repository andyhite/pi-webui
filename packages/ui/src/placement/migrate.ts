/**
 * One-time migration off the old client-only store (Epic 3.1's deferral,
 * closed): a browser that already has positions in `localStorage` from
 * before the live path adopted the server endpoints, opened against a
 * server that has never had *any* authored position, is exactly "an
 * operator's existing arrangement about to be silently discarded" — the one
 * outcome principle 12 forbids. This is the pure decision of whether that
 * push is owed; the caller (`apps/web/src/App.tsx`) does the actual
 * `setArrangement` call and, once it lands, clears the local store so nothing
 * dual-writes afterward.
 *
 * Deliberately conservative: any authored position already on the server —
 * even one, even if it is not any of these ids — means the operator has
 * already used the live arrangement, and this returns nothing further to
 * push. A second migration attempt piling old local coordinates on top of a
 * board someone has since arranged by hand would be the exact "arranging by
 * hand never costs an earlier placement" rule this whole feature exists to
 * uphold, aimed at itself.
 */

import type { Placements } from "./store.js";

export function localPlacementsToMigrate(
  local: Placements,
  serverAuthoredCount: number,
): Placements | null {
  if (serverAuthoredCount > 0) return null;
  return Object.keys(local).length > 0 ? local : null;
}
