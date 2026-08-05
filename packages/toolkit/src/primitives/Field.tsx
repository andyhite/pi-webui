import {
  Children,
  cloneElement,
  useId,
  type HTMLAttributes,
  type ReactElement,
} from "react";

import { Stack } from "./Stack.js";

type ControlProps = Pick<
  HTMLAttributes<HTMLElement>,
  "id" | "aria-describedby" | "aria-invalid" | "aria-required"
>;

export interface FieldProps {
  readonly label: string;
  /** Optional description below the control. */
  readonly hint?: string;
  /** When set, wires `aria-describedby` and `aria-invalid` on the child. */
  readonly error?: string;
  readonly required?: boolean;
  /** A single control (`Input`, `Select`, …) whose `id`/`aria-*` this wires. */
  readonly children: ReactElement<ControlProps>;
}

/**
 * The labeled form-control wrapper (#102): generates `id`/`htmlFor` via
 * `useId()`, associates hint and error through `aria-describedby`, and
 * delegates `aria-invalid` to the child when `error` is present.
 */
export function Field({
  label,
  hint,
  error,
  required = false,
  children,
}: FieldProps): ReactElement {
  const baseId = useId();
  const controlId = `${baseId}-control`;
  const hintId = `${baseId}-hint`;
  const errorId = `${baseId}-error`;

  const describedBy = [hint && hintId, error && errorId]
    .filter(Boolean)
    .join(" ");

  const child = Children.only(children);

  const controlProps: ControlProps = {
    id: controlId,
    "aria-describedby": describedBy || undefined,
    "aria-invalid": error ? true : undefined,
    "aria-required": required || undefined,
  };

  return (
    <Stack direction="column" gap={2}>
      <label
        htmlFor={controlId}
        className="text-text-2"
        style={{
          // §18 TYPE: `--pr-type-meta-sm` is "Region labels" — the smallest
          // named caption step, one rank below section headings, which is
          // where a single field's label sits in the hierarchy.
          font: "var(--pr-type-meta-sm)",
        }}
      >
        {label}
        {required ? (
          <span className="text-alert-hi" aria-hidden="true">
            {" "}
            *
          </span>
        ) : null}
      </label>

      {cloneElement(child, controlProps)}

      {hint ? (
        <p
          id={hintId}
          className="text-text-3"
          style={{ font: "var(--pr-type-meta)", margin: 0 }}
        >
          {hint}
        </p>
      ) : null}

      {error ? (
        <p
          id={errorId}
          role="alert"
          className="text-alert-hi"
          style={{ font: "var(--pr-type-meta)", margin: 0 }}
        >
          {error}
        </p>
      ) : null}
    </Stack>
  );
}
