import type {
  ButtonHTMLAttributes,
  CSSProperties,
  ReactElement,
  ReactNode,
} from "react";

import type { ButtonSize, ButtonTone } from "./Button.js";

const TONE_CLASS: Record<
  ButtonTone,
  { rest: string; hover: string; active: string; text: string }
> = {
  neutral: {
    rest: "bg-fill-2",
    hover: "hover:bg-fill-3",
    active: "active:bg-fill-4",
    text: "text-text-2",
  },
  attention: {
    rest: "bg-attention/10",
    hover: "hover:bg-attention/20",
    active: "active:bg-attention/30",
    text: "text-attention-hi",
  },
  alert: {
    rest: "bg-alert/10",
    hover: "hover:bg-alert/20",
    active: "active:bg-alert/30",
    text: "text-alert-hi",
  },
};

// §15: the rail's own button size, and the chrome control height.
const SIZE: Record<ButtonSize, string> = {
  sm: "var(--pr-rail-button)",
  md: "var(--pr-control-h-floating)",
};

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "style" | "type"
> {
  readonly tone?: ButtonTone;
  readonly size?: ButtonSize;
  readonly type?: "button" | "submit" | "reset";
  readonly loading?: boolean;
  /**
   * Required, not optional: an icon-only control with no visible label has no
   * accessible name unless something supplies one (spec §11 accessibility).
   */
  readonly "aria-label": string;
  readonly children: ReactNode;
}

/**
 * The icon-only sibling of `Button` (#102) — square, no visible label, so
 * `aria-label` is a required prop rather than an accessibility opt-in.
 */
export function IconButton({
  tone = "neutral",
  size = "sm",
  type = "button",
  loading = false,
  disabled = false,
  children,
  ...rest
}: IconButtonProps): ReactElement {
  const t = TONE_CLASS[tone];
  const inert = disabled || loading;
  const side = SIZE[size];
  const style: CSSProperties = {
    width: side,
    height: side,
    transition:
      "background-color var(--pr-dur-hover) var(--pr-ease), " +
      "border-color var(--pr-dur-hover) var(--pr-ease)",
    opacity: disabled ? 0.5 : undefined,
    cursor: inert ? "default" : "pointer",
  };

  return (
    <button
      type={type}
      disabled={inert}
      aria-busy={loading || undefined}
      className={[
        "pr-focus-ring inline-flex items-center justify-center",
        "rounded-control",
        t.rest,
        t.text,
        inert ? "" : `${t.hover} ${t.active}`,
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
      {...rest}
    >
      {children}
    </button>
  );
}
