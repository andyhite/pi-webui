import type { Author } from "../author.js";
import type { NodeId, ObjectId, VersionId } from "../ids.js";

/**
 * Triage verbs (§4.5): "Every drift flag (and every other attention feed, §7)
 * supports the triage verbs: acknowledge (seen; the consumer's baseline
 * advances without running anything — a typo fix on a ticket shouldn't cost
 * eight decisions), snooze (bring it back later), and mute (never show this one
 * again)."
 *
 * Acknowledging is bookkeeping, never initiation: nothing here starts work, and
 * the product never originates any (principle 2).
 */
export const TRIAGE_VERBS = ["acknowledge", "snooze", "mute"] as const;

export type TriageVerb = (typeof TRIAGE_VERBS)[number];

export type TriageStatus = "active" | "acknowledged" | "snoozed" | "muted";

/** One attention item. Drift items are keyed by consumer and input (§4.5). */
export type AttentionItemKey = string & { readonly __attentionItem?: never };

export function driftItemKey(consumer: NodeId, objectId: ObjectId): string {
  return `drift:${consumer}:${objectId}`;
}

export interface TriageRecord {
  readonly verb: TriageVerb;
  readonly at: number;
  readonly by: Author;
  /**
   * Acknowledge advances the consumer's baseline to the version it was shown.
   * The next change past this version drifts again; this one does not.
   */
  readonly baselineVersionId: VersionId | null;
  /** Snooze only: when the item comes back. */
  readonly snoozedUntil: number | null;
}

export type TriageLedger = ReadonlyMap<string, TriageRecord>;

export const EMPTY_TRIAGE: TriageLedger = new Map<string, TriageRecord>();

export interface TriageInput {
  readonly at: number;
  readonly by: Author;
  /** Required for acknowledge: the version the human or agent actually saw. */
  readonly baselineVersionId?: VersionId;
  /** Required for snooze. */
  readonly snoozedUntil?: number;
}

export function applyTriage(
  ledger: TriageLedger,
  key: string,
  verb: TriageVerb,
  input: TriageInput,
): TriageLedger {
  const next = new Map(ledger);
  next.set(key, {
    verb,
    at: input.at,
    by: input.by,
    baselineVersionId:
      verb === "acknowledge" ? (input.baselineVersionId ?? null) : null,
    snoozedUntil: verb === "snooze" ? (input.snoozedUntil ?? null) : null,
  });
  return next;
}

/** Undo a triage decision — a mute you regret is recoverable like anything else. */
export function clearTriage(ledger: TriageLedger, key: string): TriageLedger {
  if (!ledger.has(key)) return ledger;
  const next = new Map(ledger);
  next.delete(key);
  return next;
}

/**
 * The status right now. A snooze that has elapsed is active again — "bring it
 * back later" is the whole verb — while acknowledge and mute do not expire.
 */
export function triageStatus(
  record: TriageRecord | undefined,
  now: number,
): TriageStatus {
  if (!record) return "active";
  switch (record.verb) {
    case "acknowledge":
      return "acknowledged";
    case "mute":
      return "muted";
    case "snooze":
      return record.snoozedUntil !== null && now >= record.snoozedUntil
        ? "active"
        : "snoozed";
  }
}

/**
 * Has the fact an acknowledgement was made about moved on, by **version**?
 *
 * §4.5's acknowledge is "seen; the consumer's baseline advances" — a baseline,
 * not a permanent dismissal, which is what `mute` is for. So it covers exactly
 * the version it was made about: while the object is still on that version the
 * row stays hidden, and the moment a further version lands the row is drift
 * again.
 *
 * Stated here, once, because both the drift derivation (which has the versions)
 * and the attention join (which has the ledger) need this answer, and a second
 * copy of the rule is what principle 8 forbids. It is also the *precise* form of
 * the rule: two facts recorded in the same second are indistinguishable by time,
 * and not ambiguous at all by baseline.
 */
export function acknowledgementSuperseded(
  record: TriageRecord | undefined,
  latestVersionId: VersionId | null,
): boolean {
  if (record === undefined || record.verb !== "acknowledge") return false;
  if (record.baselineVersionId === null || latestVersionId === null) {
    // Nothing to compare: an acknowledgement with no baseline recorded, or a row
    // about something that has no version, expires on nothing here.
    return false;
  }
  return record.baselineVersionId !== latestVersionId;
}

/** Does this item belong in the queue right now (§7.1)? */
export function isVisible(status: TriageStatus): boolean {
  return status === "active";
}
