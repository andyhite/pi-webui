import type { Author } from "../author.js";
import type { ObjectKind, ObjectScope } from "../objects.js";
import type { ObjectId, SessionId, WorkstreamId } from "../ids.js";
import type { ProposalId } from "../claims/ids.js";
import {
  proposeToolCall,
  type ToolCall,
  type ToolProposal,
} from "./tools/reflexivity.js";

/**
 * Standing instructions (§3.8, principle 1, Epic 7.4).
 *
 * "**Standing instructions** are content marked as applying everywhere — 'this
 * repository uses pnpm, never npm', 'never touch the generated directory' — available
 * as context to every workstream that wants it, so parallel sessions stop rediscovering
 * the same facts at a paid turn each. **Agents can propose additions; a human accepts
 * them** (principle 1)."
 *
 * Four decisions are stated here, because each of them is the kind of thing that would
 * otherwise be decided differently by the store, the assembler, and the tool:
 *
 * 1. **A standing instruction is a marker on a world object, not a new concept.**
 *    §3.1's kinds are closed and §3.2 already lists a standing instruction among the
 *    objects that live at world scope, so this is a record naming an object — never a
 *    tenth `ObjectKind`, and never a copy of its content.
 * 2. **Opting in is per workstream, and opt-in only.** "Available as context to every
 *    workstream that *wants* it" is a gesture, not a default: nothing appears that
 *    nobody put there (principle 6). The opt-in carries its **author**, because it is a
 *    decision about what a workstream's sessions know (principle 1).
 * 3. **Availability is resolved at assembly, not fanned out into edges.** One opt-in
 *    covers the workstream's commands as they are today *and* as they will be; a fan-out
 *    of context edges would go stale the moment a command was added, and would have to
 *    be re-authored per command to stay true. Nothing is lost from the record either
 *    way: run history stores the full assembled content it ran on (§15-1), so what a run
 *    actually saw is recorded whether or not an edge existed.
 * 4. **A session never makes an instruction standing.** The target of that authoring
 *    includes the author — it applies everywhere, so it applies to the caller's own
 *    chain — which is principle 1's own worked example: "the agent **proposes** and a
 *    human **accepts**; a proposal is confirmed, never applied silently". The catalog
 *    declares those tools `self-proposal`, `checkToolCall` refuses them for a session
 *    and names `proposal_create`, and {@link acceptedStandingInstruction} is the only
 *    way a proposal becomes an instruction — authored by the human who accepted it.
 */

declare const standingInstructionBrand: unique symbol;

type Brand<T, B extends string> = T & {
  readonly [standingInstructionBrand]: B;
};

/**
 * One piece of content marked as applying everywhere (§3.8).
 *
 * Branded here rather than in `src/ids.ts` for the same reason the claim and approval
 * brands are local to their subtrees, and with the same technique: a nominal brand plus
 * a short greppable prefix over a v4 UUID.
 */
export type StandingInstructionId = Brand<string, "StandingInstructionId">;

declare const crypto: { randomUUID(): string };

export const newStandingInstructionId = (): StandingInstructionId =>
  `standing_${crypto.randomUUID()}` as StandingInstructionId;

/**
 * The marker record.
 *
 * It holds no content of its own: the content is the object's, and an edit to that
 * object is a new version that drifts its consumers like any other change (§3.2). A
 * record that copied the text would be a second version history nobody would keep in
 * step.
 */
export interface StandingInstruction {
  readonly id: StandingInstructionId;
  /** The world object whose content applies everywhere. */
  readonly objectId: ObjectId;
  /** Who marked it standing — always a human, by {@link markStandingInstruction}. */
  readonly declaredBy: Author;
  readonly declaredAt: number;
  /**
   * Retired rather than deleted, like a claim row and a pre-grant: "retired yesterday"
   * and "never standing" are different facts, and the object itself survives either way
   * (principle 10 — nothing authored is destroyed by this verb).
   */
  readonly retiredAt: number | null;
}

/** Which object kinds may be marked standing, and the reason the list is short. */
export const STANDING_INSTRUCTION_KINDS: readonly ObjectKind[] = [
  /** §3.8's own example: human-authored content created directly in the app. */
  "note",
  /** "A durable piece of prose: a spec, a plan, a design note." */
  "document",
];

