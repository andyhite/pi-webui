import { describe, expect, it } from "vitest";

import { humanAuthor, sessionAuthor } from "../../author.js";
import { session, ws } from "../../claims/testing.js";
import { answerApproval, raiseApproval } from "./approval.js";
import { claimAsk, toolCallAsk } from "./ask.js";
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

  it("takes a pre-grant for a reversible integration write", () => {
    const verdict = decideApproval(commentAsk, {
      ...context,
      preGrants: [preGrant({ kinds: ["integration-write"] })],
    });
    expect(verdict.kind).toBe("allowed");
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
});
