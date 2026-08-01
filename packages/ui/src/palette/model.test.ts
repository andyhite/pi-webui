import { describe, expect, it } from "vitest";

import { orderTicketsUnblockedFirst, unplacedEntries } from "./model.js";
import type { PaletteTicketEntry } from "./model.js";

describe("unplacedEntries", () => {
  it("keeps only entries whose id is not already placed on the canvas", () => {
    const entries = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const placed = new Set(["b"]);
    expect(unplacedEntries(entries, placed)).toEqual([
      { id: "a" },
      { id: "c" },
    ]);
  });

  it("returns everything when nothing is placed", () => {
    const entries = [{ id: "a" }, { id: "b" }];
    expect(unplacedEntries(entries, new Set())).toEqual(entries);
  });

  it("returns nothing when everything is placed", () => {
    const entries = [{ id: "a" }, { id: "b" }];
    expect(unplacedEntries(entries, new Set(["a", "b"]))).toEqual([]);
  });
});

describe("orderTicketsUnblockedFirst", () => {
  const ticket = (
    id: string,
    blockedBy: readonly string[] = [],
  ): PaletteTicketEntry => ({
    id,
    kind: "ticket",
    label: id,
    blockedBy,
  });

  it("puts unblocked tickets before blocked ones", () => {
    const tickets = [
      ticket("blocked-1", ["dep"]),
      ticket("unblocked-1"),
      ticket("blocked-2", ["dep"]),
      ticket("unblocked-2"),
    ];
    const ordered = orderTicketsUnblockedFirst(tickets);
    expect(ordered.map((t) => t.id)).toEqual([
      "unblocked-1",
      "unblocked-2",
      "blocked-1",
      "blocked-2",
    ]);
  });

  it("the top row is always something nothing else is blocking", () => {
    const tickets = [
      ticket("blocked-1", ["dep"]),
      ticket("blocked-2", ["dep"]),
      ticket("unblocked-1"),
    ];
    const [top] = orderTicketsUnblockedFirst(tickets);
    expect(top?.blockedBy).toEqual([]);
  });

  it("is stable within each group", () => {
    const tickets = [ticket("a"), ticket("b"), ticket("c")];
    expect(orderTicketsUnblockedFirst(tickets).map((t) => t.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("does not mutate the input array", () => {
    const tickets = [ticket("blocked", ["dep"]), ticket("unblocked")];
    const copy = [...tickets];
    orderTicketsUnblockedFirst(tickets);
    expect(tickets).toEqual(copy);
  });
});
