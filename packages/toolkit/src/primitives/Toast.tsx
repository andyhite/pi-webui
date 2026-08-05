import type { ReactElement, ReactNode } from "react";

import { messageRole, messageSurfaceStyle, type BannerTone } from "./Banner.js";
import { IconButton } from "./IconButton.js";

export type ToastTone = BannerTone;

export interface ToastProps {
  readonly tone?: ToastTone;
  readonly children: ReactNode;
  /** Renders a dismiss `IconButton` when present; no auto-dismiss timing. */
  readonly onDismiss?: () => void;
}

/**
 * A transient notification (#102) — announces a *change* when mounted, not a
 * standing fact. Unlike `Banner`, mounting it is itself the announcement, so
 * the role carries the only live-region signal it needs — `role="alert"` is
 * already an implicit assertive live region and `role="status"` an implicit
 * polite one; adding `aria-live` on top would restate (and could contradict)
 * what the role already says. Timeout and stack management stay with the
 * caller.
 */
export function Toast({
  tone = "neutral",
  children,
  onDismiss,
}: ToastProps): ReactElement {
  return (
    <div
      role={messageRole(tone)}
      className={[
        "rounded-block border border-solid border-edge inset-shadow-lip",
        "text-text-1 shadow-panel",
      ].join(" ")}
      style={messageSurfaceStyle(tone)}
    >
      <span style={{ flex: 1 }}>{children}</span>
      {onDismiss ? (
        <IconButton
          aria-label="Dismiss"
          tone="neutral"
          size="sm"
          onClick={onDismiss}
        >
          <span aria-hidden="true">×</span>
        </IconButton>
      ) : null}
    </div>
  );
}
