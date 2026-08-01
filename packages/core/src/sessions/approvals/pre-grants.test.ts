import { describe, expect, it } from "vitest";

import { humanAuthor, sessionAuthor } from "../../author.js";
import { session, ws } from "../../claims/testing.js";
import { destructionAsk, toolCallAsk, type ApprovalAsk } from "./ask.js";
import type { PreGrantId } from "./ids.js";
import {
  ALL_APPROVAL_EXTENTS,
  declarePreGrant,
  evaluatePreGrants,
  preGrantable,
  preGrantPiercedBy,
  withdrawPreGrant,
  type PreGrant,
} from "./pre-grants.js";

/**
 * Pre-grants (§6.6): a human decision about capability made in advance, deny-wins
 * precedence, and — structurally — nothing that covers an irreversible write.
 */

const A = session("sess_a");
const W = ws("ws-1");
const subject = { sessionId: A, workstreamId: W };

function preGrant(overrides: Partial<PreGrant> = {}): PreGrant {
  return {
    id: "pregrant_001" as PreGrantId,
    scope: { kind: "session", sessionId: A },
    effect: "allow",
    kinds: ["tool-permission"],
    toolPattern: "**",
    extents: [...ALL_APPROVAL_EXTENTS],
    grantedBy: humanAuthor,
    grantedAt: 1_000,
    withdrawnAt: null,
    ...overrides,
  };
}

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

const unknownAsk = toolCallAsk({
  toolName: "jira_transition",
  summary: "jira_transition",
  intent: { kind: "none" },
  world: {
    kind: "outside-world",
    system: "jira",
    action: "transition",
    reversibility: "unknown",
  },
});

function grantable(ask: ApprovalAsk) {
  const value = preGrantable(ask);
  if (value === null) throw new Error("expected a pre-grantable ask");
  return value;
}

