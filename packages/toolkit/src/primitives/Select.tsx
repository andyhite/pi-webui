import type { CSSProperties, ReactElement, SelectHTMLAttributes } from "react";

import type { InputSize } from "./Input.js";

export type SelectSize = InputSize;

// Same heights and horizontal padding as `Input` — one control family.
const SIZE_HEIGHT: Record<SelectSize, string> = {
  sm: "var(--pr-control-h)",
  md: "var(--pr-control-h-floating)",
};

const SIZE_PADDING_X: Record<SelectSize, string> = {
  sm: "var(--pr-space-6)",
  md: "var(--pr-space-7)",
};

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "className" | "style" | "size" | "children"
> {
  readonly options: readonly SelectOption[];
  /** @default "sm" */
  readonly size?: SelectSize;
  /** Failure state — red border and `aria-invalid`. */
  readonly invalid?: boolean;
}

/**
 * The native-select primitive (#102): a real `<select>` for free keyboard
 * operability (arrow keys, type-ahead, platform picker) — not a custom
 * listbox. Styled to match `Input`'s recessed well.
 */
export function Select({
  options,
  size = "sm",
  invalid = false,
  disabled = false,
  ...rest
}: SelectProps): ReactElement {
  const style: CSSProperties = {
    height: SIZE_HEIGHT[size],
    paddingLeft: SIZE_PADDING_X[size],
    paddingRight: SIZE_PADDING_X[size],
    // Options render in the platform font; the closed control matches `Input`.
    font: "var(--pr-type-mono)",
    transition:
      "background-color var(--pr-dur-hover) var(--pr-ease), " +
      "border-color var(--pr-dur-hover) var(--pr-ease)",
    opacity: disabled ? 0.5 : undefined,
    cursor: disabled ? "default" : undefined,
  };

  return (
    <select
      disabled={disabled}
      aria-invalid={invalid || undefined}
      className={[
        "pr-focus-ring w-full rounded-control border border-solid",
        "bg-body-well text-text-1 inset-shadow-well",
        invalid ? "border-alert" : "border-edge",
      ].join(" ")}
      style={style}
      {...rest}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
