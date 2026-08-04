/**
 * The palette rail (spec §5): everything not yet on the canvas, as drag
 * sources. Grouped by kind for legibility; within the ticket group, rows are
 * ordered unblocked-first (`orderTicketsUnblockedFirst`) so the top row is
 * always something nothing else is blocking.
 *
 * Keyboard-reachable (§11, Epic 8.1): every row is a real `<button>`, so Tab
 * reaches it and Enter/Space activates it with the browser's own semantics —
 * no invented listbox, no key handler of this component's own. Activating a
 * row is the **same act** as dropping it on the canvas: the host places the
 * entry through the same action its `onDropPaletteEntry` uses, only with a
 * position the host derives instead of one the pointer supplied. A rail whose
 * host has not wired that yet renders the buttons disabled with the reason,
 * rather than looking activatable and doing nothing.
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
  /**
   * The keyboard's equivalent of dropping this entry on the canvas — the host
   * places it (the same action a drop calls) at a position it derives.
   * Absent: the rows render disabled, naming why.
   */
  readonly onActivateEntry?: (entryId: string) => void;
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

const NOT_WIRED_REASON = "placing from the keyboard is not wired here";

function PaletteRow({
  entry,
  onActivate,
}: {
  readonly entry: PaletteEntry;
  readonly onActivate: ((entryId: string) => void) | undefined;
}) {
  // Command definitions have their own legal drop target — a bare ticket,
  // creating a workstream in one gesture (§3.5) — everything else is a
  // plain content/session node placed wherever it's dropped on the canvas.
  const dragType =
    entry.kind === "command_definition"
      ? COMMAND_DEFINITION_DRAG_TYPE
      : PALETTE_ENTRY_DRAG_TYPE;
  return (
    <button
      type="button"
      draggable
      disabled={onActivate === undefined}
      {...(onActivate === undefined ? { title: NOT_WIRED_REASON } : {})}
      onDragStart={(event) => {
        event.dataTransfer.setData(dragType, entry.id);
      }}
      onClick={() => onActivate?.(entry.id)}
    >
      {entry.label}
    </button>
  );
}

export function PaletteRail({ entries, onActivateEntry }: PaletteRailProps) {
  const tickets = orderTicketsUnblockedFirst(entries.filter(isTicket));
  const others = entries.filter((entry) => !isTicket(entry));

  return (
    <div>
      {KIND_ORDER.map((kind) => {
        const rows =
          kind === "ticket" ? tickets : others.filter((e) => e.kind === kind);
        if (rows.length === 0) return null;
        return (
          <section key={kind} aria-label={`palette: ${kind}`}>
            <h3>{kind}</h3>
            <ul aria-label={`${kind} not yet on the canvas`}>
              {rows.map((entry) => (
                <li key={entry.id}>
                  <PaletteRow entry={entry} onActivate={onActivateEntry} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