describe("declaring a pre-grant (§6.6)", () => {
  it("is a human act; a session declaring one is refused", () => {
    const refused = declarePreGrant({
      id: "pregrant_x" as PreGrantId,
      scope: { kind: "session", sessionId: A },
      effect: "allow",
      kinds: ["tool-permission"],
      by: sessionAuthor(A),
      at: 1,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.reason).toBe("human_only");
  });

  it("refuses one that covers nothing", () => {
    const refused = declarePreGrant({
      id: "pregrant_x" as PreGrantId,
      scope: { kind: "workstream", workstreamId: W },
      effect: "allow",
      kinds: [],
      by: humanAuthor,
      at: 1,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.reason).toBe("covers_nothing");
  });

  it("refuses to generalize from an irreversible ask rather than accepting a grant that would never fire", () => {
    const refused = declarePreGrant({
      id: "pregrant_x" as PreGrantId,
      scope: { kind: "session", sessionId: A },
      effect: "allow",
      kinds: ["integration-write"],
      by: humanAuthor,
      at: 1,
      generalizing: mergeAsk,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.reason).toBe("irreversible_not_pre_grantable");
    }
  });

  it("carries no expiry: it is withdrawn by a human or it stands (principle 2)", () => {
    const declared = declarePreGrant({
      id: "pregrant_x" as PreGrantId,
      scope: { kind: "session", sessionId: A },
      effect: "allow",
      kinds: ["tool-permission"],
      by: humanAuthor,
      at: 1,
    });
    expect(declared.ok).toBe(true);
    if (!declared.ok) return;
    expect(Object.keys(declared.value)).not.toContain("expiresAt");

    const withdrawn = withdrawPreGrant(declared.value, humanAuthor, 5);
    expect(withdrawn.ok).toBe(true);
    if (withdrawn.ok) expect(withdrawn.value.withdrawnAt).toBe(5);

    const bySession = withdrawPreGrant(declared.value, sessionAuthor(A), 5);
    expect(bySession.ok).toBe(false);
  });
});

describe("coverage", () => {
  it("covers an ask whose kind, extent, and tool all match", () => {
    const verdict = evaluatePreGrants(
      [preGrant({ toolPattern: "ba*" })],
      grantable(shellAsk),
      subject,
    );
    expect(verdict.kind).toBe("allow");
  });

  it("does not cover an unbounded extent the grant did not name", () => {
    const verdict = evaluatePreGrants(
      [preGrant({ extents: ["none", "paths"] })],
      grantable(shellAsk),
      subject,
    );
    expect(verdict.kind).toBe("unstated");
  });

  it("does not cover a kind the grant did not name", () => {
    const verdict = evaluatePreGrants(
      [preGrant({ kinds: ["tool-permission"] })],
      grantable(commentAsk),
      subject,
    );
    expect(verdict.kind).toBe("unstated");
  });

  it("binds by scope: another session's grant covers nothing", () => {
    const verdict = evaluatePreGrants(
      [preGrant({ scope: { kind: "session", sessionId: session("sess_b") } })],
      grantable(shellAsk),
      subject,
    );
    expect(verdict.kind).toBe("unstated");
  });

  it("covers by workstream as well as by session (§6.6)", () => {
    const verdict = evaluatePreGrants(
      [preGrant({ scope: { kind: "workstream", workstreamId: W } })],
      grantable(shellAsk),
      subject,
    );
    expect(verdict.kind).toBe("allow");
  });

  it("covers nothing by workstream when the caller does not know which one binds", () => {
    const verdict = evaluatePreGrants(
      [preGrant({ scope: { kind: "workstream", workstreamId: W } })],
      grantable(shellAsk),
      { sessionId: A, workstreamId: null },
    );
    expect(verdict.kind).toBe("unstated");
  });

  it("stops covering once withdrawn", () => {
    const verdict = evaluatePreGrants(
      [preGrant({ withdrawnAt: 2_000 })],
      grantable(shellAsk),
      subject,
    );
    expect(verdict.kind).toBe("unstated");
  });

  it("covers a destruction ask, because a soft delete has an inverse (principle 10)", () => {
    const ask = destructionAsk({
      toolName: "object_delete",
      target: { kind: "object", id: "obj_1" },
    });
    const verdict = evaluatePreGrants(
      [
        preGrant({
          kinds: ["destruction"],
          toolPattern: "object_delete",
          extents: ["none"],
        }),
      ],
      grantable(ask),
      subject,
    );
    expect(verdict.kind).toBe("allow");
  });
});

describe("precedence", () => {
  it("deny wins over a more specific allow", () => {
    const verdict = evaluatePreGrants(
      [
        preGrant({
          id: "pregrant_deny" as PreGrantId,
          effect: "deny",
          scope: { kind: "workstream", workstreamId: W },
          toolPattern: "**",
        }),
        preGrant({
          id: "pregrant_allow" as PreGrantId,
          effect: "allow",
          toolPattern: "bash",
        }),
      ],
      grantable(shellAsk),
      subject,
    );
    expect(verdict.kind).toBe("deny");
    if (verdict.kind === "deny") expect(verdict.by.id).toBe("pregrant_deny");
  });

  it("reports the most specific matching rule, which never changes the verdict", () => {
    const verdict = evaluatePreGrants(
      [
        preGrant({
          id: "pregrant_broad" as PreGrantId,
          scope: { kind: "workstream", workstreamId: W },
          toolPattern: "**",
        }),
        preGrant({ id: "pregrant_exact" as PreGrantId, toolPattern: "bash" }),
      ],
      grantable(shellAsk),
      subject,
    );
    expect(verdict.kind).toBe("allow");
    if (verdict.kind === "allow") expect(verdict.by.id).toBe("pregrant_exact");
  });

  it("is order-independent", () => {
    const rules = [
      preGrant({ id: "pregrant_a" as PreGrantId, toolPattern: "bash" }),
      preGrant({
        id: "pregrant_b" as PreGrantId,
        effect: "deny",
        toolPattern: "b*",
      }),
    ];
    const forwards = evaluatePreGrants(rules, grantable(shellAsk), subject);
    const backwards = evaluatePreGrants(
      [...rules].reverse(),
      grantable(shellAsk),
      subject,
    );
    expect(forwards).toEqual(backwards);
    expect(forwards.kind).toBe("deny");
  });
});

describe("irreversibility pierces pre-grants (§6.6, §9.2)", () => {
  it("has no pre-grantable form for an irreversible ask", () => {
    expect(preGrantable(mergeAsk)).toBeNull();
    expect(preGrantable(commentAsk)).not.toBeNull();
  });

  it("treats an undeclared reversibility as irreversible (principle 7)", () => {
    expect(preGrantable(unknownAsk)).toBeNull();
    expect(unknownAsk.trigger).toBe("irreversible-write");
  });

  it("names the pre-grant it pierced, so the raise does not read as a misconfiguration", () => {
    const covering = preGrant({
      id: "pregrant_gh" as PreGrantId,
      kinds: ["integration-write"],
      toolPattern: "github_*",
    });
    const pierced = preGrantPiercedBy([covering], mergeAsk, subject);
    expect(pierced?.preGrantId).toBe("pregrant_gh");
    expect(pierced?.description).toContain("github_*");
    // Nothing to pierce when the ask can be covered honestly.
    expect(preGrantPiercedBy([covering], commentAsk, subject)).toBeNull();
  });

  it("cannot be asked for a coverage verdict on an irreversible ask, at all", () => {
    // The structural half of the rule, and the reason this test exists: the type
    // of `evaluatePreGrants` refuses an `ApprovalAsk` that is not `PreGrantable`,
    // and `preGrantable` is the only constructor. If this ever compiles, the
    // unused directive fails the build — which is the only way "pierces" stays a
    // property of the code rather than a habit.
    const never = () => {
      // @ts-expect-error an irreversible ask has no pre-grantable form (§6.6)
      evaluatePreGrants([preGrant()], mergeAsk, subject);
      // @ts-expect-error nor does a bare ask, however reversible it happens to be
      evaluatePreGrants([preGrant()], commentAsk, subject);
    };
    expect(typeof never).toBe("function");
  });
});
