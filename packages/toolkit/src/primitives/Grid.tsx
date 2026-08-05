import type {
  ComponentPropsWithoutRef,
  CSSProperties,
  ReactElement,
} from "react";

import { spaceVar, type Space } from "./space.js";

export interface GridProps extends Omit<
  ComponentPropsWithoutRef<"div">,
  "className" | "style"
> {
  /** Fixed column count, or a track list (e.g. `"64px 1fr"` for a region's key/value pair — §18's `--pr-region-key-w`). */
  readonly columns?: number | string;
  /** §18 SPACE, both axes. Overridden per-axis below. */
  readonly gap?: Space;
  readonly columnGap?: Space;
  readonly rowGap?: Space;
}

/**
 * Two-axis flow on §18's spacing scale (#102). `columns` takes either a track
 * count (`repeat(columns, 1fr)`) or a track list, because §09's region rows
 * are a fixed key column plus a fluid value column
 * (`--pr-region-key-w`/`--pr-region-key-gap`) rather than an even split — a
 * caller composing that layout passes the track list directly instead of the
 * primitive inventing a second prop for one shape.
 */
export function Grid({
  columns,
  gap,
  columnGap,
  rowGap,
  children,
  ...rest
}: GridProps): ReactElement {
  const style: CSSProperties = {
    display: "grid",
    gridTemplateColumns:
      typeof columns === "number" ? `repeat(${columns}, 1fr)` : columns,
    gap: spaceVar(gap),
    columnGap: spaceVar(columnGap),
    rowGap: spaceVar(rowGap),
  };

  return (
    <div style={style} {...rest}>
      {children}
    </div>
  );
}
