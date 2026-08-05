import type { ReactElement, ReactNode } from "react";

import { messageSurfaceStyle, type BannerTone } from "./Banner.js";
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
 * standing fact. `aria-live` carries the tone: polite for neutral/attention,
 * assertive for alert. Timeout and stack management stay with the caller.
 */
export function Toast({
  tone = "neutral",
  children,
  onDismiss,
}: ToastProps): ReactElement {
  return (
    <div
      role="status"
      aria-live={tone === "alert" ? "assertive" : "polite"}
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
