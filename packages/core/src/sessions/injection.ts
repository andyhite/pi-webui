import type { Author } from "../author.js";
import { checkAuthoring, type LineageIndex } from "../lineage.js";
import type {
  EdgeId,
  NodeId,
  ObjectId,
  SessionId,
  WorkstreamId,
} from "../ids.js";
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

/* ------------------------------------------------ injection as a graph act */

/**
 * "Content added to a running session mid-flight arrives as a new turn — and as
 * content on the graph, wired to the session, permanently" (§6.5, principle 5).
 *
 * So one injection gesture is three writes, and this plan is all three: a
 * content object, a node standing for it, and a **context edge into the session
 * carrying the injector as its author** (§15-2). Steering is authoring, so
 * nothing here is optional — a plan cannot describe an injection that leaves no
 * paper trail, because the fields are required.
 *
 * Pure, and every id comes from the caller: one gesture replayed writes the same
 * rows rather than a second set (principle 9). Track A persists the plan; core
 * decides what it contains and whether it is allowed.
 */
export interface InjectionIds {
  readonly injectionId: InjectionId;
  readonly objectId: ObjectId;
  readonly nodeId: NodeId;
  readonly edgeId: EdgeId;
}

export interface InjectionRequest {
  readonly ids: InjectionIds;
  /** The session node on the board — what a context edge can legally point at (§3.7). */
  readonly targetNodeId: NodeId;
  readonly author: Author;
  readonly text: string;
  /** Assembly order of this input into the session (§3.5); the caller counts. */
  readonly ordinal: number;
  readonly at: number;
}

/** The content object an injection leaves behind, as `ObjectStore` needs it. */
export interface InjectionContent {
  readonly objectId: ObjectId;
  readonly nodeId: NodeId;
  /** A note: an injection is authored prose, not a read of an outside system. */
  readonly kind: "note";
  /** Local to the workstream the session runs in; promotable like anything else (§3.2). */
  readonly scope: "local";
  readonly title: string;
  readonly body: string;
  readonly createdAt: number;
}

/** The context edge, with the author §15-2 forbids leaving out. */
export interface InjectionEdge {
  readonly id: EdgeId;
  readonly kind: "context";
  readonly from: NodeId;
  readonly to: NodeId;
  readonly author: Author;
  readonly ordinal: number;
  readonly createdAt: number;
}

export interface InjectionPlan {
  readonly sessionId: SessionId;
  readonly workstreamId: WorkstreamId;
  readonly content: InjectionContent;
  readonly edge: InjectionEdge;
  /** What the ledger records once the runtime accepts the input (§6.5). */
  readonly ledgerEntry: QueuedInjection;
}

export type InjectionPlanResult =
  | { readonly ok: true; readonly plan: InjectionPlan }
  | { readonly ok: false; readonly refusal: InjectionRefusal };

/**
 * A single-line label for the node, because a graph of notes titled by their
 * first eighty characters is readable and a graph of "Injection" is not.
 */
export function injectionTitle(text: string): string {
  const firstLine = text.trim().split("\n", 1)[0] ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "steering";
  return collapsed.length > 80 ? `${collapsed.slice(0, 79)}…` : collapsed;
}

/**
 * Plan one injection — human or session, the same gesture either way.
 *
 * "Injection is a peer gesture: humans inject, and sessions inject into *other*
 * sessions... attributed either way, on the graph either way." The only
 * difference between the two is which author the edge carries, and whether
 * `checkInjection`'s lineage half refuses (out-of-chain peers only, principle 1).
 */
export function planInjection(
  index: LineageIndex,
  target: Session,
  request: InjectionRequest,
): InjectionPlanResult {
  const check = checkInjection(index, request.author, target);
  if (!check.allowed) return { ok: false, refusal: check.refusal };

  return {
    ok: true,
    plan: {
      sessionId: target.id,
      workstreamId: target.workstreamId,
      content: {
        objectId: request.ids.objectId,
        nodeId: request.ids.nodeId,
        kind: "note",
        scope: "local",
        title: injectionTitle(request.text),
        body: request.text,
        createdAt: request.at,
      },
      edge: {
        id: request.ids.edgeId,
        kind: "context",
        from: request.ids.nodeId,
        to: request.targetNodeId,
        author: request.author,
        ordinal: request.ordinal,
        createdAt: request.at,
      },
      ledgerEntry: {
        id: request.ids.injectionId,
        sessionId: target.id,
        author: request.author,
        nodeId: request.ids.nodeId,
        text: request.text,
        queuedAt: request.at,
      },
    },
  };
}
