import type { ReactElement, ReactNode } from "react";

/**
 * Neutral plus the two reserved accents (§01) — the same tone set as
 * `Button`, for the same reason: a badge that borrowed a family hue (content,
 * command, session, workstream) would read as that node's type rather than as
 * a status, and the design reserves those hues for exactly one thing each.
 */
export type BadgeTone = "neutral" | "attention" | "alert" | "session";

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "bg-fill-2 text-text-2",
  attention: "bg-attention/15 text-attention-hi",
  alert: "bg-alert/15 text-alert-hi",
  // §01: session is the one family hue a status badge legitimately needs —
  // "running" is a session-scoped fact the graph already colours this way.
  session: "bg-session/15 text-session-icon",
};

export interface BadgeProps {
  readonly tone?: BadgeTone;
  readonly children: ReactNode;
}

/**
 * A short status label (#102) — §18's chip radius, never a button (it is not
 * focusable and takes no `onClick`; wrap it in one if a badge needs to act).
 */
export function Badge({
  tone = "neutral",
  children,
}: BadgeProps): ReactElement {
  return (
    <span
      className={[
        "inline-flex items-center rounded-chip",
        TONE_CLASS[tone],
      ].join(" ")}
      style={{
        font: "var(--pr-type-meta-sm)",
        letterSpacing: "var(--pr-ls-kind)",
        paddingLeft: "var(--pr-space-2)",
        paddingRight: "var(--pr-space-2)",
        paddingTop: "var(--pr-space-1)",
        paddingBottom: "var(--pr-space-1)",
      }}
    >
      {children}
    </span>
  );
}
