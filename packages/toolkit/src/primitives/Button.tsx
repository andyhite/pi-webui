import type {
  ButtonHTMLAttributes,
  CSSProperties,
  ReactElement,
  ReactNode,
} from "react";

/**
 * §01: attention and alert are reserved — "never a type tint" — which is
 * exactly the semantics a generic action button needs: most actions are
 * neutral, and the two accents are for the two things the design reserves
 * them for (a call the operator should notice, a destructive or stopping
 * one). There is no fourth "primary" tone because no family hue (content,
 * command, session, workstream) means anything outside a node's own type —
 * using one on a button would be the "type tint" the design's own rule
 * refuses.
 */
export type ButtonTone = "neutral" | "attention" | "alert";
export type ButtonSize = "sm" | "md";

const TONE_CLASS: Record<
  ButtonTone,
  { rest: string; hover: string; active: string; text: string }
> = {
  neutral: {
    // §10: control rest/hover/press is the fill-2/3/4 staircase.
    rest: "bg-fill-2 border-edge",
    hover: "hover:bg-fill-3",
    active: "active:bg-fill-4",
    text: "text-text-1",
  },
  attention: {
    rest: "bg-attention/10 border-attention",
    hover: "hover:bg-attention/20",
    active: "active:bg-attention/30",
    text: "text-attention-hi",
  },
  alert: {
    rest: "bg-alert/10 border-alert",
    hover: "hover:bg-alert/20",
    active: "active:bg-alert/30",
    text: "text-alert-hi",
  },
};

// §15: controls are 26–30px, below the touch guideline, because every
// control also has a shortcut. `md` is the floating variant's height.
const SIZE_HEIGHT: Record<ButtonSize, string> = {
  sm: "var(--pr-control-h)",
  md: "var(--pr-control-h-floating)",
};

// Not a measured §18 value (buttons are not in the export's redlines) — two
// steps off the space scale, proportional to the two heights above.
const SIZE_PADDING_X: Record<ButtonSize, string> = {
  sm: "var(--pr-space-6)",
  md: "var(--pr-space-7)",
};

export interface ButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "style" | "type"
> {
  readonly tone?: ButtonTone;
  readonly size?: ButtonSize;
  /** Native `button[type]`. @default "button" — never a bare form submit by accident. */
  readonly type?: "button" | "submit" | "reset";
  /** Busy and non-interactive, but still announced (`aria-busy`), never hidden. */
  readonly loading?: boolean;
  readonly children?: ReactNode;
}

/**
 * The action primitive (#102): a label, a tone, a size, nothing a caller can
 * style outside those three. `IconButton` is the icon-only sibling —
 * `Button` always renders its label as text.
 */
export function Button({
  tone = "neutral",
  size = "sm",
  type = "button",
  loading = false,
  disabled = false,
  children,
  ...rest
}: ButtonProps): ReactElement {
  const t = TONE_CLASS[tone];
  const inert = disabled || loading;
  const style: CSSProperties = {
    height: SIZE_HEIGHT[size],
    paddingLeft: SIZE_PADDING_X[size],
    paddingRight: SIZE_PADDING_X[size],
    // No `--spacing` scale (`toolkit.css`) — `gap-2` compiles to nothing, so
    // the label/icon gap reads the space token directly, like padding above.
    gap: "var(--pr-space-3)",
    // §10: 90ms, background-color and border-color only — nothing scales.
    transition:
      "background-color var(--pr-dur-hover) var(--pr-ease), " +
      "border-color var(--pr-dur-hover) var(--pr-ease)",
    font: "var(--pr-type-chrome)",
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
        "rounded-control border border-solid",
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
