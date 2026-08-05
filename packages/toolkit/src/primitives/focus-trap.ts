/**
 * Focus-trap boundary computation for modal surfaces (#102, spec §11: dialogs
 * trap focus). Pure over an ordered focusable list — the `.tsx` side runs
 * `focusableElementsIn` once per keydown and passes the array here so the
 * wrap-around rules stay unit-testable without jsdom.
 */

/** Tab cycles forward; Shift+Tab cycles backward. */
export type FocusTrapDirection = "forward" | "backward";

/**
 * The next element to focus inside a trap. Wraps at both ends: Tab on the last
 * item returns the first, Shift+Tab on the first returns the last. A
 * single-element list traps to itself; an empty list returns null.
 */
export function focusTrapNext<T>(
  focusables: readonly T[],
  current: T | null | undefined,
  direction: FocusTrapDirection,
): T | null {
  if (focusables.length === 0) return null;
  if (focusables.length === 1) return focusables[0] ?? null;

  const index =
    current !== null && current !== undefined
      ? focusables.indexOf(current)
      : -1;

  if (index === -1) {
    return direction === "forward"
      ? (focusables[0] ?? null)
      : (focusables.at(-1) ?? null);
  }

  const delta = direction === "forward" ? 1 : -1;
  const nextIndex = (index + delta + focusables.length) % focusables.length;
  return focusables[nextIndex] ?? null;
}

/**
 * Selectors for elements that participate in a focus trap. Matches the usual
 * focusable set; the dialog primitive queries with this rather than baking DOM
 * knowledge into `focusTrapNext`.
 */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Reads focusables from a container in document order (browser side only). */
export function focusableElementsIn(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
}
