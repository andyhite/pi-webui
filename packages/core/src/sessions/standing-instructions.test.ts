import { describe, expect, it } from "vitest";

import { humanAuthor, sessionAuthor } from "../author.js";
import { newProposalId } from "../claims/ids.js";
import { newObjectId, newSessionId, newWorkstreamId } from "../ids.js";
import type { LineageIndex } from "../lineage.js";
import {
  acceptedStandingInstruction,
  checkStandingInstruction,
  describeStandingInstructionProposal,
  isStandingInstructionAvailableTo,
  markStandingInstruction,
  newStandingInstructionId,
  optIn,
  optOut,
  proposeStandingInstruction,
  resolveStandingInstructions,
  retireStandingInstruction,
  STANDING_INSTRUCTION_DECLARE_TOOL,
  STANDING_INSTRUCTION_RETIRE_TOOL,
  type StandingInstruction,
  type StandingInstructionCandidate,
} from "./standing-instructions.js";
import { toolByName } from "./tools/catalog.js";
import { checkToolCall, decideProposal } from "./tools/reflexivity.js";

/**
 * Standing instructions (§3.8, principle 1, Epic 7.4).
 *
 * Two rules are what these tests are for: **opt-in is a gesture, never a default**
 * (principle 6), and **a session never makes an instruction standing** — it proposes,
 * and a human accepts.
 */

/** No chains at all: every session here is its own root. */
const lineage: LineageIndex = { parentOf: () => null };

const note = (): StandingInstructionCandidate => ({
  objectId: newObjectId(),
  kind: "note",
  scope: "world",
});

const mark = (
  object: StandingInstructionCandidate,
  at = 1_000,
  existing: readonly StandingInstruction[] = [],
): StandingInstruction => {
  const marked = markStandingInstruction({
    id: newStandingInstructionId(),
    object,
    by: humanAuthor,
    at,
    existing,
  });
  if (!marked.ok) {
    throw new Error(marked.refusal.message);
  }
  return marked.value;
};

