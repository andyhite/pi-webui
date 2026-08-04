/**
 * The editor surface for graph warnings (spec §5): everything
 * `deriveGraphWarnings` found, listed so a human (or, once agent tools read
 * this shape, a session) can jump straight to the node and fix it. Selecting
 * a row goes through the one navigation primitive (§5) — the same
 * `onSelectNode` the canvas click and the command palette use.
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 */

import type { GraphWarning } from "./derive.js";

export interface GraphWarningsPanelProps {
  readonly warnings: readonly GraphWarning[];
  readonly onSelectNode: (nodeId: string) => void;
}

export function GraphWarningsPanel({
  warnings,
  onSelectNode,
}: GraphWarningsPanelProps) {
  if (warnings.length === 0) {
    return <div>no graph warnings</div>;
  }

  return (
    <ul aria-label="graph warnings">
      {warnings.map((warning, index) => (
        <li key={`${warning.nodeId}-${warning.kind}-${index}`}>
          <button type="button" onClick={() => onSelectNode(warning.nodeId)}>
            {warning.kind}
          </button>{" "}
          {warning.message}
          {warning.basis ? <div>basis: {warning.basis}</div> : null}
        </li>
      ))}
    </ul>
  );
}
