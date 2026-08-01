import type { Author } from "../author.js";
import { checkAuthoring, type LineageIndex } from "../lineage.js";
import type { NodeId, SessionId } from "../ids.js";
import { acceptsInjection, type Session } from "./session.js";
import type { InjectionId } from "./runtime.js";

/**
 * The injection ledger (§6.5, decision 0001).
 *
 * "Delivery is not instantaneous: a runtime may only accept input between
 * turns, so an injection during a long tool call shows as queued until
 * delivered." `inject()` resolving means the runtime took the input into its
 * queue; delivery is a separate observation. PlotRoom keeps both, so the UI can
 * show the difference honestly instead of pretending the message landed.
 *
 * Injection is also authoring: every entry carries its author and the content
 * node it put on the graph, permanently (principle 1, principle 5).
 */
export type InjectionStatus = "queued" | "delivered" | "refused";

export interface InjectionEntry {
  readonly id: InjectionId;
  readonly sessionId: SessionId;
  readonly author: Author;
  /** The content node wired to the session — steering leaves a paper trail. */
  readonly nodeId: NodeId;
  readonly text: string;
  readonly queuedAt: number;
  readonly deliveredAt: number | null;
  /** Set when the runtime never took it (the session ended first, say). */
  readonly refusedAt: number | null;
  readonly refusedReason: string | null;
}

export type InjectionLedger = ReadonlyMap<InjectionId, InjectionEntry>;

export const EMPTY_INJECTIONS: InjectionLedger = new Map<
  InjectionId,
  InjectionEntry
>();

export interface QueuedInjection {
  readonly id: InjectionId;
  readonly sessionId: SessionId;
  readonly author: Author;
  readonly nodeId: NodeId;
  readonly text: string;
  readonly queuedAt: number;
}

/** Record queue acceptance — what `inject()` resolving actually proves. */
export function queueInjection(
  ledger: InjectionLedger,
  injection: QueuedInjection,
): InjectionLedger {
  if (ledger.has(injection.id)) return ledger; // one gesture, one entry (principle 9)
  const next = new Map(ledger);
  next.set(injection.id, {
    ...injection,
    deliveredAt: null,
    refusedAt: null,
    refusedReason: null,
  });
  return next;
}

/** Record the observed `injection-delivered` event, and only that. */
export function markDelivered(
  ledger: InjectionLedger,
  id: InjectionId,
  at: number,
): InjectionLedger {
  const entry = ledger.get(id);
  if (!entry || entry.deliveredAt !== null || entry.refusedAt !== null) {
    return ledger;
  }
  const next = new Map(ledger);
  next.set(id, { ...entry, deliveredAt: at });
  return next;
}

export function markRefused(
  ledger: InjectionLedger,
  id: InjectionId,
  at: number,
  reason: string,
): InjectionLedger {
  const entry = ledger.get(id);
  if (!entry || entry.deliveredAt !== null || entry.refusedAt !== null) {
    return ledger;
  }
  const next = new Map(ledger);
  next.set(id, { ...entry, refusedAt: at, refusedReason: reason });
  return next;
}

export function injectionStatus(entry: InjectionEntry): InjectionStatus {
  if (entry.refusedAt !== null) return "refused";
  return entry.deliveredAt === null ? "queued" : "delivered";
}

export function queuedInjections(
  ledger: InjectionLedger,
  sessionId?: SessionId,
): readonly InjectionEntry[] {
  return [...ledger.values()]
    .filter(
      (entry) =>
        injectionStatus(entry) === "queued" &&
        (sessionId === undefined || entry.sessionId === sessionId),
    )
    .sort((a, b) => a.queuedAt - b.queuedAt);
}

/** How long "queued" lasted — the number the UI needs to be honest (§6.5). */
export function deliveryDelay(entry: InjectionEntry): number | null {
  return entry.deliveredAt === null ? null : entry.deliveredAt - entry.queuedAt;
}

export type InjectionRefusal =
  | { readonly reason: "session_not_running"; readonly message: string }
  | { readonly reason: "own_chain"; readonly message: string };

export type InjectionCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: InjectionRefusal };

/**
 * Whether this injection may happen at all. Both halves delegate to the
 * predicates that already state the rule — the legality of an edge into a
 * session (§3.7) and the reflexivity asymmetry (principle 1) — because a rule
 * restated at a call site is a rule that will disagree with itself.
 */
export function checkInjection(
  index: LineageIndex,
  author: Author,
  target: Session,
): InjectionCheck {
  if (!acceptsInjection(target)) {
    return {
      allowed: false,
      refusal: {
        reason: "session_not_running",
        message: "that session has ended; fork or re-run it instead",
      },
    };
  }

  const authoring = checkAuthoring(index, author, target.id);
  if (!authoring.allowed) {
    return { allowed: false, refusal: authoring.refusal };
  }

  return { allowed: true };
}
