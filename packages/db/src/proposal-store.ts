import { eq } from "drizzle-orm";
import {
  decideProposal,
  systemClock,
  type Author,
  type Clock,
  type ProposalDecision,
  type ProposalId,
  type SessionId,
  type ToolProposal,
  type ToolTarget,
} from "@plotroom/core";
import type { PlotroomDatabase } from "./client.js";
import { EntityNotFound } from "./errors.js";
import { proposals, type ProposalRow } from "./schema.js";

/**
 * A session's proposals, at rest (principle 1, §3.8, migration 26).
 *
 * `ToolProposal` at rest and nothing more. The only transition is
 * `@plotroom/core`'s `decideProposal`, which is already human-only — a second
 * acceptance verb here would be the one that forgot to check who is accepting, and
 * the whole point of a proposal is *who* confirms it.
 *
 * A proposal is a row rather than a fact about a live call for the same reason a
 * question and an approval are: it **outlives the call that produced it**. A session
 * that proposed a standing instruction and finished is still owed an answer, and the
 * operator answering it a day later needs the proposal, its rationale, and what it
 * would do — all of which a runtime handle stopped being able to supply the moment
 * the call settled.
 */
export class ProposalStore {
  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {}

  list(): readonly ToolProposal[] {
    return this.state.db.select().from(proposals).all().map(toProposal);
  }

  pending(): readonly ToolProposal[] {
    return this.state.db
      .select()
      .from(proposals)
      .where(eq(proposals.state, "pending"))
      .all()
      .map(toProposal);
  }

  forSession(sessionId: string): readonly ToolProposal[] {
    return this.state.db
      .select()
      .from(proposals)
      .where(eq(proposals.proposedBy, sessionId))
      .all()
      .map(toProposal);
  }

  get(proposalId: string): ToolProposal {
    const found = this.find(proposalId);
    if (found === undefined) throw new EntityNotFound("proposal", proposalId);
    return found;
  }

  find(proposalId: string): ToolProposal | undefined {
    const row = this.state.db
      .select()
      .from(proposals)
      .where(eq(proposals.id, proposalId))
      .get();
    return row === undefined ? undefined : toProposal(row);
  }

  /**
   * Record a proposal core has already built. Idempotent in its own id, like a
   * raised question: the same gesture replayed writes the same row (principle 9).
   */
  create(proposal: ToolProposal): ToolProposal {
    this.state.db
      .insert(proposals)
      .values(toRow(proposal))
      .onConflictDoNothing()
      .run();
    return this.get(proposal.id);
  }

  /**
   * Accept or reject, through core's own transition.
   *
   * The refusal is returned rather than thrown, because both of its reasons are
   * answers a surface shows: "a session cannot accept this" and "somebody already
   * decided it" are facts about the gesture, not failures of the store.
   */
  decide(
    proposalId: string,
    decision: "accept" | "reject",
    by: Author,
  ): ProposalDecision {
    const proposal = this.get(proposalId);
    const decided = decideProposal(proposal, decision, by, this.now());
    if (!decided.ok) return decided;

    this.state.db
      .update(proposals)
      .set({
        state: decided.proposal.state,
        decidedAt: decided.proposal.decidedAt,
        // The column can say nothing else, and `decideProposal` has already refused
        // every session author: a proposal a session decided is one applied
        // silently (principle 1).
        decidedByKind: "human",
      })
      .where(eq(proposals.id, proposalId))
      .run();

    return { ok: true, proposal: this.get(proposalId) };
  }
}

function toRow(proposal: ToolProposal): ProposalRow {
  return {
    id: proposal.id,
    proposedBy: proposal.proposedBy,
    tool: proposal.tool,
    inputJson: JSON.stringify(proposal.input),
    targetKind: proposal.target?.kind ?? null,
    targetId: proposal.target?.id ?? null,
    rationale: proposal.rationale,
    proposedAt: proposal.proposedAt,
    state: proposal.state,
    decidedAt: proposal.decidedAt,
    decidedByKind: proposal.decidedAt === null ? null : "human",
  };
}

function toProposal(row: ProposalRow): ToolProposal {
  const target: ToolTarget | null =
    row.targetKind === null || row.targetId === null
      ? null
      : { kind: row.targetKind as ToolTarget["kind"], id: row.targetId };
  return {
    id: row.id as ProposalId,
    proposedBy: row.proposedBy as SessionId,
    tool: row.tool,
    input: JSON.parse(row.inputJson) as Record<string, unknown>,
    target,
    rationale: row.rationale,
    proposedAt: row.proposedAt,
    state: row.state,
    decidedAt: row.decidedAt,
  };
}
