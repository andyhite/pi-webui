import type { ReactElement } from "react";

export type SpinnerSize = "sm" | "md";

// Not §18 measurements (a spinner is not in the export) — proportioned off
// the space scale so it sits inside a control without a component-specific
// pixel value.
const SIZE: Record<SpinnerSize, string> = {
  sm: "var(--pr-space-8)",
  md: "var(--pr-space-11)",
};

export interface SpinnerProps {
  readonly size?: SpinnerSize;
  /** What is loading, read by assistive tech (`role="status"`). */
  readonly label: string;
}

/**
 * The one motion in the system that is not §10's 90/160/220ms tween (#102) —
 * §01 says "nothing scales, bounces, or pulses", which is about *state*
 * changes; a spinner's continuous rotation signals "still running" the same
 * way a session's own dot does; it does not violate the rule.
 *
 * `role="status"` plus visually-hidden text, not `aria-label` alone: a
 * spinner with no label would announce nothing to a screen reader on
 * mount — `aria-live` regions announce a *change*, and "loading" is true from
 * the first render.
 */
export function Spinner({ size = "sm", label }: SpinnerProps): ReactElement {
  const side = SIZE[size];
  return (
    <span role="status" style={{ display: "inline-flex" }}>
      <svg
        width={side}
        height={side}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        style={{
          animation: "pr-spin 0.9s linear infinite",
        }}
      >
        <circle
          cx="8"
          cy="8"
          r="6.5"
          stroke="var(--pr-edge-strong)"
          strokeWidth="2"
        />
        <path
          d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5"
          stroke="var(--pr-selection)"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      <span
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
        }}
      >
        {label}
      </span>
    </span>
  );
}
