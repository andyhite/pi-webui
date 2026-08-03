import { describe, expect, it } from "vitest";

import { humanAuthor, sessionAuthor } from "../../author.js";
import { session, ws } from "../../claims/testing.js";
import { answerApproval, raiseApproval } from "./approval.js";
import { claimAsk, destructionAsk, proposalAsk, toolCallAsk } from "./ask.js";
import { decideApproval } from "./decide.js";
import type { ApprovalId, PreGrantId } from "./ids.js";
import { ALL_APPROVAL_EXTENTS, type PreGrant } from "./pre-grants.js";

/**
 * The one approval decision (§6.6): the order every raise path shares.
 */

const A = session("sess_a");
const W = ws("ws-1");
const context = {
  actor: sessionAuthor(A),
  sessionId: A,
  workstreamId: W,
} as const;

function preGrant(overrides: Partial<PreGrant> = {}): PreGrant {
  return {
    id: "pregrant_001" as PreGrantId,
    scope: { kind: "session", sessionId: A },
    effect: "allow",
    kinds: ["tool-permission", "integration-write", "destruction", "claim"],
    toolPattern: "**",
    extents: [...ALL_APPROVAL_EXTENTS],
    grantedBy: humanAuthor,
    grantedAt: 1_000,
    withdrawnAt: null,
    ...overrides,
  };
}

const readAsk = toolCallAsk({
  toolName: "read_file",
  summary: "read_file",
  intent: { kind: "none" },
  world: null,
});

const boundedWriteAsk = toolCallAsk({
  toolName: "write_file",
  summary: "write_file",
  intent: { kind: "paths", paths: ["src/a.ts"] },
  world: null,
});

const shellAsk = toolCallAsk({
  toolName: "bash",
  summary: "bash (a shell)",
  intent: { kind: "unbounded", reason: "a shell" },
  world: null,
});

const mergeAsk = toolCallAsk({
  toolName: "github_merge_pr",
  summary: "github_merge_pr",
  intent: { kind: "none" },
  world: {
    kind: "outside-world",
    system: "github",
    action: "merge",
    reversibility: "irreversible",
  },
});

const commentAsk = toolCallAsk({
  toolName: "github_comment",
  summary: "github_comment",
  intent: { kind: "none" },
  world: {
    kind: "outside-world",
    system: "github",
    action: "comment",
    reversibility: "reversible",
  },
});

