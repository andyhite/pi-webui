import type { Author } from "../../author.js";
import type { CommandId, SessionId, WorkstreamId } from "../../ids.js";
import type { ProvenanceKind } from "../../edges.js";
import { ancestorsOf, type Lineage, type LineageIndex } from "../../lineage.js";
import type { BudgetScope } from "../end-states.js";

/**
 * Delegation, provenance, and spend attribution (Epic 4.5, §3.6, principle 2).
 *
 * "A session may delegate to child sessions... Every delegated or dispatched
 * session is visible on the graph with its provenance, never hidden inside a tool
 * call; its spend counts against every budget that binds the initiating work."
 *
 * Two halves land here. The **provenance** half is a plan: dispatching produces a
 * child session with a recorded lineage and a `session_delegated` provenance edge,
 * which is what makes principle 5 hold ("there is never an invisible session").
 * The **attribution** half is the data budgets will enforce against in Phase 6 —
 * shaped now, because attribution that starts being recorded later cannot answer
 * what an earlier chain cost.
 */

export interface DelegationRequest {
  readonly parentSessionId: SessionId;
  readonly childSessionId: SessionId;
  readonly workstreamId: WorkstreamId;
  /** The command the child runs. Dispatch is running a command, not a new concept. */
  readonly commandId: CommandId;
  /** Why, recorded with the provenance rather than only in a transcript. */
  readonly reason: string | null;
  readonly at: number;
}

/**
 * The provenance edge a dispatch records. `session_delegated` already exists in
 * the §3.7 vocabulary — this names which relation a dispatch is, it does not add
 * one.
 */
export interface DelegationProvenance {
  readonly relation: ProvenanceKind;
  readonly fromSessionId: SessionId;
  readonly toSessionId: SessionId;
  readonly recordedAt: number;
}

export interface DelegationPlan {
  readonly childSessionId: SessionId;
  readonly workstreamId: WorkstreamId;
  readonly commandId: CommandId;
  readonly lineage: Lineage;
  readonly provenance: DelegationProvenance;
  /** Child first, then every ancestor up to the human gesture (principle 2). */
  readonly attributionChain: readonly SessionId[];
  readonly reason: string | null;
}

/**
 * Plan a dispatch. Pure: it produces the records Track A writes, so a retry that
 * replays the same plan writes the same rows (principle 9 is the caller's, with
 * the child id it supplies).
 */
export function planDelegation(
  index: LineageIndex,
  request: DelegationRequest,
): DelegationPlan {
  return {
    childSessionId: request.childSessionId,
    workstreamId: request.workstreamId,
    commandId: request.commandId,
    lineage: {
      sessionId: request.childSessionId,
      initiatedBy: request.parentSessionId,
    },
    provenance: {
      relation: "session_delegated",
      fromSessionId: request.parentSessionId,
      toSessionId: request.childSessionId,
      recordedAt: request.at,
    },
    attributionChain: attributionChainFor(index, request.childSessionId, {
      [request.childSessionId]: request.parentSessionId,
    }),
    reason: request.reason,
  };
}

/**
 * The chain a session's spend is attributed to: itself, then every ancestor.
 *
 * `pending` lets a chain be computed for a session the index does not know yet —
 * the child being planned. Without it, the first thing a dispatch would have to do
 * is persist, and the plan could not be checked before writing anything.
 */
export function attributionChainFor(
  index: LineageIndex,
  sessionId: SessionId,
  pending: Readonly<Record<string, SessionId | null>> = {},
): readonly SessionId[] {
  const joined: LineageIndex = {
    parentOf: (session) =>
      session in pending ? (pending[session] ?? null) : index.parentOf(session),
  };
  return [sessionId, ...ancestorsOf(joined, sessionId)];
}

/** One session's spend, as observed; the basis is named, never assumed (§8). */
export interface SessionSpend {
  readonly sessionId: SessionId;
  readonly amountUsd: number;
  readonly basis: "reported" | "priced";
  readonly at: number;
}

export const SPEND_ATTRIBUTION_BASES = [
  /** The session that spent it. */
  "own",
  /** A session in the chain that initiated the spender's work (principle 2). */
  "descendant",
] as const;

export type SpendAttributionBasis = (typeof SPEND_ATTRIBUTION_BASES)[number];

/**
 * One row of the attribution ledger: this session's budgets are charged this
 * amount, because that session spent it.
 *
 * Kept as rows rather than as running totals so a budget at any scope is a query,
 * and so a chain's cost stays answerable after the fact — the same reason run
 * history records what it records (§15-1).
 */
export interface SpendAttributionEntry {
  readonly sessionId: SessionId;
  readonly sourceSessionId: SessionId;
  readonly basis: SpendAttributionBasis;
  readonly amountUsd: number;
  readonly costBasis: SessionSpend["basis"];
  readonly at: number;
}

/**
 * "Its spend counts against every budget that binds the initiating work."
 *
 * Every session in the chain gets a row: the spender as `own`, each ancestor as
 * `descendant`. Summing rows for a session gives what its budget must count,
 * including everything its delegates spent.
 */
export function attributeSpend(
  chain: readonly SessionId[],
  spend: SessionSpend,
): readonly SpendAttributionEntry[] {
  return chain.map((sessionId) => ({
    sessionId,
    sourceSessionId: spend.sessionId,
    basis: sessionId === spend.sessionId ? "own" : "descendant",
    amountUsd: spend.amountUsd,
    costBasis: spend.basis,
    at: spend.at,
  }));
}

/** What a session in the chain has been charged, own work and delegates alike. */
export function attributedTotal(
  entries: readonly SpendAttributionEntry[],
  sessionId: SessionId,
): number {
  return entries
    .filter((entry) => entry.sessionId === sessionId)
    .reduce((total, entry) => total + entry.amountUsd, 0);
}

/**
 * The budget scopes a dispatch's spend will be checked against in Phase 6. Stated
 * here so the shapes the enforcement needs exist while the enforcement does not:
 * a run budget binds the initiating run, the workstream's binds everything inside
 * it, and the global one binds everything (§8).
 */
export interface DelegationBudgetTap {
  readonly childSessionId: SessionId;
  readonly scopes: readonly BudgetScope[];
  readonly chargedTo: readonly SessionId[];
  /** Who authored the dispatch — a session, or the human who started the chain. */
  readonly initiatedBy: Author;
}

export function budgetTapFor(
  plan: DelegationPlan,
  initiatedBy: Author,
): DelegationBudgetTap {
  return {
    childSessionId: plan.childSessionId,
    scopes: ["run", "workstream", "global"],
    chargedTo: plan.attributionChain,
    initiatedBy,
  };
}
