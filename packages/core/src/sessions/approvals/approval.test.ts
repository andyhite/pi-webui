import { describe, expect, it } from "vitest";

import { humanAuthor, sessionAuthor } from "../../author.js";
import { session, ws } from "../../claims/testing.js";
import {
  answerApproval,
  approvalAttention,
  approvalOutcome,
  encodeApprovalAnswer,
  isApprovalAnswered,
  isApproved,
  raiseApproval,
  recordApprovalEffectFailure,
  type Approval,
} from "./approval.js";
import { describeAsk, toolCallAsk } from "./ask.js";
import type { ApprovalId, PreGrantId } from "./ids.js";

/**
 * The approval record and its answer semantics (§6.6): approve once, deny with a
 * reason, and a denial that reaches the session as feedback rather than a fault.
 */

const A = session("sess_a");
const W = ws("ws-1");

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

function raised(): Approval {
  return raiseApproval({
    id: "appr_1" as ApprovalId,
    sessionId: A,
    workstreamId: W,
    ask: mergeAsk,
    requestId: "req_1",
    callId: "call_1",
    piercedPreGrant: {
      preGrantId: "pregrant_gh" as PreGrantId,
      description: "allow tools matching github_* for session sess_a",
    },
    at: 100,
  });
}

describe("raising", () => {
  it("carries the ask, so a surface answers it without opening the session", () => {
    const approval = raised();
    expect(approval.kind).toBe("integration-write");
    expect(approval.ask.world?.action).toBe("merge");
    expect(isApprovalAnswered(approval)).toBe(false);
    expect(describeAsk(approval.ask)).toContain("merge on github");
  });

  it("has no field from which it could resolve without a person (principle 2)", () => {
    const approval = raised();
    const keys = Object.keys(approval);
    for (const forbidden of [
      "defaultDecision",
      "expiresAt",
      "onTimeout",
      "autoApproveAfterSeconds",
    ]) {
      expect(keys).not.toContain(forbidden);
    }

    const never = () => {
      // @ts-expect-error there is no timed default on an approval (principle 2, §14)
      raiseApproval({ ...raised(), onTimeout: "approve" });
      answerApproval(raised(), {
        // @ts-expect-error nor an "always" answer: a durable grant is a PreGrant (§6.6)
        decision: "approve-always",
        by: humanAuthor,
        at: 1,
      });
    };
    expect(typeof never).toBe("function");
  });
});

