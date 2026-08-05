import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { focusTrapNext, focusableElementsIn } from "./focus-trap.js";

export interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Becomes the accessible name via `aria-labelledby`. */
  readonly title: string;
  readonly children?: ReactNode;
}

/**
 * A modal dialog (#102, spec §11): traps focus while open, closes on Escape,
 * restores focus to the element that had it before opening. No portal yet (#51
 * decides stacking); renders in-place when `open`.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: DialogProps): ReactElement | null {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusables = focusableElementsIn(dialog);
    const initial = focusables[0] ?? dialog;
    if (initial === dialog) dialog.tabIndex = -1;
    initial.focus();

    return () => {
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open) return null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusables = focusableElementsIn(dialog);
    const trapTargets = focusables.length > 0 ? focusables : [dialog];
    const next = focusTrapNext(
      trapTargets,
      document.activeElement as HTMLElement,
      event.shiftKey ? "backward" : "forward",
    );
    if (!next) return;

    event.preventDefault();
    next.focus();
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={handleKeyDown}
      className={[
        "shadow-panel inset-shadow-lip",
        "rounded-panel border border-solid border-edge",
        "text-text-1",
      ].join(" ")}
      style={{
        background: "var(--pr-glass-panel)",
        backdropFilter: "var(--pr-blur-panel)",
        padding: "var(--pr-space-8)",
        maxWidth: "var(--pr-panel-palette-w)",
      }}
    >
      <h2
        id={titleId}
        className="text-text-hi"
        style={{
          font: "var(--pr-type-panel)",
          letterSpacing: "var(--pr-ls-heading)",
          marginBottom: "var(--pr-space-6)",
        }}
      >
        {title}
      </h2>
      <div style={{ font: "var(--pr-type-body)" }}>{children}</div>
    </div>
  );
}
