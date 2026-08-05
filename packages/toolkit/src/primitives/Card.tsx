import type { ComponentPropsWithoutRef, ReactElement } from "react";
import { useId } from "react";

import { Box } from "./Box.js";
import { type Space } from "./space.js";
import { Stack } from "./Stack.js";

export interface CardProps extends Omit<
  ComponentPropsWithoutRef<"div">,
  "className" | "style"
> {
  readonly title?: string;
  /** §18 SPACE for the content inset. @default 6 */
  readonly padding?: Space;
}

/**
 * A generic content card (#102) — a list row, summary block, or any inset
 * container that is not a canvas node. Uses the hue-neutral loading glass, not
 * the node-family recipe (#237's `NodeCard` owns that).
 */
export function Card({
  title,
  padding = 6,
  children,
  ...rest
}: CardProps): ReactElement {
  const titleId = useId();

  return (
    <div
      role={title ? "region" : undefined}
      aria-labelledby={title ? titleId : undefined}
      className="rounded-block shadow-flat inset-shadow-lip"
      style={{ background: "var(--pr-glass-loading)" }}
      {...rest}
    >
      <Stack direction="column" gap={3}>
        {title ? (
          <Box paddingX={padding} paddingTop={padding}>
            <h2
              id={titleId}
              className="text-text-hi"
              style={{
                font: "var(--pr-type-title)",
                letterSpacing: "var(--pr-ls-heading)",
              }}
            >
              {title}
            </h2>
          </Box>
        ) : null}
        {title ? (
          <Box paddingX={padding} paddingBottom={padding}>
            {children}
          </Box>
        ) : (
          <Box padding={padding}>{children}</Box>
        )}
      </Stack>
    </div>
  );
}