export const STANDING_INSTRUCTION_REFUSAL_REASONS = [
  /**
   * §3.2 lists a standing instruction among the **world** objects, and it has to be:
   * a local object belongs to the workstream that produced it, so one marked as
   * applying everywhere would be readable by workstreams it does not belong to.
   * Promotion is one gesture (§3.2) and is the answer here.
   */
  "not_world_scope",
  /**
   * A kind whose content is somebody else's to change. A ticket or a transcript marked
   * "applies everywhere" would let an external re-sync silently rewrite the rules every
   * workstream runs under — the instruction would change with nobody deciding it,
   * which is what makes this a refusal rather than a preference.
   */
  "kind_cannot_be_standing",
  /** Principle 1: a session marking content standing authors into its own chain. */
  "human_only",
  /** One gesture, one thing (principle 9): this object is already standing. */
  "already_standing",
] as const;

export type StandingInstructionRefusalReason =
  (typeof STANDING_INSTRUCTION_REFUSAL_REASONS)[number];

export interface StandingInstructionRefusal {
  readonly reason: StandingInstructionRefusalReason;
  readonly message: string;
}

export type StandingInstructionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: StandingInstructionRefusal };

/** What the caller knows about the object being marked, and nothing more. */
export interface StandingInstructionCandidate {
  readonly objectId: ObjectId;
  readonly kind: ObjectKind;
  readonly scope: ObjectScope;
}

export interface MarkStandingInstructionInput {
  readonly id: StandingInstructionId;
  readonly object: StandingInstructionCandidate;
  readonly by: Author;
  readonly at: number;
  /** Whatever is already standing, so a second marking of one object is refused. */
  readonly existing?: readonly StandingInstruction[];
}

/**
 * Mark content as applying everywhere, or say why not.
 *
 * Human-only, and refused rather than advised: the target of this authoring includes
 * the author, so a session's route to it is a proposal (principle 1). The refusal names
 * the proposal path so the session's next move is the right one rather than a retry.
 */
export function markStandingInstruction(
  input: MarkStandingInstructionInput,
): StandingInstructionResult<StandingInstruction> {
  if (input.by.kind !== "human") {
    return refuse(
      "human_only",
      "a standing instruction applies everywhere, so it applies to the caller's own chain: a session proposes it (proposal_create) and a human accepts (principle 1, §3.8)",
    );
  }
  const check = checkStandingInstruction(input.object);
  if (!check.ok) {
    return check;
  }
  const already = (input.existing ?? []).find(
    (instruction) =>
      instruction.objectId === input.object.objectId &&
      instruction.retiredAt === null,
  );
  if (already !== undefined) {
    return refuse(
      "already_standing",
      `${input.object.objectId} is already a standing instruction (${already.id})`,
    );
  }
  return {
    ok: true,
    value: {
      id: input.id,
      objectId: input.object.objectId,
      declaredBy: input.by,
      declaredAt: input.at,
      retiredAt: null,
    },
  };
}

/**
 * Whether this object *could* be standing — scope and kind, and nothing about who is
 * asking.
 *
 * Separate from {@link markStandingInstruction} because the canvas needs to know
 * whether to offer the gesture at all, and a surface that answered that from its own
 * copy of the rule would be the second implementation principle 8 rules out.
 */
export function checkStandingInstruction(
  object: StandingInstructionCandidate,
): StandingInstructionResult<StandingInstructionCandidate> {
  if (object.scope !== "world") {
    return refuse(
      "not_world_scope",
      `${object.objectId} is a local object: a standing instruction lives at world scope (§3.2), so promote it first — that is one gesture`,
    );
  }
  if (!STANDING_INSTRUCTION_KINDS.includes(object.kind)) {
    return refuse(
      "kind_cannot_be_standing",
      `a ${object.kind} cannot be standing: its content is somebody else's to change, and an instruction that rewrote itself on a re-sync would change the rules every workstream runs under with nobody deciding it. ${STANDING_INSTRUCTION_KINDS.join(" or ")} content can`,
    );
  }
  return { ok: true, value: object };
}

/** Retire one. The content object survives; only the marker stops applying. */
export function retireStandingInstruction(
  instruction: StandingInstruction,
  by: Author,
  at: number,
): StandingInstructionResult<StandingInstruction> {
  if (by.kind !== "human") {
    return refuse(
      "human_only",
      "retiring a standing instruction changes what every opted-in workstream knows, the caller's own chain included: a session proposes it and a human accepts (principle 1)",
    );
  }
  return {
    ok: true,
    value:
      instruction.retiredAt === null
        ? { ...instruction, retiredAt: at }
        : instruction,
  };
}

