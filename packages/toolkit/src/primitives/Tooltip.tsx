import {
  cloneElement,
  useEffect,
  useId,
  useState,
  type FocusEvent,
  type ReactElement,
} from "react";

/** Props the tooltip merges onto its single trigger child. */
type TooltipTriggerProps = {
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  "aria-describedby"?: string | undefined;
};

export interface TooltipProps {
  readonly content: string;
  /** A single focusable element — the hover/focus trigger (WAI-ARIA tooltip pattern). */
  readonly children: ReactElement<TooltipTriggerProps>;
}

/**
 * A hover- and focus-triggered tooltip (#102). The trigger carries
 * `aria-describedby` while open; the floating surface uses the panel glass
 * recipe because tooltips float over content (§01 surface recipes).
 */
export function Tooltip({ content, children }: TooltipProps): ReactElement {
  const tooltipId = useId();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  function show(): void {
    setOpen(true);
  }

  function hide(): void {
    setOpen(false);
  }

  const childProps = children.props;

  const describedBy = open
    ? [childProps["aria-describedby"], tooltipId].filter(Boolean).join(" ")
    : childProps["aria-describedby"];

  const trigger = cloneElement(children, {
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    onFocus: (event: FocusEvent<HTMLElement>) => {
      childProps.onFocus?.(event);
      show();
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      childProps.onBlur?.(event);
      hide();
    },
  });

  return (
    <span
      className="relative inline-block"
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      {trigger}
      {open ? (
        <span
          id={tooltipId}
          role="tooltip"
          className={[
            "absolute shadow-panel inset-shadow-lip",
            "rounded-control border border-solid border-edge",
            "whitespace-nowrap text-text-1",
          ].join(" ")}
          style={{
            left: 0,
            top: "100%",
            marginTop: "var(--pr-space-2)",
            background: "var(--pr-glass-panel)",
            backdropFilter: "var(--pr-blur-panel)",
            font: "var(--pr-type-meta-sm)",
            paddingLeft: "var(--pr-space-3)",
            paddingRight: "var(--pr-space-3)",
            paddingTop: "var(--pr-space-2)",
            paddingBottom: "var(--pr-space-2)",
          }}
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}
