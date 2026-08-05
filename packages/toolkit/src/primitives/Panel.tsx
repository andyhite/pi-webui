import type {
  ComponentPropsWithoutRef,
  CSSProperties,
  ReactElement,
} from "react";
import { useId } from "react";

import { Box } from "./Box.js";
import { Stack } from "./Stack.js";

export interface PanelProps extends Omit<
  ComponentPropsWithoutRef<"div">,
  "className" | "style"
> {
  /** §06: the one heading style that is not mono — renders a header when set. */
  readonly title?: string;
}

// §18's panel glass recipe has no `theme:` key — the gradient, blur, radius,
// and float shadow are a multi-part surface applied together, not one utility.
const PANEL_SURFACE: CSSProperties = {
  background: "var(--pr-glass-panel)",
  boxShadow: "var(--pr-shadow-panel)",
  borderRadius: "var(--pr-radius-panel)",
  backdropFilter: "var(--pr-blur-panel)",
  WebkitBackdropFilter: "var(--pr-blur-panel)",
};

/**
 * The floating chrome-adjacent surface (#102) — dock-rail panels such as
 * Conversation, Diff, Fleet, Logs, and Timeline. §06: panels float beside the
 * graph; they carry no type hue and never share the node glass recipe (#237).
 */
export function Panel({ title, children, ...rest }: PanelProps): ReactElement {
  const titleId = useId();

  return (
    <div
      role={title ? "region" : undefined}
      aria-labelledby={title ? titleId : undefined}
      style={PANEL_SURFACE}
      {...rest}
    >
      <Stack direction="column">
        {title ? (
          <>
            <Box paddingX={6} paddingTop={5} paddingBottom={5}>
              <h2
                id={titleId}
                className="text-text-hi"
                style={{ font: "var(--pr-type-panel)" }}
              >
                {title}
              </h2>
            </Box>
            <div
              aria-hidden="true"
              style={{
                borderBottom: "1px solid var(--pr-divider-color)",
                boxShadow: "var(--pr-divider-shadow)",
              }}
            />
          </>
        ) : null}
        <Box padding={6}>{children}</Box>
      </Stack>
    </div>
  );
}