/* ------------------------------------------------------------------- opting in */

/**
 * One workstream's opt-in (§3.8).
 *
 * Retired rather than deleted for the same reason the marker is: "opted out in March"
 * and "never opted in" are different facts, and only one of them is worth showing.
 */
export interface StandingInstructionOptIn {
  readonly workstreamId: WorkstreamId;
  readonly instructionId: StandingInstructionId;
  /** Recorded because this is a decision about what a workstream's sessions know. */
  readonly by: Author;
  readonly at: number;
  readonly optedOutAt: number | null;
}

export function optIn(input: {
  readonly workstreamId: WorkstreamId;
  readonly instructionId: StandingInstructionId;
  readonly by: Author;
  readonly at: number;
}): StandingInstructionOptIn {
  return { ...input, optedOutAt: null };
}

export function optOut(
  existing: StandingInstructionOptIn,
  at: number,
): StandingInstructionOptIn {
  return existing.optedOutAt === null
    ? { ...existing, optedOutAt: at }
    : existing;
}

const isLive = (optIn: StandingInstructionOptIn): boolean =>
  optIn.optedOutAt === null;

/**
 * Which standing instructions a workstream's assembly includes, in the order it
 * includes them.
 *
 * The order is part of the answer rather than the caller's business: run history
 * records the assembled content and its inputs *in order* (§15-1), so two runs of the
 * same command with the same opt-ins must assemble identically or the comparison
 * §3.7 promises would be reporting a change nobody made. Oldest first, then by id, so
 * the sequence is stable across restarts and independent of row order.
 *
 * Standing instructions come **before** the command's wired inputs, because they are
 * the frame the rest is read in — "this repository uses pnpm, never npm" is not one
 * input among the ticket and the diff.
 */
export function resolveStandingInstructions(input: {
  readonly workstreamId: WorkstreamId;
  readonly instructions: readonly StandingInstruction[];
  readonly optIns: readonly StandingInstructionOptIn[];
}): readonly StandingInstruction[] {
  const opted = new Set(
    input.optIns
      .filter(
        (entry) => entry.workstreamId === input.workstreamId && isLive(entry),
      )
      .map((entry) => entry.instructionId),
  );
  return input.instructions
    .filter(
      (instruction) =>
        instruction.retiredAt === null && opted.has(instruction.id),
    )
    .slice()
    .sort(
      (left, right) =>
        left.declaredAt - right.declaredAt || left.id.localeCompare(right.id),
    );
}

/** Whether one instruction reaches one workstream, for a surface drawing the toggle. */
export function isStandingInstructionAvailableTo(
  instruction: StandingInstruction,
  optIns: readonly StandingInstructionOptIn[],
  workstreamId: WorkstreamId,
): boolean {
  if (instruction.retiredAt !== null) return false;
  return optIns.some(
    (entry) =>
      entry.instructionId === instruction.id &&
      entry.workstreamId === workstreamId &&
      isLive(entry),
  );
}

/* ------------------------------------------------- propose, and a human accepts */

/**
 * The tools a standing-instruction proposal can be a proposal *for*.
 *
 * Named here as well as in the catalog because the acceptance path has to refuse a
 * proposal that claims to be one of these and is not: a proposal is applied as the
 * human's own act, so "which tool" is the whole of what is being agreed to.
 */
export const STANDING_INSTRUCTION_DECLARE_TOOL = "standing_instruction_declare";
export const STANDING_INSTRUCTION_RETIRE_TOOL = "standing_instruction_retire";

/** What a session proposes: the object it wants to be standing, and why. */
export interface StandingInstructionProposalInput {
  readonly id: ProposalId;
  readonly proposedBy: SessionId;
  readonly objectId: ObjectId;
  readonly rationale?: string;
  readonly at: number;
}

/**
 * Build the proposal, rather than performing the act (§3.8, principle 1).
 *
 * This is deliberately the same {@link ToolProposal} every other self-proposal produces:
 * one record, one acceptance verb (`decideProposal`), one queue row. A standing
 * instruction with a proposal type of its own would be a second acceptance path, and the
 * second one is always the one that forgets to check who is accepting.
 */
