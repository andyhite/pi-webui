import {
  acceptedStandingInstruction,
  describeStandingInstructionProposal,
  newProposalId,
  newStandingInstructionId,
  proposalAsk,
  proposeStandingInstruction,
  proposeToolCall,
  retireStandingInstruction,
  STANDING_INSTRUCTION_DECLARE_TOOL,
  STANDING_INSTRUCTION_RETIRE_TOOL,
  type Author,
  type Clock,
  type DomainEvent,
  type ObjectId,
  type SessionId,
  type StandingInstruction,
  type ToolProposal,
} from "@plotroom/core";
import type { ProposalStore, StandingInstructionStore } from "@plotroom/db";
import type { ApprovalService } from "../approvals/service.js";
import type { EventBus, Unsubscribe } from "../events/bus.js";
import { badRequest, forbidden, notFound, refused } from "../http/errors.js";
import type { Logger } from "../logging/logger.js";

/**
 * Proposals: the agent proposes, a human accepts (principle 1, §3.8, Epic 7.4).
 *
 * Three properties of this file are decisions rather than mechanics.
 *
 * **A pending proposal reaches §7.1 as an approval, and that is the only queue row
 * it gets.** `ATTENTION_FEEDS` is closed at six, so a proposal is surfaced through
 * the channel §6.6 already owns — as the `standing-instruction` `ApprovalKind`, whose
 * sentence is `describeStandingInstructionProposal`'s so no surface words it twice.
 * Nothing about it can be pre-granted: `preGrantable` returns null for that kind, so
 * an "allow always" covering a proposal is not something any call site can express.
 *
 * **There are two entry points and one path.** The operator can answer the approval
 * from the queue, or call `POST /api/proposals/:id/accept`; either way this class
 * decides the proposal once and settles the other side. The approval-answered
 * direction arrives over the **event stream** rather than through a callback into
 * `ApprovalService`, which is the same shape `subscribeToClaimWaits` and
 * `PluginService.onEvent` already use — the fact is published, and a second
 * notification path would be a second place to keep the derivation right (and a
 * circular dependency between the two services besides).
 *
 * **Applying is the accepting human's own act.** `acceptedStandingInstruction` is
 * the only path from a proposal to a marker and it records the *human* as the author,
 * never the proposing session: the graph records who decided what agents know
 * (§15-2). A retire proposal is the asymmetric case — see {@link applyAccepted}.
 */
export interface ProposalServiceDeps {
  readonly proposals: ProposalStore;
  readonly instructions: StandingInstructionStore;
  readonly approvals: ApprovalService;
  readonly bus: EventBus;
  readonly logger: Logger;
  /** Unix seconds, shared with the stores so a test drives all of it. */
  readonly clock: Clock;
}

export interface DecidedProposal {
  readonly proposal: ToolProposal;
  /** The marker an accepted declare-proposal produced, when it produced one. */
  readonly instruction: StandingInstruction | null;
}

export class ProposalService {
  constructor(private readonly deps: ProposalServiceDeps) {}

  /**
   * A session's proposal, raised for the operator to answer.
   *
   * Only the two standing-instruction tools are proposable today, and an unknown
   * tool is refused rather than stored: a proposal nothing could ever apply would
   * sit in the queue asking a question with no answer.
   */
  create(input: {
    readonly tool: string;
    readonly input: Record<string, unknown>;
    readonly rationale?: string | undefined;
    readonly actor: Author;
  }): ToolProposal {
    if (input.actor.kind !== "session") {
      // The operator has the gesture itself (`POST /api/standing-instructions`),
      // so a human proposing to themselves would be a queue row they raised to
      // answer — one gesture split in two (principle 9).
      throw badRequest(
        "a proposal is a session's: the operator declares a standing instruction directly (§3.8, principle 1)",
      );
    }
    const objectId = input.input["objectId"];
    if (typeof objectId !== "string" || objectId.length === 0) {
      throw badRequest(
        `a ${input.tool} proposal names the object it is about, as objectId`,
      );
    }
    if (
      input.tool !== STANDING_INSTRUCTION_DECLARE_TOOL &&
      input.tool !== STANDING_INSTRUCTION_RETIRE_TOOL
    ) {
      throw badRequest(
        `${input.tool} is not a proposable tool; ${STANDING_INSTRUCTION_DECLARE_TOOL} and ${STANDING_INSTRUCTION_RETIRE_TOOL} are (§3.8)`,
      );
    }

    const id = newProposalId();
    const proposedBy = input.actor.sessionId as SessionId;
    const at = this.deps.clock();
    const rationale =
      input.rationale === undefined ? {} : { rationale: input.rationale };

    const proposal = this.deps.proposals.create(
      input.tool === STANDING_INSTRUCTION_DECLARE_TOOL
        ? proposeStandingInstruction({
            id,
            proposedBy,
            objectId: objectId as ObjectId,
            ...rationale,
            at,
          })
        : // The retire verb has no builder of its own in core, and does not need
          // one: it is the same proposal record naming the other tool, which is
          // exactly what `proposeToolCall` produces.
          proposeToolCall({
            id,
            proposedBy,
            call: { tool: input.tool, input: { objectId } },
            ...rationale,
            at,
          }),
    );

    this.raise(proposal);
    return proposal;
  }

