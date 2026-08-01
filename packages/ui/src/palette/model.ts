/**
 * The palette (spec §5): a rail of everything not yet on the canvas, as drag
 * sources — tickets, pull requests, reviews, documents, past sessions,
 * command definitions. Two pure rules, kept separate because they answer
 * different questions:
 *
 *   - what belongs in the rail at all (`unplacedEntries`) — anything already
 *     placed is on the canvas, not the palette, by definition;
 *   - how ticket rows are ordered once they're there (`orderTicketsUnblocked
 *     First`) — "the top one is always something nothing else is blocking".
 */

export type PaletteEntryKind =
  | "ticket"
  | "pull_request"
  | "review"
  | "document"
  | "session"
  | "command_definition";

export interface PaletteEntry {
  readonly id: string;
  readonly kind: PaletteEntryKind;
  readonly label: string;
}

export interface PaletteTicketEntry extends PaletteEntry {
  readonly kind: "ticket";
  /** Ids of other objects blocking this ticket from starting (§5). */
  readonly blockedBy: readonly string[];
}

/** Anything already placed on the canvas is not a drag source anymore. */
export function unplacedEntries<T extends { readonly id: string }>(
  all: readonly T[],
  placedIds: ReadonlySet<string>,
): readonly T[] {
  return all.filter((entry) => !placedIds.has(entry.id));
}

/**
 * "Ticket rows are ordered so the top one is always something nothing else
 * is blocking" (§5): unblocked tickets first, blocked tickets after — stable
 * within each group, so a re-render doesn't reshuffle rows the operator
 * isn't blocked on anymore for reasons unrelated to blocking.
 */
export function orderTicketsUnblockedFirst(
  tickets: readonly PaletteTicketEntry[],
): readonly PaletteTicketEntry[] {
  return [...tickets].sort((a, b) => {
    const aBlocked = a.blockedBy.length > 0 ? 1 : 0;
    const bBlocked = b.blockedBy.length > 0 ? 1 : 0;
    return aBlocked - bBlocked;
  });
}
