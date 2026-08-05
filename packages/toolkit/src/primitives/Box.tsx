import type {
  ComponentPropsWithoutRef,
  CSSProperties,
  ReactElement,
} from "react";

import { spaceVar, type Space } from "./space.js";

/** §18 surface recipes that carry no type hue — a node's glass is #237's. */
export type BoxSurface = "none" | "panel" | "well" | "footer" | "chrome";

/** §18 radius steps a generic container is allowed to pick. */
export type BoxRadius = "none" | "chip" | "control" | "block" | "panel";

/** §18's edge weights. */
export type BoxBorder = "none" | "hair" | "soft" | "edge" | "strong";

const SURFACE_CLASS: Record<BoxSurface, string> = {
  none: "",
  panel: "bg-body-panel",
  well: "bg-body-well",
  footer: "bg-body-footer",
  chrome: "bg-body-chrome",
};

const RADIUS_CLASS: Record<BoxRadius, string> = {
  none: "",
  chip: "rounded-chip",
  control: "rounded-control",
  block: "rounded-block",
  panel: "rounded-panel",
};

const BORDER_CLASS: Record<BoxBorder, string> = {
  none: "",
  // The toolkit ships no preflight (`toolkit.css`), so nothing resets
  // `border-style` to solid the way Tailwind's own reset would — `border`
  // alone sets only the width, and an unstyled border paints nothing.
  hair: "border border-solid border-edge-hair",
  soft: "border border-solid border-edge-soft",
  edge: "border border-solid border-edge",
  strong: "border border-solid border-edge-strong",
};

export interface BoxProps extends Omit<
  ComponentPropsWithoutRef<"div">,
  "className" | "style"
> {
  /** §18 SPACE, all four sides. Overridden per-axis or per-side below. */
  readonly padding?: Space;
  readonly paddingX?: Space;
  readonly paddingY?: Space;
  readonly paddingTop?: Space;
  readonly paddingRight?: Space;
  readonly paddingBottom?: Space;
  readonly paddingLeft?: Space;
  /** A §18 surface recipe, never a colour picked outside the toolkit. */
  readonly surface?: BoxSurface;
  readonly radius?: BoxRadius;
  readonly border?: BoxBorder;
}

/**
 * The layout primitive with no opinion of its own — a `div` whose only
 * decisions are §18's spacing, surface, radius and border scales (#102).
 *
 * No `className`, no `style`: a caller that wants a look this does not name
 * needs a different primitive, not an escape hatch on this one (decision 0002
 * §3). `Stack` and `Grid` add flow; `Box` is what they, and everything else,
 * wrap content in.
 */
export function Box({
  padding,
  paddingX,
  paddingY,
  paddingTop,
  paddingRight,
  paddingBottom,
  paddingLeft,
  surface = "none",
  radius = "none",
  border = "none",
  children,
  ...rest
}: BoxProps): ReactElement {
  const style: CSSProperties = {
    paddingTop: spaceVar(paddingTop ?? paddingY ?? padding),
    paddingRight: spaceVar(paddingRight ?? paddingX ?? padding),
    paddingBottom: spaceVar(paddingBottom ?? paddingY ?? padding),
    paddingLeft: spaceVar(paddingLeft ?? paddingX ?? padding),
  };
  const classes = [
    SURFACE_CLASS[surface],
    RADIUS_CLASS[radius],
    BORDER_CLASS[border],
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes || undefined} style={style} {...rest}>
      {children}
    </div>
  );
}
