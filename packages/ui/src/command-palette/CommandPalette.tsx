/**
 * The command palette (spec §11): one keyboard entry point for navigation
 * and every verb. Cmd/Ctrl+K opens it from anywhere; Escape closes it; arrow
 * keys move the highlighted row; Enter activates it. Navigation always goes
 * through `onSelectNode` — the one navigation primitive (§5) shared with the
 * canvas click and the attention queue.
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 * An accessible listbox (aria roles, announced state) is Epic 8.1's job; this
 * uses the right roles now so that epic is additive, not a rewrite.
 */

import { useEffect, useRef, useState } from "react";

import type { CommandPaletteItem } from "./model.js";
import { filterCommandPaletteItems } from "./model.js";

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
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = filterCommandPaletteItems(items, query);

  function activate(item: CommandPaletteItem) {
    if (item.kind === "navigate" && item.nodeId) {
      onSelectNode(item.nodeId);
    } else {
      onRunVerb(item.id);
    }
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isToggle =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (isToggle) {
        event.preventDefault();
        setOpen((current) => !current);
        return;
      }
      if (!open) return;

      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((current) =>
          filtered.length === 0 ? 0 : (current + 1) % filtered.length,
        );
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((current) =>
          filtered.length === 0
            ? 0
            : (current - 1 + filtered.length) % filtered.length,
        );
      } else if (event.key === "Enter") {
        event.preventDefault();
        const item = filtered[activeIndex];
        if (item) activate(item);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, filtered, activeIndex]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div role="dialog" aria-label="command palette">
      <input
        ref={inputRef}
        role="combobox"
        aria-expanded
        aria-controls="command-palette-listbox"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
        }}
      />
      <ul id="command-palette-listbox" role="listbox">
        {filtered.map((item, index) => (
          <li key={item.id} role="option" aria-selected={index === activeIndex}>
            <button type="button" onClick={() => activate(item)}>
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
