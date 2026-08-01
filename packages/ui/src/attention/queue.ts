/**
 * The queue's pure mechanics (§7.1): "a single ranked list of everything
 * wanting a decision, keyboard-driven ... every feed supports acknowledge,
 * snooze, and mute (§4.5)." Consumes `@plotroom/core`'s triage module
 * directly (`applyTriage`/`triageStatus`) rather than re-deriving what
 * "active" means — the one rule §4.5 names, called from here the same way
 * the server's own drift path calls it.
 */

import {
  applyTriage,
  triageStatus,
  type TriageLedger,
  type TriageVerb,
} from "@plotroom/core";

import type { AttentionItem } from "./types.js";
import type { TriageActionInput } from "./types.js";

/**
 * Ranking + visibility, together: "everything wanting a decision" excludes
 * whatever triage has already dismissed. Sorted by the item's own `rank`
 * ascending (assigned upstream — this never recomputes priority, only
 * orders by it), tie-broken by `raisedAt` ascending so two equally-ranked
 * items keep the older one first.
 */
export function visibleAttentionItems(
  items: readonly AttentionItem[],
  ledger: TriageLedger,
  now: number,
): readonly AttentionItem[] {
  return items
    .filter((item) => triageStatus(ledger.get(item.id), now) === "active")
    .slice()
    .sort((a, b) => a.rank - b.rank || a.raisedAt - b.raisedAt);
}

/**
 * j/k or arrow traversal (§11 "keyboard access to the high-frequency
 * verbs"). Clamped, not wrapping: pressing "next" at the last row or "prev"
 * at the first is a no-op rather than jumping to the other end, which is
 * what a keyboard-driven list should do when there is nowhere further to
 * go. `null` in, `null` out (nothing selected, nothing to move from) and an
 * empty list leave the selection at `null`.
 */
export function moveQueueSelection(
  items: readonly AttentionItem[],
  currentId: string | null,
  direction: "next" | "prev",
): string | null {
  if (items.length === 0) return null;
  if (currentId === null) return items[0]?.id ?? null;

  const index = items.findIndex((item) => item.id === currentId);
  if (index === -1) return items[0]?.id ?? null;

  const nextIndex =
    direction === "next"
      ? Math.min(index + 1, items.length - 1)
      : Math.max(index - 1, 0);
  return items[nextIndex]?.id ?? null;
}

/**
 * Applies one triage verb to the ledger — the in-place reducer every queue
 * gesture (acknowledge/snooze/mute, and answering, which also acknowledges)
 * goes through. Kept as a thin, testable wrapper over `@plotroom/core`'s
 * `applyTriage` so the queue never reimplements §4.5's rule at this call
 * site (principle 8).
 */
export function applyQueueTriage(
  ledger: TriageLedger,
  itemId: string,
  verb: TriageVerb,
  input: TriageActionInput & { readonly snoozedUntil?: number },
): TriageLedger {
  return applyTriage(ledger, itemId, verb, input);
}

/**
 * Answering a question or deciding an approval acknowledges it in the same
 * gesture (§7.1: "each row carries enough context to answer without
 * opening anything" — the row leaving the queue *is* the confirmation the
 * answer registered). A pure convenience over `applyQueueTriage` so every
 * answer path applies triage identically rather than three call sites
 * agreeing on it by coincidence.
 */
export function acknowledgeOnAnswer(
  ledger: TriageLedger,
  itemId: string,
  input: TriageActionInput,
): TriageLedger {
  return applyQueueTriage(ledger, itemId, "acknowledge", input);
}