describe("answering (§6.6)", () => {
  it("approves once", () => {
    const answered = answerApproval(raised(), {
      decision: "approve-once",
      by: humanAuthor,
      at: 101,
    });
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    expect(isApproved(answered.value)).toBe(true);
    expect(approvalOutcome(answered.value)).toEqual({ kind: "allow" });
  });

  it("refuses a denial with no reason: deny is feedback, not failure", () => {
    const refused = answerApproval(raised(), {
      decision: "deny",
      reason: "   ",
      by: humanAuthor,
      at: 101,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.reason).toBe("deny_needs_reason");
  });

  it("returns the denial to the session structurally, as feedback", () => {
    const answered = answerApproval(raised(), {
      decision: "deny",
      reason: "not that repository; open a PR against the fork",
      by: humanAuthor,
      at: 101,
    });
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;

    const encoded = encodeApprovalAnswer(answered.value);
    expect(encoded?.decision).toBe("deny");
    expect(encoded?.disposition).toBe("not-this-way");
    expect(encoded?.reason).toBe(
      "not that repository; open a PR against the fork",
    );
    expect(encoded?.sentence).toContain("not a failure");

    const outcome = approvalOutcome(answered.value);
    expect(outcome).toEqual({
      kind: "deny",
      reason: "not that repository; open a PR against the fork",
    });
  });

  it("is the operator's: a session answering one is refused", () => {
    const refused = answerApproval(raised(), {
      decision: "approve-once",
      by: sessionAuthor(A),
      at: 101,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.reason).toBe("human_only");
  });

  it("takes one answer, not two (principle 9)", () => {
    const first = answerApproval(raised(), {
      decision: "approve-once",
      by: humanAuthor,
      at: 101,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = answerApproval(first.value, {
      decision: "deny",
      reason: "changed my mind",
      by: humanAuthor,
      at: 102,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.refusal.reason).toBe("already_answered");
  });

  it("encodes nothing before it is answered", () => {
    expect(encodeApprovalAnswer(raised())).toBeNull();
    expect(approvalOutcome(raised())).toBeNull();
  });
});

describe("the attention row (§7.1)", () => {
  it("carries everything needed to answer it in place, including the pierced rule", () => {
    const row = approvalAttention(raised());
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.kind).toBe("approval");
    expect(row.irreversible).toBe(true);
    expect(row.reversibility).toBe("irreversible");
    expect(row.piercedPreGrant).toContain("github_*");
    expect(row.answers.map((answer) => answer.decision)).toEqual([
      "approve-once",
      "deny",
    ]);
    expect(
      row.answers.find((answer) => answer.decision === "deny")?.requiresReason,
    ).toBe(true);
  });

  it("stops asking once answered", () => {
    const answered = answerApproval(raised(), {
      decision: "approve-once",
      by: humanAuthor,
      at: 101,
    });
    expect(answered.ok).toBe(true);
    if (answered.ok) expect(approvalAttention(answered.value)).toBeNull();
  });
});

describe("an authorized effect that failed (§6.6)", () => {
  function approved(): Approval {
    const answered = answerApproval(raised(), {
      decision: "approve-once",
      by: humanAuthor,
      at: 101,
    });
    if (!answered.ok) throw new Error("the fixture could not answer");
    return answered.value;
  }

  function failed(): Approval {
    const recorded = recordApprovalEffectFailure(approved(), {
      message: "the runtime would not stop the session",
      at: 150,
    });
    if (!recorded.ok) throw new Error("the fixture could not record a failure");
    return recorded.value;
  }

  it("does not reopen the answer: the decision was a human's and it stands", () => {
    const second = answerApproval(failed(), {
      decision: "approve-once",
      by: humanAuthor,
      at: 200,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.refusal.reason).toBe("already_answered");
  });

  it("denies the blocked call and names what did not happen", () => {
    expect(approvalOutcome(approved())).toEqual({ kind: "allow" });
    expect(approvalOutcome(failed())).toEqual({
      kind: "deny",
      reason:
        "the operator approved this, but it could not be carried out: the runtime would not stop the session",
    });
  });

  it("tells the session not to proceed, because the thing did not happen", () => {
    const encoded = encodeApprovalAnswer(failed());
    expect(encoded?.decision).toBe("approve-once");
    expect(encoded?.disposition).toBe("not-this-way");
    expect(encoded?.reason).toBe("the runtime would not stop the session");
  });

  it("leaves a denial's own feedback alone: that reason was already the answer", () => {
    const denied = answerApproval(raised(), {
      decision: "deny",
      reason: "not that repository; open a PR against the fork",
      by: humanAuthor,
      at: 101,
    });
    expect(denied.ok).toBe(true);
    if (!denied.ok) return;
    const recorded = recordApprovalEffectFailure(denied.value, {
      message: "the claim wait had already lapsed",
      at: 150,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    expect(approvalOutcome(recorded.value)).toEqual({
      kind: "deny",
      reason: "not that repository; open a PR against the fork",
    });
    expect(encodeApprovalAnswer(recorded.value)?.reason).toBe(
      "not that repository; open a PR against the fork",
    );
  });

  it("comes back to §7.1 asking for nothing, at the moment it failed", () => {
    const row = approvalAttention(failed());
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.effectFailure).toBe("the runtime would not stop the session");
    expect(row.sentence).toContain("could not be carried out");
    // Nothing to answer: the decision was made, and `answerApproval` would refuse
    // every option a surface offered here.
    expect(row.answers).toEqual([]);
    // The failure's own moment, so the queue orders it where it happened and an
    // acknowledgement of the question does not cover it (§4.5).
    expect(row.raisedAt).toBe(150);
  });

  it("keeps the first failure: a doubled report must not rewrite what went wrong", () => {
    const second = recordApprovalEffectFailure(failed(), {
      message: "something else entirely",
      at: 200,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.refusal.reason).toBe("effect_failure_recorded");
    }
    expect(failed().effectFailure?.message).toBe(
      "the runtime would not stop the session",
    );
  });

  it("refuses a failure with no answer behind it, and one with nothing said", () => {
    const unanswered = recordApprovalEffectFailure(raised(), {
      message: "it broke",
      at: 150,
    });
    expect(unanswered.ok).toBe(false);
    if (!unanswered.ok) {
      expect(unanswered.refusal.reason).toBe("effect_without_answer");
    }

    const silent = recordApprovalEffectFailure(approved(), {
      message: "   ",
      at: 150,
    });
    expect(silent.ok).toBe(false);
    if (!silent.ok) {
      expect(silent.refusal.reason).toBe("effect_failure_needs_message");
    }
  });
});
