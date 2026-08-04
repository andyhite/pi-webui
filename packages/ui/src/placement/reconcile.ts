/**
 * Durable placement, the read/reconcile side (spec §5, §12): the server is
 * the source of truth for where a node sits, and every snapshot the live
 * `GraphDataSource` delivers carries every node's *authored* position —
 * `null` meaning "nothing authored", which a derived initial arrangement
 * fills in (never this module's business). A snapshot arrives on every
 * board change, not only a placement one, so folding it into the host's own
 * sparse `Placements` has to be a genuine diff: an id whose authored
 * position now differs from what the canvas already shows is a real change
 * (another tab's drag, a reset elsewhere) and belongs in the result; an id
 * already showing exactly that position — including this same client's own
 * optimistic write, echoed back — changes nothing and must not report a
 * change, or every snapshot would needlessly re-apply positions to already-
 * settled nodes.
 */

import type { Point } from "../solver/push.js";
import type { Placements } from "./store.js";

export interface ReconcileResult {
  /** The folded placements: unchanged (`===` to `current`) when nothing moved. */
  readonly placements: Placements;
  /** True when at least one id's authored position actually changed. */
  readonly changed: boolean;
}

export function reconcileAuthoredPlacements(
  current: Placements,
  authored: ReadonlyMap<string, Point | null>,
): ReconcileResult {
  let changed = false;
  const next: Record<string, Point> = { ...current };

  for (const [id, position] of authored) {
    const existing = current[id];
    if (position === null) {
      // No authored position server-side (never authored, or a reset
      // cleared it): a locally-held entry for this id is now stale and must
      // be dropped so the derived fallback decides again — an id this
      // client never had an explicit entry for changes nothing.
      if (existing !== undefined) {
        delete next[id];
        changed = true;
      }
      continue;
    }
    if (!existing || existing.x !== position.x || existing.y !== position.y) {
      next[id] = position;
      changed = true;
    }
  }

  return changed
    ? { placements: next, changed }
    : { placements: current, changed: false };
}
