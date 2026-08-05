import { describe, expect, it } from "vitest";

import { humanAuthor } from "../../author.js";
import { createClaimManager } from "../../claims/manager.js";
import {
  rootClaimOf,
  type Claim,
  type ClaimState,
} from "../../claims/model.js";
import {
  countingClaimIds,
  session,
  testClock,
  ws,
} from "../../claims/testing.js";
import type { SessionId } from "../../ids.js";
import type { RuntimeRequest } from "../runtime.js";
import { createOmpWriteIntents } from "../adapters/omp/write-intents.js";
import { declareToolWorld } from "../outside-world.js";
import type { PreGrantId } from "../approvals/ids.js";
import {
  ALL_APPROVAL_EXTENTS,
  type PreGrant,
} from "../approvals/pre-grants.js";
import {
  decideToolPermission,
  UNKNOWN_WRITE_INTENTS,
  type WriteIntentDeclaration,
} from "./gate.js";

/**
 * Claims gating the runtime per call (§3.4, decision 0001's C6): the answer the pi
 * permission gate blocks on.
 */

const A: SessionId = session("sess_a");
const B: SessionId = session("sess_b");

const writesFile: WriteIntentDeclaration = {
  adapterId: "test",
  intentOf: (toolName, input) =>
    toolName === "write_file"
      ? { kind: "paths", paths: [(input as { path: string }).path] }
      : toolName === "read_file"
        ? { kind: "none" }
        : { kind: "unbounded", reason: "unknown tool" },
};

function toolCall(toolName: string, input: unknown): RuntimeRequest {
  return { kind: "tool-permission", toolName, input };
}

const W = ws();

/** §9.2's declarations: one reversible, one irreversible, one that cannot tell. */
const worldDeclarations = declareToolWorld({
  github_merge_pr: {
    kind: "outside-world",
    system: "github",
    action: "merge",
    reversibility: "irreversible",
  },
  github_comment: {
    kind: "outside-world",
    system: "github",
    action: "comment",
    reversibility: "reversible",
  },
  jira_transition: {
    kind: "outside-world",
    system: "jira",
    action: "transition",
    reversibility: "unknown",
  },
});

const writesNothing: WriteIntentDeclaration = {
  adapterId: "test",
  intentOf: () => ({ kind: "none" }),
};

function preGrant(overrides: Partial<PreGrant> = {}): PreGrant {
  return {
    id: "pregrant_001" as PreGrantId,
    scope: { kind: "session", sessionId: A },
    effect: "allow",
    kinds: ["tool-permission"],
    toolPattern: "**",
    extents: [...ALL_APPROVAL_EXTENTS],
    grantedBy: humanAuthor,
    grantedAt: 1,
    withdrawnAt: null,
    ...overrides,
  };
}

function setup(): {
  state: ClaimState;
  manager: ReturnType<typeof createClaimManager>;
} {
  const manager = createClaimManager({
    clock: testClock(),
    ids: countingClaimIds(),
  });
  const opened = manager.open(ws());
  const granted = manager.grant(opened.state, {
    path: "src",
    to: A,
    by: humanAuthor,
  });
  if (!granted.ok) throw new Error(granted.refusal.message);
  return { state: granted.state, manager };
}

