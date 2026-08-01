/**
 * The palette rail (spec §5): everything not yet on the canvas, as drag
 * sources. Grouped by kind for legibility; within the ticket group, rows are
 * ordered unblocked-first (`orderTicketsUnblockedFirst`) so the top row is
 * always something nothing else is blocking.
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 * Dragging a row sets `PALETTE_ENTRY_DRAG_TYPE` in the drag payload; the
 * canvas (`PlotCanvas`'s `onDropPaletteEntry`) is what turns a drop into a
 * placed node — this component only has to be a legal HTML5 drag source.
 */

import {
  COMMAND_DEFINITION_DRAG_TYPE,
  PALETTE_ENTRY_DRAG_TYPE,
} from "../canvas/PlotCanvas.js";
import type { PaletteEntry, PaletteTicketEntry } from "./model.js";
import { orderTicketsUnblockedFirst } from "./model.js";

export interface PaletteRailProps {
  readonly entries: readonly PaletteEntry[];
}

function isTicket(entry: PaletteEntry): entry is PaletteTicketEntry {
  return entry.kind === "ticket";
}

const KIND_ORDER: readonly PaletteEntry["kind"][] = [
  "ticket",
  "pull_request",
  "review",
  "document",
  "session",
  "command_definition",
];

function PaletteRow({ entry }: { entry: PaletteEntry }) {
  // Command definitions have their own legal drop target — a bare ticket,
  // creating a workstream in one gesture (§3.5) — everything else is a
  // plain content/session node placed wherever it's dropped on the canvas.
  const dragType =
    entry.kind === "command_definition"
      ? COMMAND_DEFINITION_DRAG_TYPE
      : PALETTE_ENTRY_DRAG_TYPE;
  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(dragType, entry.id);
      }}
    >
      {entry.label}
    </div>
  );
}

export function PaletteRail({ entries }: PaletteRailProps) {
  const tickets = orderTicketsUnblockedFirst(entries.filter(isTicket));
  const others = entries.filter((entry) => !isTicket(entry));

  return (
    <div>
      {KIND_ORDER.map((kind) => {
        const rows =
          kind === "ticket" ? tickets : others.filter((e) => e.kind === kind);
        if (rows.length === 0) return null;
        return (
          <section key={kind}>
            <h3>{kind}</h3>
            {rows.map((entry) => (
              <PaletteRow key={entry.id} entry={entry} />
            ))}
          </section>
        );
      })}
    </div>
  );
}
