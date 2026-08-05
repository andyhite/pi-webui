import type { CSSProperties, InputHTMLAttributes, ReactElement } from "react";

/** Matches `Button`'s scale — §15's 26px rail control and 30px floating height. */
export type InputSize = "sm" | "md";

// Same heights as `Button` — one control family, one vertical rhythm.
const SIZE_HEIGHT: Record<InputSize, string> = {
  sm: "var(--pr-control-h)",
  md: "var(--pr-control-h-floating)",
};

// Two steps off the space scale, proportional to the two heights above (see
// `Button.tsx`'s `SIZE_PADDING_X` comment — inputs share the family).
const SIZE_PADDING_X: Record<InputSize, string> = {
  sm: "var(--pr-space-6)",
  md: "var(--pr-space-7)",
};

export interface InputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "className" | "style" | "size"
> {
  /** @default "sm" */
  readonly size?: InputSize;
  /** Failure state — red border and `aria-invalid`. */
  readonly invalid?: boolean;
}

/**
 * The text-input primitive (#102): §01 DEPTH inverts the stack — darker than
 * its container — so typing feels recessed inside the glass.
 */
export function Input({
  size = "sm",
  invalid = false,
  disabled = false,
  ...rest
}: InputProps): ReactElement {
  const style: CSSProperties = {
    height: SIZE_HEIGHT[size],
    paddingLeft: SIZE_PADDING_X[size],
    paddingRight: SIZE_PADDING_X[size],
    // §18 TYPE: `--pr-type-mono` — "Spec rows, tool calls"; typed values are
    // data, not prose, so the same mono body as the spec rows they may hold.
    font: "var(--pr-type-mono)",
    // §10: 90ms, background-color and border-color only.
    transition:
      "background-color var(--pr-dur-hover) var(--pr-ease), " +
      "border-color var(--pr-dur-hover) var(--pr-ease)",
    opacity: disabled ? 0.5 : undefined,
    cursor: disabled ? "default" : undefined,
    width: "100%",
  };

  return (
    <input
      disabled={disabled}
      aria-invalid={invalid || undefined}
      className={[
        "pr-focus-ring w-full rounded-control border border-solid",
        "bg-body-well text-text-1 inset-shadow-well",
        invalid ? "border-alert" : "border-edge",
      ].join(" ")}
      style={style}
      {...rest}
    />
  );
}