describe("decideToolPermission", () => {
  it("allows a write inside a path the session holds", () => {
    const { state, manager } = setup();
    const decision = decideToolPermission(
      toolCall("write_file", { path: "src/auth.ts" }),
      {
        sessionId: A,
        claims: state,
        manager,
        intents: writesFile,
      },
    );
    expect(decision.outcome.kind).toBe("allow");
    expect(decision.paths).toEqual(["src/auth.ts"]);
  });

  it("denies a write outside it, naming the holder and what to do", () => {
    const { state, manager } = setup();
    const decision = decideToolPermission(
      toolCall("write_file", { path: "src/auth.ts" }),
      {
        sessionId: B,
        claims: state,
        manager,
        intents: writesFile,
      },
    );
    expect(decision.outcome.kind).toBe("deny");
    if (decision.outcome.kind !== "deny") return;
    expect(decision.outcome.reason).toContain("sess_a");
    expect(decision.outcome.reason).toContain("request a claim");
    // Contention is not an approval: the holder or the waitlist clears it.
    expect(decision.raisesApproval).toBe(false);
  });

  it("allows a read regardless of claims — non-claiming sessions read freely (§3.4)", () => {
    const { state, manager } = setup();
    const decision = decideToolPermission(
      toolCall("read_file", { path: "src/auth.ts" }),
      {
        sessionId: B,
        claims: state,
        manager,
        intents: writesFile,
      },
    );
    expect(decision.outcome.kind).toBe("allow");
  });

  it("denies an unbounded tool and asks for an approval instead of guessing", () => {
    const { state, manager } = setup();
    const decision = decideToolPermission(
      toolCall("bash", { command: "rm -rf ." }),
      {
        sessionId: A,
        claims: state,
        manager,
        intents: writesFile,
      },
    );
    expect(decision.outcome.kind).toBe("deny");
    expect(decision.raisesApproval).toBe(true);
  });

  it("allows an unbounded tool once its call carries an approval (§6.6)", () => {
    const { state, manager } = setup();
    const decision = decideToolPermission(
      toolCall("bash", { command: "pnpm test" }),
      {
        sessionId: A,
        claims: state,
        manager,
        intents: writesFile,
        callId: "call_1",
        approvedCallIds: new Set(["call_1"]),
      },
    );
    expect(decision.outcome.kind).toBe("allow");
  });

  it("does not treat a pre-approval for another call as an approval for this one", () => {
    const { state, manager } = setup();
    const decision = decideToolPermission(
      toolCall("bash", { command: "pnpm test" }),
      {
        sessionId: A,
        claims: state,
        manager,
        intents: writesFile,
        callId: "call_2",
        approvedCallIds: new Set(["call_1"]),
      },
    );
    expect(decision.outcome.kind).toBe("deny");
  });

  it("refuses to answer a question — that is the human's (§6.4)", () => {
    const { state, manager } = setup();
    const decision = decideToolPermission(
      { kind: "question", text: "which branch?", options: ["main"] },
      { sessionId: A, claims: state, manager, intents: writesFile },
    );
    expect(decision.outcome.kind).toBe("deny");
    expect(decision.raisesApproval).toBe(false);
  });

  it("denies a write to a path that cannot be canonicalized", () => {
    const { state, manager } = setup();
    const decision = decideToolPermission(
      toolCall("write_file", { path: "../escape.ts" }),
      {
        sessionId: A,
        claims: state,
        manager,
        intents: writesFile,
      },
    );
    expect(decision.outcome.kind).toBe("deny");
  });

  it("denies every write when the adapter has declared nothing", () => {
    const { state, manager } = setup();
    const decision = decideToolPermission(
      toolCall("write_file", { path: "src/auth.ts" }),
      {
        sessionId: A,
        claims: state,
        manager,
        intents: UNKNOWN_WRITE_INTENTS,
      },
    );
    expect(decision.outcome.kind).toBe("deny");
    expect(decision.raisesApproval).toBe(true);
  });

  it("holds every path in a multi-path write, or none of it", () => {
    const { state, manager } = setup();
    const both: WriteIntentDeclaration = {
      adapterId: "test",
      intentOf: () => ({ kind: "paths", paths: ["src/a.ts", "docs/b.md"] }),
    };
    const decision = decideToolPermission(toolCall("multi_edit", {}), {
      sessionId: A,
      claims: state,
      manager,
      intents: both,
    });
    expect(decision.outcome.kind).toBe("deny");
  });

  it("takes a pre-grant for an unbounded tool instead of raising, and says which one (§6.6)", () => {
    const { state, manager } = setup();
    const decision = decideToolPermission(toolCall("bash", { command: "ls" }), {
      sessionId: A,
      claims: state,
      manager,
      intents: writesFile,
      workstreamId: W,
      preGrants: [preGrant({ toolPattern: "bash" })],
    });
    expect(decision.outcome.kind).toBe("allow");
    expect(decision.raisesApproval).toBe(false);
    expect(decision.coveredBy).toEqual({
      kind: "pre-grant",
      preGrantId: "pregrant_001",
    });
  });

  it("still asks the claim manager about a pre-granted write — a pre-grant never pierces a claim (principle 4)", () => {
    const { state, manager } = setup();
    const decision = decideToolPermission(
      toolCall("write_file", { path: "src/auth.ts" }),
      {
        sessionId: B,
        claims: state,
        manager,
        intents: writesFile,
        workstreamId: W,
        preGrants: [
          preGrant({ scope: { kind: "workstream", workstreamId: W } }),
        ],
      },
    );
    expect(decision.outcome.kind).toBe("deny");
    if (decision.outcome.kind === "deny") {
      expect(decision.outcome.reason).toContain("sess_a");
    }
    expect(decision.raisesApproval).toBe(false);
  });

  it("denies what a standing decision refused, without asking again", () => {
    const { state, manager } = setup();
    const decision = decideToolPermission(
      toolCall("read_file", { path: "src/auth.ts" }),
      {
        sessionId: A,
        claims: state,
        manager,
        intents: writesFile,
        workstreamId: W,
        preGrants: [preGrant({ effect: "deny", toolPattern: "read_file" })],
      },
    );
    expect(decision.outcome.kind).toBe("deny");
    expect(decision.raisesApproval).toBe(false);
  });

  it("raises for a declared irreversible write that touches no workspace path at all (§6.6, §9.2)", () => {
    const { state, manager } = setup();
    const decision = decideToolPermission(toolCall("github_merge_pr", {}), {
      sessionId: A,
      claims: state,
      manager,
      // The write extent is `none`, which on its own allows outright — which is why
      // §6.6's rule cannot be a branch of the claim check.
      intents: writesNothing,
      world: worldDeclarations,
      workstreamId: W,
      preGrants: [preGrant({ kinds: ["integration-write"] })],
    });
    expect(decision.outcome.kind).toBe("deny");
    expect(decision.raisesApproval).toBe(true);
    expect(decision.piercedPreGrant?.preGrantId).toBe("pregrant_001");
    expect(decision.ask?.kind).toBe("integration-write");
  });

  it("treats an undeclared reversibility as irreversible (principle 7)", () => {
    const { state, manager } = setup();
    const decision = decideToolPermission(toolCall("jira_transition", {}), {
      sessionId: A,
      claims: state,
      manager,
      intents: writesNothing,
      world: worldDeclarations,
      workstreamId: W,
      preGrants: [preGrant({ kinds: ["integration-write"] })],
    });
    expect(decision.outcome.kind).toBe("deny");
    expect(decision.raisesApproval).toBe(true);
  });

  it("raises for a declared reversible external write that nothing pre-granted (§6.6, §9.2)", () => {
    const { state, manager } = setup();
    // The hole this closes: a reversible external write with a `none` extent used to
    // be allowed as not-gated, which made every `integration-write` pre-grant
    // vacuous — nothing was left for one to authorize, so "irreversibility pierces
    // pre-grants" pierced nothing. §6.6 lists "a write to an external system" among
    // the raisers and §9.2 makes each write action's tool "subject to approvals".
    const decision = decideToolPermission(toolCall("github_comment", {}), {
      sessionId: A,
      claims: state,
      manager,
      intents: writesNothing,
      world: worldDeclarations,
      workstreamId: W,
      preGrants: [],
    });
    expect(decision.outcome.kind).toBe("deny");
    expect(decision.raisesApproval).toBe(true);
    expect(decision.ask?.trigger).toBe("external-write");
    // Reversible, so nothing was pierced: a pre-grant *could* have covered this one.
    expect(decision.piercedPreGrant).toBeNull();
  });

  it("lets a reversible integration write through on a pre-grant — and only on one", () => {
    const { state, manager } = setup();
    const call = toolCall("github_comment", {});
    const shared = {
      sessionId: A,
      claims: state,
      manager,
      intents: writesNothing,
      world: worldDeclarations,
      workstreamId: W,
    } as const;

    // Asserted together on purpose: a pre-grant test that passes identically with
    // `preGrants: []` enshrines the hole instead of covering it.
    const ungranted = decideToolPermission(call, { ...shared, preGrants: [] });
    expect(ungranted.raisesApproval).toBe(true);

    const decision = decideToolPermission(call, {
      ...shared,
      preGrants: [preGrant({ kinds: ["integration-write"] })],
    });
    expect(decision.outcome.kind).toBe("allow");
    expect(decision.raisesApproval).toBe(false);
    expect(decision.coveredBy?.kind).toBe("pre-grant");
  });

  it("does not let a grant for one class of ask widen to another", () => {
    const { state, manager } = setup();
    // The kinds are the classes the operator granted, and a grant naming one does not
    // quietly widen to the other: a shell is not an external write, and a comment on
    // a pull request is not a workspace tool.
    const shellUnderIntegrationGrant = decideToolPermission(
      toolCall("bash", { command: "ls" }),
      {
        sessionId: A,
        claims: state,
        manager,
        intents: writesFile,
        world: worldDeclarations,
        workstreamId: W,
        preGrants: [preGrant({ kinds: ["integration-write"] })],
      },
    );
    expect(shellUnderIntegrationGrant.raisesApproval).toBe(true);

    const commentUnderToolGrant = decideToolPermission(
      toolCall("github_comment", {}),
      {
        sessionId: A,
        claims: state,
        manager,
        intents: writesNothing,
        world: worldDeclarations,
        workstreamId: W,
        preGrants: [preGrant({ kinds: ["tool-permission"] })],
      },
    );
    expect(commentUnderToolGrant.raisesApproval).toBe(true);
  });

  it("allows an irreversible write once its own call was approved from the queue", () => {
    const { state, manager } = setup();
    const decision = decideToolPermission(toolCall("github_merge_pr", {}), {
      sessionId: A,
      claims: state,
      manager,
      intents: writesNothing,
      world: worldDeclarations,
      workstreamId: W,
      callId: "call_1",
      approvedCallIds: new Set(["call_1"]),
    });
    expect(decision.outcome.kind).toBe("allow");
  });

  it("re-decides after the claim moves, without any state of its own", () => {
    const { state, manager } = setup();
    const root = rootClaimOf(state) as Claim;
    expect(root.grantedFromClaimId).toBeNull();

    const heldByA = state.claims.find(
      (claim) => claim.path.display === "src",
    ) as Claim;
    const released = manager.forceRelease(state, {
      claimId: heldByA.id,
      by: humanAuthor,
    });
    if (!released.ok) throw new Error(released.refusal.message);
    const toB = manager.grant(released.state, {
      path: "src",
      to: B,
      by: humanAuthor,
    });
    if (!toB.ok) throw new Error(toB.refusal.message);

    const call = toolCall("write_file", { path: "src/auth.ts" });
    expect(
      decideToolPermission(call, {
        sessionId: A,
        claims: toB.state,
        manager,
        intents: writesFile,
      }).outcome.kind,
    ).toBe("deny");
    expect(
      decideToolPermission(call, {
        sessionId: B,
        claims: toB.state,
        manager,
        intents: writesFile,
      }).outcome.kind,
    ).toBe("allow");
  });
});

