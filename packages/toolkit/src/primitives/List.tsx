import type { CSSProperties, ReactElement, ReactNode } from "react";

/** One row in a `List` — `content` is the row body; `onSelect` makes it activatable. */
export interface ListItem {
  readonly id: string;
  readonly content: ReactNode;
  readonly onSelect?: () => void;
}

export interface ListProps {
  readonly items: readonly ListItem[];
}

// §18's `--pr-divider` is a pair (`tokens.ts`): colour plus shadow, not one token.
const ROW_DIVIDER: CSSProperties = {
  borderBottom: "1px solid var(--pr-divider-color)",
  boxShadow: "var(--pr-divider-shadow)",
};

const ROW_PADDING: CSSProperties = {
  paddingLeft: "var(--pr-space-6)",
  paddingRight: "var(--pr-space-6)",
  paddingTop: "var(--pr-space-4)",
  paddingBottom: "var(--pr-space-4)",
};

const INTERACTIVE_ROW_CLASS = [
  "pr-focus-ring w-full text-left",
  "bg-fill-2 hover:bg-fill-3 active:bg-fill-4",
  "text-text-1 border-0",
].join(" ");

const INTERACTIVE_ROW_STYLE: CSSProperties = {
  ...ROW_PADDING,
  font: "var(--pr-type-body)",
  cursor: "pointer",
  // §10: background only — nothing scales on hover/press.
  transition: "background-color var(--pr-dur-hover) var(--pr-ease)",
};

const STATIC_ROW_STYLE: CSSProperties = {
  ...ROW_PADDING,
  font: "var(--pr-type-body)",
};

/**
 * A vertical list of rows (#102). Rows with `onSelect` are `<button>`s inside
 * `role="listitem"` wrappers; rows without are static `role="listitem"` divs.
 *
 * **Container role:** `role="list"`, not `role="listbox"`. Listbox implies
 * option-selection semantics (`aria-selected`, roving tabindex among options)
 * — this primitive carries no selected state and each `onSelect` is an
 * independent action, not a single-select choice among options (WAI-ARIA
 * listbox pattern).
 */
export function List({ items }: ListProps): ReactElement {
  return (
    <div role="list">
      {items.map((item, index) => {
        const divider = index < items.length - 1 ? ROW_DIVIDER : undefined;

        if (item.onSelect) {
          return (
            <div key={item.id} role="listitem" style={divider}>
              <button
                type="button"
                className={INTERACTIVE_ROW_CLASS}
                style={INTERACTIVE_ROW_STYLE}
                onClick={item.onSelect}
              >
                {item.content}
              </button>
            </div>
          );
        }

        return (
          <div
            key={item.id}
            role="listitem"
            className="text-text-1"
            style={{ ...STATIC_ROW_STYLE, ...divider }}
          >
            {item.content}
          </div>
        );
      })}
    </div>
  );
}
