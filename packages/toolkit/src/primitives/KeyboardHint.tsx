import type { ReactElement } from "react";

/**
 * One key each — `["Cmd", "K"]`, never `"Cmd+K"` as a string, so the two glyphs
 * get the chip treatment independently and a caller cannot typo the
 * separator into something the design did not draw.
 */
export interface KeyboardHintProps {
  readonly keys: readonly [string, ...string[]];
}

/**
 * The shortcut chip (#102) — spec §11: "every binding appears in a shortcuts
 * overlay", and this is what a binding renders as wherever it appears beside
 * the verb it triggers, not only there. Presentational: it names a shortcut,
 * it does not bind one.
 */
export function KeyboardHint({ keys }: KeyboardHintProps): ReactElement {
  return (
    <span
      // A plain `<span>` has no implicit role, so `aria-label` on it alone is
      // not reliably exposed to assistive tech across browsers. `role="img"`
      // is the standard trick for labelling a group of decorative glyphs as
      // one named unit — the chord *is* one unit, read as "Cmd+K".
      role="img"
      aria-label={keys.join("+")}
      style={{ display: "inline-flex", gap: "var(--pr-space-1)" }}
    >
      {keys.map((key, index) => (
        <kbd
          key={index}
          aria-hidden="true"
          className="rounded-chip bg-fill-2 text-text-3"
          style={{
            font: "var(--pr-type-meta-sm)",
            paddingLeft: "var(--pr-space-2)",
            paddingRight: "var(--pr-space-2)",
            paddingTop: "var(--pr-space-1)",
            paddingBottom: "var(--pr-space-1)",
            lineHeight: 1.4,
          }}
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}
