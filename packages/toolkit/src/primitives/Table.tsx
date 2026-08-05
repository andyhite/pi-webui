import type { CSSProperties, ReactElement, ReactNode } from "react";

export interface TableColumn {
  readonly key: string;
  readonly label: string;
}

export interface TableProps {
  readonly columns: readonly TableColumn[];
  readonly rows: readonly Record<string, ReactNode>[];
  /** Visible when passed — gives standalone tables an accessible name without a nearby heading. */
  readonly caption?: string;
}

// Same pair as `List` — §18's divider is border colour plus shadow (`tokens.ts`).
const ROW_DIVIDER: CSSProperties = {
  borderBottom: "1px solid var(--pr-divider-color)",
  boxShadow: "var(--pr-divider-shadow)",
};

const CELL_PADDING: CSSProperties = {
  paddingLeft: "var(--pr-space-6)",
  paddingRight: "var(--pr-space-6)",
  paddingTop: "var(--pr-space-4)",
  paddingBottom: "var(--pr-space-4)",
};

const HEADER_CELL_STYLE: CSSProperties = {
  ...CELL_PADDING,
  font: "var(--pr-type-section)",
  letterSpacing: "var(--pr-ls-section)",
  textAlign: "left",
};

// `--pr-text-1` for the first column, `--pr-text-2` for the rest — label vs
// value steps on the same body type face. Callers pass cell `content` as
// `ReactNode`; numeric or tabular values should wrap in
// `font: var(--pr-type-mono)` themselves — this primitive sets colour steps
// only, not the type face per cell.
const BODY_CELL_CLASS: readonly [string, string] = [
  "text-text-1",
  "text-text-2",
];

const BODY_CELL_STYLE: CSSProperties = {
  ...CELL_PADDING,
  font: "var(--pr-type-body)",
  textAlign: "left",
};

/**
 * A semantic data table (#102) — real `<table>` markup for screen-reader table
 * navigation, not a div grid.
 *
 * **Caption:** when `caption` is passed it is rendered visibly (not
 * visually-hidden) so a table without a nearby heading still has an
 * accessible name operators can read.
 */
export function Table({ columns, rows, caption }: TableProps): ReactElement {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      {caption !== undefined ? (
        <caption
          className="text-text-3"
          style={{
            font: "var(--pr-type-section)",
            letterSpacing: "var(--pr-ls-section)",
            captionSide: "top",
            textAlign: "left",
            paddingBottom: "var(--pr-space-4)",
          }}
        >
          {caption}
        </caption>
      ) : null}
      <thead>
        <tr style={ROW_DIVIDER}>
          {columns.map((column) => (
            <th
              key={column.key}
              scope="col"
              className="text-text-3"
              style={HEADER_CELL_STYLE}
            >
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr
            key={rowIndex}
            style={rowIndex < rows.length - 1 ? ROW_DIVIDER : undefined}
          >
            {columns.map((column, columnIndex) => (
              <td
                key={column.key}
                className={BODY_CELL_CLASS[columnIndex === 0 ? 0 : 1]}
                style={BODY_CELL_STYLE}
              >
                {row[column.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
