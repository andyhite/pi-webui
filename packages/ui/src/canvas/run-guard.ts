/**
 * Guards the canvas "run" gesture against a double-click firing two
 * initiation keys (principle 9, at the gesture level). `POST /api/runs` is
 * already idempotent per initiation key server-side, but that guarantee
 * only helps once a *second* request carries the *same* key — a naive
 * double-click mints a fresh, different key per click (that is the whole
 * point of a fresh key per click, so a genuine retry is never refused as
 * "already starting"), so nothing server-side stops two clicks in the same
 * gesture from starting two runs. This is the client-side half: one
 * gesture, one key, enforced before a second POST is ever made.
 *
 * Pure, over a plain set of command-node ids currently in flight — the same
 * shape `tombstones.ts`/`reconcile.ts` already use for canvas-adjacent
 * state, so the host (`apps/web/src/App.tsx`) can hold it in ordinary React
 * state and this stays testable with no DOM/React involved.
 */

/**
 * Begins a run for `commandNodeId`. Refused (the same `inFlight` set,
 * unchanged) when one is already in flight for that node; otherwise a new
 * set with it added. The caller only ever proceeds — makes the actual
 * request — when `allowed` is true.
 */
export function beginRun(
  inFlight: ReadonlySet<string>,
  commandNodeId: string,
): { readonly inFlight: ReadonlySet<string>; readonly allowed: boolean } {
  if (inFlight.has(commandNodeId)) {
    return { inFlight, allowed: false };
  }
  const next = new Set(inFlight);
  next.add(commandNodeId);
  return { inFlight: next, allowed: true };
}

/**
 * Ends a run for `commandNodeId` once its request has settled — accepted or
 * refused, it is no longer in flight either way. A no-op (the same set,
 * unchanged) if it was not marked in flight to begin with.
 */
export function endRun(
  inFlight: ReadonlySet<string>,
  commandNodeId: string,
): ReadonlySet<string> {
  if (!inFlight.has(commandNodeId)) return inFlight;
  const next = new Set(inFlight);
  next.delete(commandNodeId);
  return next;
}
