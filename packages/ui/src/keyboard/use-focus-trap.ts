/**
 * The DOM half of the focus trap (§11: "dialogs trap and restore focus").
 * Every modal surface in this package uses this one hook — the command
 * palette, the shortcuts overlay, the canvas's create menu, a stop
 * confirmation — so "traps focus" means the same thing in all of them.
 *
 * Three behaviours, all of them what "trap and restore" actually requires:
 *
 *   1. On open, focus moves inside (the first focusable element, or the
 *      container itself when it has none yet).
 *   2. Tab and Shift+Tab cycle within the container (`nextTrappedIndex`) and
 *      never reach the page behind it.
 *   3. On close, focus returns to whatever had it when the dialog opened —
 *      restored to the element, not merely to the document, so the keyboard
 *      lands back where the gesture started.
 *
 * `data-key-scope="dialog"` belongs on the same container (`scope.ts`): the
 * trap keeps focus in, and the scope keeps the global verbs from firing
 * while it is open.
 */

import { useEffect, useRef } from "react";

import { FOCUSABLE_SELECTOR, nextTrappedIndex } from "./focus-trap.js";

export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
): React.RefObject<T | null> {
  const containerRef = useRef<T | null>(null);
  const restoreToRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    restoreToRef.current = document.activeElement;

    const focusables = (): readonly HTMLElement[] => [
      ...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ];

    const first = focusables()[0];
    if (first) {
      first.focus();
    } else {
      // A dialog with nothing focusable in it still must not leave focus
      // outside: the container itself takes it (callers give it tabIndex -1).
      container.focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = focusables();
      const index = elements.findIndex(
        (element) => element === document.activeElement,
      );
      const next = nextTrappedIndex(
        elements.length,
        index,
        event.shiftKey ? "backward" : "forward",
      );
      if (next === null) return;
      event.preventDefault();
      elements[next]?.focus();
    };

    // Capture, so the cycle applies before anything inside the dialog sees
    // the Tab — a listbox row's own handler must not move focus out first.
    container.addEventListener("keydown", onKeyDown, true);
    return () => {
      container.removeEventListener("keydown", onKeyDown, true);
      const restoreTo = restoreToRef.current;
      restoreToRef.current = null;
      if (restoreTo instanceof HTMLElement && restoreTo.isConnected) {
        restoreTo.focus();
      }
    };
  }, [active]);

  return containerRef;
}