  get(proposalId: string): ToolProposal {
    return this.deps.proposals.get(proposalId);
  }

  pending(): readonly ToolProposal[] {
    return this.deps.proposals.pending();
  }

  /**
   * Accept or reject — the operator's gesture, enforced by the request's actor
   * (`ClaimService.requireOperator`'s own convention) as well as by
   * `decideProposal`, which refuses every session author.
   */
  async decide(input: {
    readonly proposalId: string;
    readonly decision: "accept" | "reject";
    readonly actor: Author;
    readonly reason?: string | undefined;
  }): Promise<DecidedProposal> {
    if (input.actor.kind !== "human") {
      throw forbidden(
        "accepting or declining a proposal is the operator's gesture; a session deciding one applies it silently (§3.8, principle 1)",
      );
    }
    if (this.deps.proposals.find(input.proposalId) === undefined) {
      throw notFound(`no proposal ${input.proposalId}`);
    }

    const decided = this.deps.proposals.decide(
      input.proposalId,
      input.decision,
      input.actor,
    );
    if (!decided.ok) throw refused(decided.refusal);

    const instruction =
      input.decision === "accept"
        ? this.applyAccepted(decided.proposal, input.actor)
        : null;

    await this.settleApproval(
      decided.proposal,
      input.decision,
      input.reason ?? null,
    );

    return { proposal: decided.proposal, instruction };
  }

