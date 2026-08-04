/**
 * Focus trap and restore (§11: "dialogs trap and restore focus"). The rule
 * itself is pure and here; the DOM half is `use-focus-trap.ts`, which reads
 * the same `nextTrappedIndex` so a Tab and a Shift+Tab cannot be wrong in
 * different directions.
 *
 * Trapping is a cycle, not a clamp: Tab at the last focusable element returns
 * to the first, because a dialog that let Tab walk out into the page behind it
 * is not trapping anything.
 */

/** The selector for "focusable by keyboard" — one list, used by the hook. */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * The index Tab (or Shift+Tab) should land on, cycling. `-1` in — nothing
 * inside has focus yet — moves to the first element forward, and to the last
 * one backward. Returns `null` when there is nothing focusable at all, which
 * is the one case the caller must leave alone rather than guess about.
 */
export function nextTrappedIndex(
  count: number,
  current: number,
  direction: "forward" | "backward",
): number | null {
  if (count <= 0) return null;
  if (current < 0) return direction === "forward" ? 0 : count - 1;
  return direction === "forward"
    ? (current + 1) % count
    : (current - 1 + count) % count;
}