export function proposeStandingInstruction(
  input: StandingInstructionProposalInput,
): ToolProposal {
  // No `target`: a `ToolTarget` exists so the lineage check can resolve which sessions
  // a call would author into, and a standing instruction's answer is "all of them,
  // including the caller's own" — which is why this is a proposal rather than a call
  // with a narrower check. Naming one here would invite a resolution that made the
  // rule look satisfiable.
  const call: ToolCall = {
    tool: STANDING_INSTRUCTION_DECLARE_TOOL,
    input: { objectId: input.objectId },
  };
  return proposeToolCall({
    id: input.id,
    proposedBy: input.proposedBy,
    call,
    ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
    at: input.at,
  });
}

/** The sentence every surface uses for a pending proposal (§7.1). */
export function describeStandingInstructionProposal(
  proposal: ToolProposal,
): string {
  const objectId = proposal.input["objectId"];
  const what =
    proposal.tool === STANDING_INSTRUCTION_RETIRE_TOOL
      ? "stop applying everywhere"
      : "apply everywhere, to every workstream that opts in";
  return [
    `${proposal.proposedBy} proposes that ${String(objectId)} ${what} (§3.8)`,
    proposal.rationale === null ? null : `because: ${proposal.rationale}`,
    "accepting applies it as your own act; declining is feedback the session acts on",
  ]
    .filter((part): part is string => part !== null)
    .join(" — ");
}

export const PROPOSAL_APPLICATION_REFUSAL_REASONS = [
  /** Not accepted (or not yet): applying a pending proposal is applying it silently. */
  "not_accepted",
  /** A proposal for some other tool cannot be applied through this path. */
  "wrong_tool",
  /** The proposal names no object, so there is nothing to mark. */
  "no_object",
] as const;

export type ProposalApplicationRefusalReason =
  (typeof PROPOSAL_APPLICATION_REFUSAL_REASONS)[number];

export interface ProposalApplicationRefusal {
  readonly reason: ProposalApplicationRefusalReason;
  readonly message: string;
}

/**
 * A refusal from either half of the path: the proposal's own state, or the rule about
 * what may be standing at all. Both shapes are `{ reason, message }`, and the union is
 * deliberate rather than flattened — mapping one vocabulary onto the other would have
 * made "already standing" arrive as some other reason entirely.
 */
export type ProposalApplication =
  | { readonly ok: true; readonly value: StandingInstruction }
  | {
      readonly ok: false;
      readonly refusal: ProposalApplicationRefusal | StandingInstructionRefusal;
    };

/**
 * Apply an **accepted** proposal, as the accepting human's own act.
 *
 * This is the only path from a session's proposal to a standing instruction, and the
 * author it records is the human's — never the proposing session's. That is not
 * bookkeeping: the graph records who decided what agents know (principle 1, §15-2), and
 * a marker attributed to the session that asked for it would say a session made itself
 * standing.
 *
 * `by` is the acceptance's author, which `decideProposal` has already refused for a
 * session; the refusal is repeated here rather than assumed, because this function is
 * reachable from a store that never called it.
 */
export function acceptedStandingInstruction(input: {
  readonly id: StandingInstructionId;
  readonly proposal: ToolProposal;
  readonly object: StandingInstructionCandidate;
  readonly by: Author;
  readonly at: number;
  readonly existing?: readonly StandingInstruction[];
}): ProposalApplication {
  if (input.proposal.tool !== STANDING_INSTRUCTION_DECLARE_TOOL) {
    return {
      ok: false,
      refusal: {
        reason: "wrong_tool",
        message: `this path applies a ${STANDING_INSTRUCTION_DECLARE_TOOL} proposal, not a ${input.proposal.tool} one`,
      },
    };
  }
  if (input.proposal.state !== "accepted") {
    return {
      ok: false,
      refusal: {
        reason: "not_accepted",
        message: `this proposal is ${input.proposal.state}; a proposal is confirmed before it is applied, never silently (principle 1)`,
      },
    };
  }
  if (input.proposal.input["objectId"] !== input.object.objectId) {
    return {
      ok: false,
      refusal: {
        reason: "no_object",
        message: `this proposal is about ${String(input.proposal.input["objectId"])}, not ${input.object.objectId}`,
      },
    };
  }
  const marked = markStandingInstruction({
    id: input.id,
    object: input.object,
    by: input.by,
    at: input.at,
    ...(input.existing === undefined ? {} : { existing: input.existing }),
  });
  return marked.ok
    ? { ok: true, value: marked.value }
    : { ok: false, refusal: marked.refusal };
}

function refuse<T>(
  reason: StandingInstructionRefusalReason,
  message: string,
): StandingInstructionResult<T> {
  return { ok: false, refusal: { reason, message } };
}
