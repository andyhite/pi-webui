/**
 * Roving-tabindex keyboard navigation (#102). Shared by `Menu` (vertical) and
 * `Tabs` (horizontal) — the widget wires DOM focus; this module only computes
 * the next index.
 */

export type RovingOrientation = "horizontal" | "vertical";

export type RovingKey =
  "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

/**
 * Next active index for arrow-key roving tabindex. Orientation selects which
 * arrow keys move (vertical: Up/Down; horizontal: Left/Right); Home/End always
 * jump to the first/last item. Indices wrap at both ends.
 */
export function nextRovingIndex(
  currentIndex: number,
  itemCount: number,
  key: RovingKey,
  orientation: RovingOrientation,
): number {
  if (itemCount <= 0) return 0;
  if (itemCount === 1) return 0;

  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;

  const prev = (currentIndex - 1 + itemCount) % itemCount;
  const next = (currentIndex + 1) % itemCount;

  if (orientation === "vertical") {
    if (key === "ArrowUp") return prev;
    if (key === "ArrowDown") return next;
    return currentIndex;
  }

  if (key === "ArrowLeft") return prev;
  if (key === "ArrowRight") return next;
  return currentIndex;
}

/**
 * Like `nextRovingIndex`, but skips entries whose `disabled` flag is true.
 * Home/End land on the first/last *enabled* item; arrow keys walk enabled items
 * only, wrapping through the list.
 */
export function nextRovingIndexSkippingDisabled(
  currentIndex: number,
  disabled: readonly boolean[],
  key: RovingKey,
  orientation: RovingOrientation,
): number {
  const count = disabled.length;
  if (count === 0) return 0;

  const enabledAt = (index: number): boolean => !disabled[index];

  if (key === "Home") {
    const first = disabled.findIndex((d) => !d);
    return first === -1 ? currentIndex : first;
  }
  if (key === "End") {
    for (let i = count - 1; i >= 0; i--) {
      if (enabledAt(i)) return i;
    }
    return currentIndex;
  }

  let candidate = currentIndex;
  for (let step = 0; step < count; step++) {
    candidate = nextRovingIndex(candidate, count, key, orientation);
    if (enabledAt(candidate)) return candidate;
  }
  return currentIndex;
}
