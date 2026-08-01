/**
 * "One derivation, many surfaces" (§7): the header indicator, the window
 * title, and the application badge are three renderings of the exact same
 * count. Kept as three one-line pure functions rather than three
 * hand-written strings at three call sites, so a fourth surface (or a
 * fourth test) reads the same rule instead of copying it.
 */

import type { AttentionItem } from "./types.js";

/** The header indicator's own number \u2014 every surface below is derived from this one count. */
export function attentionCount(visible: readonly AttentionItem[]): number {
  return visible.length;
}

/** `"PlotRoom"` unadorned when clear, `"(3) PlotRoom"` otherwise \u2014 never a bare number with no base title. */
export function deriveWindowTitle(baseTitle: string, count: number): string {
  return count > 0 ? `(${count}) ${baseTitle}` : baseTitle;
}

/**
 * `app.setBadgeCount`'s own contract (0 clears the badge on every platform
 * that supports one) \u2014 stated here so the desktop main process and any
 * test of it read the same rule rather than passing `attentionCount`
 * straight through and hoping 0-means-clear stays true by accident.
 */
export function deriveBadgeCount(count: number): number {
  return Math.max(0, count);
}