  /**
   * The operator answering the queue row is answering the proposal (§7.1).
   *
   * Edge-triggered on the approval's own answer, and idempotent through the
   * proposal's state: whichever entry point ran first, the second finds the
   * proposal already decided and does nothing.
   */
  subscribe(): Unsubscribe {
    return this.deps.bus.subscribe((event: DomainEvent) => {
      if (event.entity !== "approval" || event.verb !== "updated") return;
      const approval = event.approval;
      if (approval.kind !== "standing-instruction") return;
      const answer = approval.answer;
      if (answer === null) return;

      const proposalId = approval.ask.target?.id;
      if (proposalId === undefined) return;
      const proposal = this.deps.proposals.find(proposalId);
      if (proposal === undefined || proposal.state !== "pending") return;

      // The state change happens before this promise's first await, so a caller
      // that answered over HTTP reads a decided proposal in the same request.
      void this.decide({
        proposalId,
        decision: answer.decision === "approve-once" ? "accept" : "reject",
        actor: answer.by,
        ...(answer.reason === null ? {} : { reason: answer.reason }),
      }).catch((error: unknown) => {
        this.deps.logger.error("could not apply an answered proposal", {
          proposalId,
          approvalId: approval.id,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  /* ------------------------------------------------------------------ internals */

  /**
   * What an accepted proposal does, as the accepting human's act.
   *
   * The two verbs are **deliberately asymmetric**, because core is. A declare
   * proposal goes through `acceptedStandingInstruction`, which is the only path from
   * a proposal to a marker and re-checks every rule (the proposal's state, its tool,
   * its object, and whether that object may be standing at all — acceptance does not
   * widen the rule).
   *
   * A **retire** proposal has no such helper: `acceptedStandingInstruction` refuses
   * it as `wrong_tool`, and that is not an omission to work around. Retiring is not
   * "produce a record attributed to the human"; it is the human performing the same
   * verb they would perform unprompted, so this calls `retireStandingInstruction`
   * **as the human directly** — the same function `POST`/`DELETE
   * /api/standing-instructions/:id` calls, with the same author and the same
   * refusals. Inventing an `acceptedRetire` in core would be a second statement of a
   * rule that already has one.
   */
  private applyAccepted(
    proposal: ToolProposal,
    actor: Author,
  ): StandingInstruction | null {
    const objectId = String(proposal.input["objectId"] ?? "");

    if (proposal.tool === STANDING_INSTRUCTION_RETIRE_TOOL) {
      const live = this.deps.instructions
        .live()
        .find((instruction) => instruction.objectId === objectId);
      if (live === undefined) {
        throw badRequest(
          `${objectId} is not currently a standing instruction, so there is nothing to retire (§3.8)`,
        );
      }
      const retired = retireStandingInstruction(live, actor, this.deps.clock());
      if (!retired.ok) throw refused(retired.refusal);
      const stored = this.deps.instructions.retire(live.id, actor);
      if (!stored.ok) throw refused(stored.refusal);
      this.publish(stored.value, "updated", actor);
      return stored.value;
    }

    // The object's own kind and scope, read from the store rather than supplied,
    // so acceptance checks the stored facts (§3.8: acceptance does not widen the
    // rule about what may be standing).
    const object = this.deps.instructions.candidate(objectId);
    const applied = acceptedStandingInstruction({
      id: newStandingInstructionId(),
      proposal,
      object,
      by: actor,
      at: this.deps.clock(),
      existing: this.deps.instructions.list(),
    });
    if (!applied.ok) throw refused(applied.refusal);

    // Written through the store with the id core produced, so the row and the
    // value core returned are the same record.
    const declared = this.deps.instructions.declare({
      objectId,
      by: actor,
      id: applied.value.id,
    });
    if (!declared.ok) throw refused(declared.refusal);
    this.publish(declared.value, "created", actor);
    return declared.value;
  }

  /** The ask the operator answers, raised once per proposal (principle 9). */
  private raise(proposal: ToolProposal): void {
    try {
      this.deps.approvals.raise({
        sessionId: proposal.proposedBy,
        ask: proposalAsk({
          proposalId: proposal.id,
          tool: proposal.tool,
          summary: describeStandingInstructionProposal(proposal),
        }),
        // Matched by call id, so a session that re-proposes the same thing finds the
        // ask already waiting rather than asking the operator twice.
        callId: `proposal:${proposal.id}`,
      });
    } catch (error) {
      this.deps.logger.error("could not raise a proposal approval", {
        proposalId: proposal.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Answer the queue row this proposal raised, when it is still open.
   *
   * Skipped when it is already answered, which is what stops the two entry points
   * from chasing each other: answering from the queue publishes the event this
   * class acts on, and acting on it must not try to answer again.
   */
  private async settleApproval(
    proposal: ToolProposal,
    decision: "accept" | "reject",
    reason: string | null,
  ): Promise<void> {
    const open = this.deps.approvals
      .pending()
      .find(
        (approval) =>
          approval.kind === "standing-instruction" &&
          approval.ask.target?.id === proposal.id,
      );
    if (open === undefined) return;

    try {
      await this.deps.approvals.answer({
        approvalId: open.id,
        decision: decision === "accept" ? "approve-once" : "deny",
        reason:
          decision === "accept"
            ? null
            : (reason ??
              "declined; this is feedback about how to proceed, not a failure (§6.6)"),
        actor: { kind: "human" },
      });
    } catch (error) {
      this.deps.logger.error("could not settle a proposal's approval", {
        proposalId: proposal.id,
        approvalId: open.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private publish(
    instruction: StandingInstruction,
    verb: "created" | "updated",
    author: Author,
  ): void {
    this.deps.bus.publish({
      entity: "standing_instruction",
      verb,
      instruction,
      objectId: instruction.objectId,
      author,
    });
  }
}
