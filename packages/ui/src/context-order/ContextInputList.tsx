/**
 * Ordered context inputs, rearrangeable by drag (spec §3.5): edge order is
 * assembly order. Mechanics only — a plain list with native HTML5 drag and
 * drop; the design gate defers any visual treatment.
 */

import { useState } from "react";

import { reorderContextEdges } from "./reorder.js";
import type { OrderedEdge } from "./reorder.js";

export interface ContextInputRow extends OrderedEdge {
  /** Label for the content node this edge carries into the command/session. */
  readonly label: string;
}

export interface ContextInputListProps {
  readonly edges: readonly ContextInputRow[];
  readonly onReorder: (edges: readonly ContextInputRow[]) => void;
}

/** A plain, keyboard-reachable-later drag list ordered by `ordinal`. */
export function ContextInputList({ edges, onReorder }: ContextInputListProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const sorted = [...edges].sort((a, b) => a.ordinal - b.ordinal);

  return (
    <ol>
      {sorted.map((edge, index) => (
        <li
          key={edge.id}
          draggable
          onDragStart={() => setDraggingId(edge.id)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            if (draggingId === null) return;
            onReorder(reorderContextEdges(sorted, draggingId, index));
            setDraggingId(null);
          }}
        >
          {edge.label}
        </li>
      ))}
    </ol>
  );
}
