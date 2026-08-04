/**
 * The command palette (spec §11): one keyboard entry point for navigation
 * and every verb. Navigation always goes through `onSelectNode` — the one
 * navigation primitive (§5) shared with the canvas click and the attention
 * queue.
 *
 * Every key it answers to is a **registered binding** (Epic 8.1): its own
 * Mod+K toggle, Escape, the arrows, Enter. This component installs no
 * keyboard listener of its own — the app has exactly one (`useKeyBinding
 * Dispatch`) — so the shortcuts overlay lists the palette's keys because
 * they are the same objects the dispatcher runs, not because someone wrote
 * them down twice. The dialog bindings are registered whether or not the
 * palette is open (they are scoped to its own surface, `scope.ts`), which is
 * what lets the overlay document them while it is closed.
 *
 * Accessibility (§11): a real combobox — `aria-expanded`, `aria-controls`,
 * and `aria-activedescendant` naming the highlighted option, so the
 * highlight is announced rather than merely drawn — over a listbox whose
 * rows are `role="option"`. Focus is trapped while open and restored to
 * whatever had it when it closes (`useFocusTrap`).
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 */

import { useMemo, useRef, useState } from "react";

import type { KeyBinding } from "../keyboard/bindings.js";
import { useFocusTrap } from "../keyboard/use-focus-trap.js";
import { useKeyBindings } from "../keyboard/use-key-bindings.js";
import type { CommandPaletteItem } from "./model.js";
import { filterCommandPaletteItems } from "./model.js";

/** The palette's own surface name, for `data-key-scope="dialog:…"`. */
const SURFACE = "command-palette";

export interface CommandPaletteProps {
  readonly items: readonly CommandPaletteItem[];
  readonly onSelectNode: (nodeId: string) => void;
  readonly onRunVerb: (itemId: string) => void;
}

export function CommandPalette({
  items,
  onSelectNode,
  onRunVerb,
}: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useFocusTrap<HTMLDivElement>(open);

  const filtered = filterCommandPaletteItems(items, query);

  /**
   * Activating a row is one function, called by the click and by the Enter
   * binding alike — never two paths that agree by coincidence (principle 8).
   */
  function activateItem(item: CommandPaletteItem): void {
    if (item.kind === "navigate" && item.nodeId) {
      onSelectNode(item.nodeId);
    } else {
      onRunVerb(item.id);
    }
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
  }

  // The Enter binding acts on whatever is on screen *now*, so it reads the
  // filtered rows, the highlight, and the activation function through refs
  // rather than re-registering the whole set on every keystroke.
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const activateRef = useRef(activateItem);
  activateRef.current = activateItem;

  const bindings = useMemo<readonly KeyBinding[]>(() => {
    function move(delta: number): void {
      const count = filteredRef.current.length;
      setActiveIndex((current) =>
        count === 0 ? 0 : (current + delta + count) % count,
      );
    }
    return [
      {
        kind: "dispatched",
        id: "command-palette-open",
        chords: [{ key: "k", mod: true }],
        label: "open the command palette",
        description:
          "opens the one keyboard entry point for navigation and every verb",
        scope: "global",
        allowInTextEntry: true,
        run: () => setOpen(true),
      },
      {
        kind: "dispatched",
        id: "command-palette-close",
        chords: [{ key: "Escape" }, { key: "k", mod: true }],
        keysLabel: "Escape",
        label: "close the command palette",
        description: "closes the palette and returns focus where it was",
        scope: "dialog",
        surface: SURFACE,
        allowInTextEntry: true,
        run: () => setOpen(false),
      },
      {
        kind: "dispatched",
        id: "command-palette-next",
        chords: [{ key: "ArrowDown" }],
        label: "highlight the next palette row",
        description: "moves the palette's highlight down, wrapping at the end",
        scope: "dialog",
        surface: SURFACE,
        allowInTextEntry: true,
        run: () => move(1),
      },
      {
        kind: "dispatched",
        id: "command-palette-prev",
        chords: [{ key: "ArrowUp" }],
        label: "highlight the previous palette row",
        description: "moves the palette's highlight up, wrapping at the start",
        scope: "dialog",
        surface: SURFACE,
        allowInTextEntry: true,
        run: () => move(-1),
      },
      {
        kind: "dispatched",
        id: "command-palette-activate",
        chords: [{ key: "Enter" }],
        label: "run the highlighted palette row",
        description:
          "navigates to the highlighted node, or runs the highlighted verb",
        scope: "dialog",
        surface: SURFACE,
        allowInTextEntry: true,
        run: () => {
          const item = filteredRef.current[activeIndexRef.current];
          if (item) activateRef.current(item);
        },
      },
    ];
  }, []);

  useKeyBindings(bindings);

  if (!open) return null;

  const activeOptionId = filtered[activeIndex]
    ? `command-palette-option-${filtered[activeIndex]?.id}`
    : undefined;

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label="command palette"
      data-key-scope={`dialog:${SURFACE}`}
      data-testid="command-palette"
      tabIndex={-1}
    >
      <input
        role="combobox"
        aria-label="command palette query"
        aria-expanded
        aria-controls="command-palette-listbox"
        aria-autocomplete="list"
        {...(activeOptionId === undefined
          ? {}
          : { "aria-activedescendant": activeOptionId })}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
        }}
      />
      <ul
        id="command-palette-listbox"
        role="listbox"
        aria-label="command palette results"
      >
        {filtered.map((item, index) => (
          <li
            key={item.id}
            id={`command-palette-option-${item.id}`}
            role="option"
            aria-selected={index === activeIndex}
          >
            <button type="button" onClick={() => activateItem(item)}>
              {item.label}
              {item.keys === undefined ? "" : ` (${item.keys})`}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