describe("what may be standing (§3.2, §3.8)", () => {
  it("marks world-scoped note and document content", () => {
    expect(checkStandingInstruction(note()).ok).toBe(true);
    expect(
      checkStandingInstruction({
        objectId: newObjectId(),
        kind: "document",
        scope: "world",
      }).ok,
    ).toBe(true);
  });

  it("refuses a local object, pointing at the one gesture that fixes it (§3.2)", () => {
    const refused = checkStandingInstruction({
      objectId: newObjectId(),
      kind: "note",
      scope: "local",
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.refusal.reason).toBe("not_world_scope");
    expect(refused.refusal.message).toContain("promote");
  });

  it("refuses a kind whose content somebody else changes", () => {
    for (const kind of ["ticket", "transcript", "diff"] as const) {
      const refused = checkStandingInstruction({
        objectId: newObjectId(),
        kind,
        scope: "world",
      });
      if (refused.ok) throw new Error(`${kind} should not be standing`);
      expect(refused.refusal.reason).toBe("kind_cannot_be_standing");
    }
  });

  it("refuses a second marking of one object (principle 9)", () => {
    const object = note();
    const first = mark(object);
    const again = markStandingInstruction({
      id: newStandingInstructionId(),
      object,
      by: humanAuthor,
      at: 2_000,
      existing: [first],
    });
    if (again.ok) throw new Error("expected a refusal");
    expect(again.refusal.reason).toBe("already_standing");
  });

  it("retires rather than deletes, and the content object is untouched", () => {
    const instruction = mark(note());
    const retired = retireStandingInstruction(instruction, humanAuthor, 5_000);
    if (!retired.ok) throw new Error(retired.refusal.message);
    expect(retired.value.retiredAt).toBe(5_000);
    expect(retired.value.objectId).toBe(instruction.objectId);
    // Retiring twice keeps the first time: "retired yesterday" is one fact.
    const twice = retireStandingInstruction(retired.value, humanAuthor, 9_000);
    expect(twice.ok && twice.value.retiredAt).toBe(5_000);
  });
});

describe("a session proposes; a human accepts (principle 1, §3.8)", () => {
  it("refuses a session marking content standing, and names the proposal path", () => {
    const refused = markStandingInstruction({
      id: newStandingInstructionId(),
      object: note(),
      by: sessionAuthor(newSessionId()),
      at: 1,
    });
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.refusal.reason).toBe("human_only");
    expect(refused.refusal.message).toContain("proposal_create");
  });

  it("refuses a session retiring one for the same reason", () => {
    const refused = retireStandingInstruction(
      mark(note()),
      sessionAuthor(newSessionId()),
      2,
    );
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.refusal.reason).toBe("human_only");
  });

  it("names tools the catalog really has, so the two spellings cannot drift", () => {
    expect(toolByName(STANDING_INSTRUCTION_DECLARE_TOOL)).toBeDefined();
    expect(toolByName(STANDING_INSTRUCTION_RETIRE_TOOL)).toBeDefined();
  });

  it("refuses the tool call itself, which is where a session meets the rule", () => {
    const sessionId = newSessionId();
    for (const name of [
      STANDING_INSTRUCTION_DECLARE_TOOL,
      STANDING_INSTRUCTION_RETIRE_TOOL,
    ]) {
      const tool = toolByName(name);
      expect(tool?.requires.reflexivity, name).toBe("self-proposal");
      const check = checkToolCall(
        { actor: sessionAuthor(sessionId), lineage },
        { tool: name, input: {} },
      );
      expect(check.allowed, name).toBe(false);
      if (check.allowed) throw new Error("expected a refusal");
      expect(check.refusal.reason).toBe("proposal_required");
      expect(check.refusal.details?.["proposeWith"]).toBe("proposal_create");
    }
  });

  it("lets a human make the same call", () => {
    const check = checkToolCall(
      { actor: humanAuthor, lineage },
      { tool: "standing_instruction_declare", input: {} },
    );
    expect(check.allowed).toBe(true);
  });

  it("produces one ordinary proposal, with the sentence a queue row shows", () => {
    const object = note();
    const sessionId = newSessionId();
    const built = proposeStandingInstruction({
      id: newProposalId(),
      proposedBy: sessionId,
      objectId: object.objectId,
      rationale: "every session keeps rediscovering that this repo uses pnpm",
      at: 10,
    });
    if (!built.ok) throw new Error(built.refusal.message);
    const proposal = built.value;
    expect(proposal.tool).toBe(STANDING_INSTRUCTION_DECLARE_TOOL);
    expect(proposal.state).toBe("pending");
    // No target: the answer would be "every session, the caller's own included",
    // which is why this is a proposal rather than a narrower check.
    expect(proposal.target).toBeNull();
    const sentence = describeStandingInstructionProposal(proposal);
    expect(sentence).toContain(object.objectId);
    expect(sentence).toContain("apply everywhere");
    expect(sentence).toContain("rediscovering");
  });

  it("refuses a second proposal for an object that already has a pending one", () => {
    const object = note();
    const first = proposeStandingInstruction({
      id: newProposalId(),
      proposedBy: newSessionId(),
      objectId: object.objectId,
      at: 10,
    });
    if (!first.ok) throw new Error(first.refusal.message);
    const second = proposeStandingInstruction({
      id: newProposalId(),
      proposedBy: newSessionId(),
      objectId: object.objectId,
      at: 11,
      pendingProposals: [first.value],
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected a refusal");
    expect(second.refusal.reason).toBe("already_proposed");
  });

  it("refuses a proposal for an object that is already standing", () => {
    const object = note();
    const standing: StandingInstruction = {
      id: newStandingInstructionId(),
      objectId: object.objectId,
      declaredBy: humanAuthor,
      declaredAt: 5,
      retiredAt: null,
    };
    const result = proposeStandingInstruction({
      id: newProposalId(),
      proposedBy: newSessionId(),
      objectId: object.objectId,
      at: 10,
      existingStanding: [standing],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.refusal.reason).toBe("already_standing");
  });

  it("will not apply a pending or rejected proposal (never applied silently)", () => {
    const object = note();
    const built = proposeStandingInstruction({
      id: newProposalId(),
      proposedBy: newSessionId(),
      objectId: object.objectId,
      at: 10,
    });
    if (!built.ok) throw new Error(built.refusal.message);
    const proposal = built.value;
    const pending = acceptedStandingInstruction({
      id: newStandingInstructionId(),
      proposal,
      object,
      by: humanAuthor,
      at: 20,
    });
    if (pending.ok) throw new Error("expected a refusal");
    expect(pending.refusal.reason).toBe("not_accepted");

    const rejected = decideProposal(proposal, "reject", humanAuthor, 15);
    if (!rejected.ok) throw new Error(rejected.refusal.message);
    const applied = acceptedStandingInstruction({
      id: newStandingInstructionId(),
      proposal: rejected.proposal,
      object,
      by: humanAuthor,
      at: 20,
    });
    expect(applied.ok).toBe(false);
  });

  it("refuses a session accepting its own proposal (principle 1)", () => {
    const sessionId = newSessionId();
    const built = proposeStandingInstruction({
      id: newProposalId(),
      proposedBy: sessionId,
      objectId: newObjectId(),
      at: 10,
    });
    if (!built.ok) throw new Error(built.refusal.message);
    const proposal = built.value;
    const decided = decideProposal(
      proposal,
      "accept",
      sessionAuthor(sessionId),
      15,
    );
    expect(decided.ok).toBe(false);
    if (decided.ok) throw new Error("expected a refusal");
    expect(decided.refusal.reason).toBe("human_only");
  });

  it("records the accepting human as the author, never the proposing session", () => {
    const object = note();
    const built = proposeStandingInstruction({
      id: newProposalId(),
      proposedBy: newSessionId(),
      objectId: object.objectId,
      at: 10,
    });
    if (!built.ok) throw new Error(built.refusal.message);
    const proposal = built.value;
    const accepted = decideProposal(proposal, "accept", humanAuthor, 15);
    if (!accepted.ok) throw new Error(accepted.refusal.message);
    const applied = acceptedStandingInstruction({
      id: newStandingInstructionId(),
      proposal: accepted.proposal,
      object,
      by: humanAuthor,
      at: 20,
    });
    if (!applied.ok) throw new Error(applied.refusal.message);
    // The graph records who decided what agents know (§15-2): the human did.
    expect(applied.value.declaredBy).toEqual(humanAuthor);
    expect(applied.value.declaredAt).toBe(20);
  });

  it("refuses an accepted proposal applied to some other object, or another tool", () => {
    const object = note();
    const built = proposeStandingInstruction({
      id: newProposalId(),
      proposedBy: newSessionId(),
      objectId: object.objectId,
      at: 10,
    });
    if (!built.ok) throw new Error(built.refusal.message);
    const proposal = built.value;
    const accepted = decideProposal(proposal, "accept", humanAuthor, 15);
    if (!accepted.ok) throw new Error(accepted.refusal.message);

    const elsewhere = acceptedStandingInstruction({
      id: newStandingInstructionId(),
      proposal: accepted.proposal,
      object: note(),
      by: humanAuthor,
      at: 20,
    });
    if (elsewhere.ok) throw new Error("expected a refusal");
    expect(elsewhere.refusal.reason).toBe("no_object");

    const otherTool = acceptedStandingInstruction({
      id: newStandingInstructionId(),
      proposal: { ...accepted.proposal, tool: "command_parameter_confirm" },
      object,
      by: humanAuthor,
      at: 20,
    });
    if (otherTool.ok) throw new Error("expected a refusal");
    expect(otherTool.refusal.reason).toBe("wrong_tool");
  });

  it("refuses an accepted proposal about content that cannot be standing", () => {
    const local: StandingInstructionCandidate = {
      objectId: newObjectId(),
      kind: "note",
      scope: "local",
    };
    const built = proposeStandingInstruction({
      id: newProposalId(),
      proposedBy: newSessionId(),
      objectId: local.objectId,
      at: 10,
    });
    if (!built.ok) throw new Error(built.refusal.message);
    const proposal = built.value;
    const accepted = decideProposal(proposal, "accept", humanAuthor, 15);
    if (!accepted.ok) throw new Error(accepted.refusal.message);
    const applied = acceptedStandingInstruction({
      id: newStandingInstructionId(),
      proposal: accepted.proposal,
      object: local,
      by: humanAuthor,
      at: 20,
    });
    if (applied.ok) throw new Error("expected a refusal");
    // The proposal's acceptance does not widen the rule about what may be standing.
    expect(applied.refusal.reason).toBe("not_world_scope");
  });
});

describe("availability is opt-in, per workstream (§3.8, principle 6)", () => {
  it("reaches nothing until a workstream opts in", () => {
    const instruction = mark(note());
    const workstreamId = newWorkstreamId();
    expect(
      resolveStandingInstructions({
        workstreamId,
        instructions: [instruction],
        optIns: [],
      }),
    ).toEqual([]);
    expect(
      isStandingInstructionAvailableTo(instruction, [], workstreamId),
    ).toBe(false);
  });

  it("reaches the workstream that opted in, and no other", () => {
    const instruction = mark(note());
    const mine = newWorkstreamId();
    const theirs = newWorkstreamId();
    const optIns = [
      optIn({
        workstreamId: mine,
        instructionId: instruction.id,
        by: humanAuthor,
        at: 2_000,
      }),
    ];
    expect(
      resolveStandingInstructions({
        workstreamId: mine,
        instructions: [instruction],
        optIns,
      }),
    ).toEqual([instruction]);
    expect(
      resolveStandingInstructions({
        workstreamId: theirs,
        instructions: [instruction],
        optIns,
      }),
    ).toEqual([]);
  });

  it("records who opted in, because it decides what a workstream's sessions know", () => {
    const sessionId = newSessionId();
    const entry = optIn({
      workstreamId: newWorkstreamId(),
      instructionId: newStandingInstructionId(),
      by: sessionAuthor(sessionId),
      at: 3_000,
    });
    expect(entry.by).toEqual(sessionAuthor(sessionId));
  });

  it("stops reaching a workstream that opted out, and remembers that it did", () => {
    const instruction = mark(note());
    const workstreamId = newWorkstreamId();
    const entry = optIn({
      workstreamId,
      instructionId: instruction.id,
      by: humanAuthor,
      at: 2_000,
    });
    const out = optOut(entry, 4_000);
    expect(out.optedOutAt).toBe(4_000);
    expect(out.at).toBe(2_000);
    expect(
      resolveStandingInstructions({
        workstreamId,
        instructions: [instruction],
        optIns: [out],
      }),
    ).toEqual([]);
    // Opting out twice keeps the first time.
    expect(optOut(out, 9_000).optedOutAt).toBe(4_000);
  });

  it("drops a retired instruction from every workstream that opted in", () => {
    const instruction = mark(note());
    const workstreamId = newWorkstreamId();
    const optIns = [
      optIn({
        workstreamId,
        instructionId: instruction.id,
        by: humanAuthor,
        at: 2_000,
      }),
    ];
    const retired = retireStandingInstruction(instruction, humanAuthor, 5_000);
    if (!retired.ok) throw new Error(retired.refusal.message);
    expect(
      resolveStandingInstructions({
        workstreamId,
        instructions: [retired.value],
        optIns,
      }),
    ).toEqual([]);
    expect(
      isStandingInstructionAvailableTo(retired.value, optIns, workstreamId),
    ).toBe(false);
  });

  it("resolves in a stable order, so two runs assemble identically (§15-1)", () => {
    const first = mark(note(), 1_000);
    const second = mark(note(), 2_000);
    const third = mark(note(), 2_000);
    const workstreamId = newWorkstreamId();
    const optIns = [first, second, third].map((instruction) =>
      optIn({
        workstreamId,
        instructionId: instruction.id,
        by: humanAuthor,
        at: 3_000,
      }),
    );
    const order = (instructions: readonly StandingInstruction[]): string[] =>
      resolveStandingInstructions({
        workstreamId,
        instructions,
        optIns,
      }).map((instruction) => instruction.id);

    // Oldest first, then by id: independent of the order the rows arrived in.
    const forwards = order([first, second, third]);
    expect(forwards[0]).toBe(first.id);
    expect(order([third, second, first])).toEqual(forwards);
    // And it does not mutate what it was given.
    const given = [third, second, first];
    order(given);
    expect(given).toEqual([third, second, first]);
  });
});
