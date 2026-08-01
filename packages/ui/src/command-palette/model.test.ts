import { describe, expect, it } from "vitest";

import { filterCommandPaletteItems } from "./model.js";
import type { CommandPaletteItem } from "./model.js";

const ITEMS: CommandPaletteItem[] = [
  { id: "nav-1", label: "ticket OXY-2982", kind: "navigate", nodeId: "t1" },
  { id: "nav-2", label: "command: implement", kind: "navigate", nodeId: "c1" },
  { id: "verb-stop", label: "stop everything", kind: "verb" },
];

describe("filterCommandPaletteItems", () => {
  it("returns everything for an empty query", () => {
    expect(filterCommandPaletteItems(ITEMS, "")).toEqual(ITEMS);
    expect(filterCommandPaletteItems(ITEMS, "   ")).toEqual(ITEMS);
  });

  it("matches case-insensitively on a substring of the label", () => {
    expect(filterCommandPaletteItems(ITEMS, "OXY")).toEqual([ITEMS[0]]);
    expect(filterCommandPaletteItems(ITEMS, "oxy")).toEqual([ITEMS[0]]);
  });

  it("matches across kinds", () => {
    expect(filterCommandPaletteItems(ITEMS, "stop")).toEqual([ITEMS[2]]);
  });

  it("returns nothing when no label matches", () => {
    expect(filterCommandPaletteItems(ITEMS, "nonexistent")).toEqual([]);
  });
});
