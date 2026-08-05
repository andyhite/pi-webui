import type { CSSProperties, ReactElement, ReactNode } from "react";

import { IconButton } from "./IconButton.js";

/**
 * The same three reserved accents as `Button`/`Badge` (§01) — no fourth
 * "informational" tone exists in `tokens.ts` distinct from neutral.
 */
export type BannerTone = "neutral" | "attention" | "alert";

/**
 * Left-stripe accent colours for `Banner` and `Toast`.
 *
 * `Badge`/`Button` flood a small chip/control with `bg-attention/10`; a
 * full-width message surface at that saturation would dominate the panel.
 * These primitives keep the glass body neutral and let tone read through a
 * `space-1` left stripe — proportionate to a persistent or transient message,
 * not a control. Dismiss stays a neutral `IconButton` so it does not compete
 * with the stripe.
 */
export const BANNER_TONE_ACCENT: Record<BannerTone, string> = {
  neutral: "var(--pr-edge-strong)",
  attention: "var(--pr-attention)",
  alert: "var(--pr-alert)",
};

/** Shared layout and glass body for `Banner` and `Toast`. */
export function messageSurfaceStyle(tone: BannerTone): CSSProperties {
  return {
    // §18 `--pr-glass-panel`: panels carry no type hue; tone is the stripe.
    background: "var(--pr-glass-panel)",
    display: "flex",
    alignItems: "center",
    gap: "var(--pr-space-4)",
    padding: "var(--pr-space-4)",
    font: "var(--pr-type-body)",
    borderLeftWidth: "var(--pr-space-1)",
    borderLeftStyle: "solid",
    borderLeftColor: BANNER_TONE_ACCENT[tone],
  };
}

function bannerRole(tone: BannerTone): "status" | "alert" {
  // ARIA: `alert` is for time-sensitive, important interruptions — the
  // reserved alert tone's meaning, not attention's "needs a human".
  return tone === "alert" ? "alert" : "status";
}

export interface BannerProps {
  readonly tone?: BannerTone;
  readonly children: ReactNode;
  /** Renders a dismiss `IconButton` when present; no auto-dismiss timing. */
  readonly onDismiss?: () => void;
}

/**
 * An inline, persistent status message (#102) — e.g. at the top of a panel.
 * Mount/unmount and any timeout live with the caller; this primitive only
 * paints and announces.
 */
export function Banner({
  tone = "neutral",
  children,
  onDismiss,
}: BannerProps): ReactElement {
  return (
    <div
      role={bannerRole(tone)}
      className={[
        "rounded-block border border-solid border-edge inset-shadow-lip",
        "text-text-1",
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