describe("omp write intents (issue #81)", () => {
  const intents = createOmpWriteIntents();

  it("treats a shell as unbounded — it can write anything", () => {
    expect(intents.intentOf("bash", { command: "echo hi" }).kind).toBe(
      "unbounded",
    );
  });

  it("treats an undeclared tool as unbounded rather than as harmless", () => {
    expect(
      intents.intentOf("some_new_omp_tool", { path: "src/a.ts" }).kind,
    ).toBe("unbounded");
  });

  it("treats asking a question as touching nothing in the workspace", () => {
    expect(intents.intentOf("plotroom_ask", { question: "?" }).kind).toBe(
      "none",
    );
  });

  it("bounds a real workspace path to a claim", () => {
    expect(intents.intentOf("write", { path: "src/a.ts" })).toEqual({
      kind: "paths",
      paths: ["src/a.ts"],
    });
  });

  it("declares an xd:// tool-device write unbounded, never as the literal path (issue #81)", () => {
    // `write({ path: "xd://ast_edit", content })` dispatches a mounted tool
    // device whose write extent has nothing to do with the string "xd://ast_edit" —
    // binding it as a claimed path would check a path nothing writes and let
    // the device's real, unpredictable effect through unchecked.
    const intent = intents.intentOf("write", { path: "xd://ast_edit" });
    expect(intent.kind).toBe("unbounded");
  });

  it("matches xd:// the same way the SDK's own parseXdUrl does — trimmed, case-insensitive", () => {
    // A narrower check here (bare `startsWith`) would call `"XD://ast_edit"`
    // or `" xd://ast_edit"` a workspace path, a claim would bind text nothing
    // writes, and the device would still dispatch with arbitrary effect
    // ungated — the silent allow a review caught.
    expect(intents.intentOf("write", { path: "XD://ast_edit" }).kind).toBe(
      "unbounded",
    );
    expect(intents.intentOf("write", { path: " xd://ast_edit" }).kind).toBe(
      "unbounded",
    );
    expect(intents.intentOf("write", { path: "Xd://Debug" }).kind).toBe(
      "unbounded",
    );
  });

  it("falls back to unbounded when the declared path field is absent or not a string", () => {
    expect(intents.intentOf("write", { content: "x" }).kind).toBe("unbounded");
    expect(intents.intentOf("write", { path: "" }).kind).toBe("unbounded");
    expect(intents.intentOf("write", null).kind).toBe("unbounded");
  });
});
