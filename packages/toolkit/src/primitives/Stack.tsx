import type {
  ComponentPropsWithoutRef,
  CSSProperties,
  ReactElement,
} from "react";

import { spaceVar, type Space } from "./space.js";

export type StackDirection = "row" | "column";
export type StackAlign = "start" | "center" | "end" | "stretch" | "baseline";
export type StackJustify = "start" | "center" | "end" | "between" | "around";

const ALIGN: Record<StackAlign, CSSProperties["alignItems"]> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
  baseline: "baseline",
};

const JUSTIFY: Record<StackJustify, CSSProperties["justifyContent"]> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
};

export interface StackProps extends Omit<
  ComponentPropsWithoutRef<"div">,
  "className" | "style"
> {
  /** @default "column" */
  readonly direction?: StackDirection;
  /** §18 SPACE between children. */
  readonly gap?: Space;
  readonly align?: StackAlign;
  readonly justify?: StackJustify;
  readonly wrap?: boolean;
}

/**
 * One-axis flow, gapped on §18's scale (#102). `Grid` is the two-axis
 * sibling; `Box` is what either wraps when a child needs its own padding or
 * surface. No `className`: reach for `Box` inside a `Stack` rather than
 * styling the `Stack` itself.
 */
export function Stack({
  direction = "column",
  gap,
  align,
  justify,
  wrap = false,
  children,
  ...rest
}: StackProps): ReactElement {
  const style: CSSProperties = {
    display: "flex",
    flexDirection: direction,
    flexWrap: wrap ? "wrap" : "nowrap",
    gap: spaceVar(gap),
    alignItems: align ? ALIGN[align] : undefined,
    justifyContent: justify ? JUSTIFY[justify] : undefined,
  };

  return (
    <div style={style} {...rest}>
      {children}
    </div>
  );
}
