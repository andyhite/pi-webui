/**
 * Ordered context inputs, rearrangeable (spec §3.5): edge order is assembly
 * order. Mechanics only — the design gate defers any visual treatment.
 *
 * Two ways to reorder, one act (§11, Epic 8.1): native HTML5 drag and drop,
 * and a pair of move buttons per row for the keyboard. Both call
 * `reorderContextEdges` and then the same `onReorder` the host persists with,
 * so a keyboard reorder and a dragged one are indistinguishable downstream —
 * never a second implementation of the same gesture (principle 8).
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

export function ContextInputList({ edges, onReorder }: ContextInputListProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const sorted = [...edges].sort((a, b) => a.ordinal - b.ordinal);

  function moveTo(edgeId: string, index: number): void {
    if (index < 0 || index >= sorted.length) return;
    onReorder(reorderContextEdges(sorted, edgeId, index));
  }

  return (
    <ol aria-label="context inputs in assembly order">
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
          {edge.label}{" "}
          <button
            type="button"
            aria-label={`move ${edge.label} earlier`}
            disabled={index === 0}
            onClick={() => moveTo(edge.id, index - 1)}
          >
            earlier
          </button>
          <button
            type="button"
            aria-label={`move ${edge.label} later`}
            disabled={index === sorted.length - 1}
            onClick={() => moveTo(edge.id, index + 1)}
          >
            later
          </button>
        </li>
      ))}
    </ol>
  );
}