describe("decideApproval (§6.6)", () => {
  it("never gates the human every chain terminates at", () => {
    const verdict = decideApproval(mergeAsk, {
      ...context,
      actor: humanAuthor,
    });
    expect(verdict.kind).toBe("allowed");
    if (verdict.kind === "allowed") expect(verdict.by.kind).toBe("human");
  });

  it("allows what nothing would have raised, with no pre-grant needed", () => {
    for (const ask of [readAsk, boundedWriteAsk]) {
      const verdict = decideApproval(ask, context);
      expect(verdict.kind).toBe("allowed");
      if (verdict.kind === "allowed") expect(verdict.by.kind).toBe("not-gated");
    }
  });

  it("asks for an undeclared write extent, and takes a covering pre-grant for it", () => {
    expect(decideApproval(shellAsk, context).kind).toBe("must-ask");

    const covered = decideApproval(shellAsk, {
      ...context,
      preGrants: [preGrant({ toolPattern: "bash" })],
    });
    expect(covered.kind).toBe("allowed");
    if (covered.kind === "allowed") {
      expect(covered.by.kind).toBe("pre-grant");
      expect(covered.reason).toContain("pre-granted in advance");
    }
  });

  it("asks an irreversible write regardless of what was pre-granted, and names the pierced rule", () => {
    const verdict = decideApproval(mergeAsk, {
      ...context,
      preGrants: [preGrant({ id: "pregrant_gh" as PreGrantId })],
    });
    expect(verdict.kind).toBe("must-ask");
    if (verdict.kind === "must-ask") {
      expect(verdict.pierced?.preGrantId).toBe("pregrant_gh");
      expect(verdict.reason).toContain("cannot be undone");
    }
  });

  it("asks for a declared reversible external write, and takes a pre-grant for it (§9.2)", () => {
    // §6.6 lists "a write to an external system" among what a session raises an
    // approval for, and §9.2's write actions are "subject to approvals". Allowed
    // ungated, an `integration-write` pre-grant would authorize nothing at all.
    expect(commentAsk.trigger).toBe("external-write");
    const unstated = decideApproval(commentAsk, context);
    expect(unstated.kind).toBe("must-ask");
    if (unstated.kind === "must-ask") {
      // Reversible: a pre-grant could have covered it, so nothing was pierced.
      expect(unstated.pierced).toBeNull();
    }

    const verdict = decideApproval(commentAsk, {
      ...context,
      preGrants: [preGrant({ kinds: ["integration-write"] })],
    });
    expect(verdict.kind).toBe("allowed");
  });

  it("says something true about the calls it does not gate", () => {
    const read = decideApproval(readAsk, context);
    const bounded = decideApproval(boundedWriteAsk, context);
    if (read.kind !== "allowed" || bounded.kind !== "allowed") {
      expect.fail("neither a read nor a claimed write raises an approval");
      return;
    }
    // "Claims answer the write itself" is true of a path-bounded write, and was false
    // of the external write that used to reach this same branch.
    expect(bounded.reason).toContain("claims answer the write itself");
    expect(read.reason).toContain("writes nothing in the workspace");
    expect(read.reason).not.toContain("claims answer the write itself");
  });

  it("lets a deny bite a call that would never have asked", () => {
    const verdict = decideApproval(readAsk, {
      ...context,
      preGrants: [preGrant({ effect: "deny", toolPattern: "read_file" })],
    });
    expect(verdict.kind).toBe("denied");
    if (verdict.kind === "denied") {
      expect(verdict.by.kind).toBe("pre-grant");
      expect(verdict.reason).toContain("standing decision");
    }
  });

  it("settles from an answered approval, in both directions", () => {
    const raised = raiseApproval({
      id: "appr_1" as ApprovalId,
      sessionId: A,
      workstreamId: W,
      ask: mergeAsk,
      at: 10,
    });

    const approved = answerApproval(raised, {
      decision: "approve-once",
      by: humanAuthor,
      at: 11,
    });
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      const verdict = decideApproval(mergeAsk, {
        ...context,
        approval: approved.value,
      });
      expect(verdict.kind).toBe("allowed");
      if (verdict.kind === "allowed") expect(verdict.by.kind).toBe("approval");
    }

    const denied = answerApproval(raised, {
      decision: "deny",
      reason: "not that repository; open a PR against the fork",
      by: humanAuthor,
      at: 11,
    });
    expect(denied.ok).toBe(true);
    if (denied.ok) {
      const verdict = decideApproval(mergeAsk, {
        ...context,
        approval: denied.value,
      });
      expect(verdict.kind).toBe("denied");
      if (verdict.kind === "denied") {
        expect(verdict.reason).toContain("open a PR against the fork");
      }
    }
  });

  it("is not settled by an answer to a different gesture (principle 9)", () => {
    // A caller that looks approvals up by session finds the session's, not this
    // gesture's. An approved delete of one object must not delete another.
    const approvedForOne = answerApproval(
      raiseApproval({
        id: "appr_3" as ApprovalId,
        sessionId: A,
        workstreamId: W,
        ask: destructionAsk({
          toolName: "object_delete",
          target: { kind: "object", id: "obj_1" },
        }),
        at: 10,
      }),
      { decision: "approve-once", by: humanAuthor, at: 11 },
    );
    expect(approvedForOne.ok).toBe(true);
    if (!approvedForOne.ok) return;

    const otherTarget = destructionAsk({
      toolName: "object_delete",
      target: { kind: "object", id: "obj_2" },
    });
    expect(
      decideApproval(otherTarget, {
        ...context,
        approval: approvedForOne.value,
      }).kind,
    ).toBe("must-ask");

    expect(
      decideApproval(mergeAsk, { ...context, approval: approvedForOne.value })
        .kind,
    ).toBe("must-ask");

    // The gesture it *was* raised for is still settled by it.
    const sameTarget = destructionAsk({
      toolName: "object_delete",
      target: { kind: "object", id: "obj_1" },
    });
    expect(
      decideApproval(sameTarget, { ...context, approval: approvedForOne.value })
        .kind,
    ).toBe("allowed");
  });

  it("treats a raised-but-unanswered approval as still asking, never as permission", () => {
    const raised = raiseApproval({
      id: "appr_2" as ApprovalId,
      sessionId: A,
      workstreamId: W,
      ask: shellAsk,
      at: 10,
    });
    const verdict = decideApproval(shellAsk, { ...context, approval: raised });
    expect(verdict.kind).toBe("must-ask");
  });

  it("asks for a claim outside every standing policy (§3.4's approval wait, in this vocabulary)", () => {
    const ask = claimAsk({
      path: "migrations",
      summary: "claim migrations for sess_a",
    });
    expect(decideApproval(ask, context).kind).toBe("must-ask");
  });

  it("asks for a proposal in its own words, and no pre-grant can answer for one (§3.8)", () => {
    const ask = proposalAsk({
      proposalId: "proposal_1",
      tool: "standing_instruction_declare",
      summary: "sess_a proposes that obj_1 apply everywhere",
    });

    // Even a grant that names every kind and every tool: coverage for a proposal
    // has no expression at all, so this asks (principle 1).
    const verdict = decideApproval(ask, {
      ...context,
      preGrants: [
        preGrant({
          kinds: [
            "tool-permission",
            "integration-write",
            "destruction",
            "claim",
          ],
        }),
      ],
    });
    expect(verdict.kind).toBe("must-ask");
    if (verdict.kind === "must-ask") {
      expect(verdict.pierced).toBeNull();
      expect(verdict.reason).toContain("never applied silently");
      // Not the irreversible-write sentence: nothing here is about undoing.
      expect(verdict.reason).not.toContain("cannot be undone");
    }
  });

  it("is not settled by an approval of another kind over the same tool name (§3.8)", () => {
    // A proposal's tool name is a real tool name, so tool-and-target matching alone
    // would let a write-gate raise over `standing_instruction_declare` settle the
    // proposal — applying it without anybody confirming it.
    const proposal = proposalAsk({
      proposalId: "proposal_1",
      tool: "standing_instruction_declare",
      summary: "sess_a proposes that obj_1 apply everywhere",
    });
    const permission = toolCallAsk({
      toolName: "standing_instruction_declare",
      summary: "standing_instruction_declare",
      intent: { kind: "unbounded", reason: "undeclared" },
      world: null,
    });
    const approvedPermission = answerApproval(
      raiseApproval({
        id: "appr_4" as ApprovalId,
        sessionId: A,
        workstreamId: W,
        ask: permission,
        at: 10,
      }),
      { decision: "approve-once", by: humanAuthor, at: 11 },
    );
    expect(approvedPermission.ok).toBe(true);
    if (!approvedPermission.ok) return;

    expect(
      decideApproval(proposal, {
        ...context,
        approval: approvedPermission.value,
      }).kind,
    ).toBe("must-ask");
  });
});
