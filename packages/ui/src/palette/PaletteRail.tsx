/**
 * The palette rail (spec §5): everything not yet on the canvas, as drag
 * sources. Grouped by kind for legibility; within the ticket group, rows are
 * ordered unblocked-first (`orderTicketsUnblockedFirst`) so the top row is
 * always something nothing else is blocking.
 *
 * Keyboard-reachable (§11, Epic 8.1): each group is an announced listbox and
 * every row is a tabbable `option`, so Tab reaches a row and Enter places it.
 * That Enter is a **registered binding** (scope `list`, surface
 * `palette-rail`), not a handler of this component's own, so it appears in the
 * shortcuts overlay like every other key. Placing a row is the same act as
 * dropping it on the canvas: the host places the entry through the same action
 * its `onDropPaletteEntry` uses, only with a position the host derives instead
 * of one the pointer supplied. A rail whose host has not wired that yet says
 * so on the row rather than looking activatable and doing nothing.
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 * Dragging a row sets `PALETTE_ENTRY_DRAG_TYPE` in the drag payload; the
 * canvas (`PlotCanvas`'s `onDropPaletteEntry`) is what turns a drop into a
 * placed node — this component only has to be a legal HTML5 drag source.
 */

import { useMemo, useRef } from "react";

import {
  COMMAND_DEFINITION_DRAG_TYPE,
  PALETTE_ENTRY_DRAG_TYPE,
} from "../canvas/PlotCanvas.js";
import type { KeyBinding } from "../keyboard/bindings.js";
import { useKeyBindings } from "../keyboard/use-key-bindings.js";
import type { PaletteEntry, PaletteTicketEntry } from "./model.js";
import { orderTicketsUnblockedFirst } from "./model.js";

/** The attribute a row carries its entry id in, read by the Enter binding. */
export const PALETTE_ENTRY_ATTRIBUTE = "data-palette-entry";

export interface PaletteRailProps {
  readonly entries: readonly PaletteEntry[];
  /**
   * The keyboard's equivalent of dropping this entry on the canvas — the host
   * places it (the same action a drop calls) at a position it derives.
   * Absent: the rows say placing from the keyboard is not wired here.
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

function PaletteRow({ entry }: { readonly entry: PaletteEntry }) {
  // Command definitions have their own legal drop target — a bare ticket,
  // creating a workstream in one gesture (§3.5) — everything else is a
  // plain content/session node placed wherever it's dropped on the canvas.
  const dragType =
    entry.kind === "command_definition"
      ? COMMAND_DEFINITION_DRAG_TYPE
      : PALETTE_ENTRY_DRAG_TYPE;
  return (
    <li
      role="option"
      aria-selected={false}
      tabIndex={0}
      {...{ [PALETTE_ENTRY_ATTRIBUTE]: entry.id }}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(dragType, entry.id);
      }}
    >
      {entry.label}
    </li>
  );
}

export function PaletteRail({ entries, onActivateEntry }: PaletteRailProps) {
  const tickets = orderTicketsUnblockedFirst(entries.filter(isTicket));
  const others = entries.filter((entry) => !isTicket(entry));

  const activateRef = useRef(onActivateEntry);
  activateRef.current = onActivateEntry;

  const bindings = useMemo<readonly KeyBinding[]>(
    () => [
      {
        kind: "dispatched",
        id: "palette-rail-place",
        chords: [{ key: "Enter" }, { key: " " }],
        label: "place the focused palette row on the canvas",
        description: `the keyboard's version of dragging it out (§5) — ${NOT_WIRED_REASON} when the host wired no placement`,
        scope: "list",
        surface: "palette-rail",
        run: () => {
          // The focused element *is* the row, so no walk is needed.
          const entryId =
            document.activeElement?.getAttribute(PALETTE_ENTRY_ATTRIBUTE) ??
            null;
          if (entryId) activateRef.current?.(entryId);
        },
      },
    ],
    [],
  );
  useKeyBindings(bindings);

  return (
    <div data-key-scope="list:palette-rail">
      {KIND_ORDER.map((kind) => {
        const rows =
          kind === "ticket" ? tickets : others.filter((e) => e.kind === kind);
        if (rows.length === 0) return null;
        return (
          <section key={kind}>
            <h3>{kind}</h3>
            <ul role="listbox" aria-label={`${kind} not yet on the canvas`}>
              {rows.map((entry) => (
                <PaletteRow key={entry.id} entry={entry} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
