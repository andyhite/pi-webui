import { describe, expect, it } from "vitest";
import { humanAuthor } from "../author.js";
import { createClaimManager } from "../claims/manager.js";
import type { ClaimState } from "../claims/model.js";
import { countingClaimIds, session, testClock, ws } from "../claims/testing.js";
import type { SessionId } from "../ids.js";
import { decideToolPermission } from "../sessions/tools/gate.js";
import type { WriteIntentDeclaration } from "../sessions/tools/gate.js";
import type { RuntimeRequest } from "../sessions/runtime.js";
import { ALL_APPROVAL_EXTENTS } from "../sessions/approvals/pre-grants.js";
import type { PreGrant } from "../sessions/approvals/pre-grants.js";
import type { PreGrantId } from "../sessions/approvals/ids.js";
import { decideApproval } from "../sessions/approvals/decide.js";
import { sessionAuthor } from "../author.js";
import {
  integrationToolName,
  integrationToolWorldDeclarations,
  integrationWriteAsk,
  parseIntegrationToolName,
} from "./write-world.js";
import type { IntegrationWriteActionDeclaration } from "./types.js";

/**
 * Proof that a plugin's own reversibility declarations, run through this
 * module's bridge, land on exactly the same §6.6 answers `gate.test.ts` already
 * pins for hand-written `declareToolWorld` entries — the "Batch-4 external-write
 * machinery is exactly this seam" claim, made concrete.
 */

const A: SessionId = session("sess_a");
const W = ws();

const actions: readonly IntegrationWriteActionDeclaration[] = [
  {
    id: "merge",
    action: "merge",
    system: "github",
    reversibility: "irreversible",
  },
  {
    id: "comment",
    action: "comment",
    system: "github",
    reversibility: "reversible",
  },
  {
    id: "transition",
    action: "transition",
    system: "jira",
    reversibility: "unknown",
  },
];

const world = integrationToolWorldDeclarations("github-fake", actions);

const writesNothing: WriteIntentDeclaration = {
  adapterId: "test",
  intentOf: () => ({ kind: "none" }),
};

function toolCall(toolName: string): RuntimeRequest {
  return { kind: "tool-permission", toolName, input: {} };
}

function preGrant(overrides: Partial<PreGrant> = {}): PreGrant {
  return {
    id: "pregrant_001" as PreGrantId,
    scope: { kind: "session", sessionId: A },
    effect: "allow",
    kinds: ["integration-write"],
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
  const opened = manager.open(W);
  return { state: opened.state, manager };
}

describe("integrationToolName / parseIntegrationToolName", () => {
  it("round-trips", () => {
    const name = integrationToolName("github-fake", "merge");
    expect(name).toBe("integration:github-fake:merge");
    expect(parseIntegrationToolName(name)).toEqual({
      producerId: "github-fake",
      actionId: "merge",
    });
  });

  it("returns null for a name it did not mint", () => {
    expect(parseIntegrationToolName("bash")).toBeNull();
  });
});

describe("integrationToolWorldDeclarations through decideToolPermission", () => {
  it("always asks for a declared irreversible write, pre-grant or not", () => {
    const { state, manager } = setup();
    const decision = decideToolPermission(
      toolCall(integrationToolName("github-fake", "merge")),
      {
        sessionId: A,
        claims: state,
        manager,
        intents: writesNothing,
        world,
        workstreamId: W,
        preGrants: [preGrant()],
      },
    );
    expect(decision.outcome.kind).toBe("deny");
    expect(decision.raisesApproval).toBe(true);
    expect(decision.piercedPreGrant?.preGrantId).toBe("pregrant_001");
    expect(decision.ask?.kind).toBe("integration-write");
  });

  it("treats an undeclared/unknown reversibility as irreversible (principle 7)", () => {
    const { state, manager } = setup();
    const decision = decideToolPermission(
      toolCall(integrationToolName("github-fake", "transition")),
      {
        sessionId: A,
        claims: state,
        manager,
        intents: writesNothing,
        world,
        workstreamId: W,
        preGrants: [preGrant()],
      },
    );
    expect(decision.outcome.kind).toBe("deny");
    expect(decision.raisesApproval).toBe(true);
  });

  it("asks for a reversible write with nothing pre-granted, and allows once granted", () => {
    const { state, manager } = setup();
    const call = toolCall(integrationToolName("github-fake", "comment"));
    const shared = {
      sessionId: A,
      claims: state,
      manager,
      intents: writesNothing,
      world,
      workstreamId: W,
    } as const;

    const ungranted = decideToolPermission(call, { ...shared, preGrants: [] });
    expect(ungranted.raisesApproval).toBe(true);
    expect(ungranted.ask?.trigger).toBe("external-write");

    const granted = decideToolPermission(call, {
      ...shared,
      preGrants: [preGrant()],
    });
    expect(granted.outcome.kind).toBe("allow");
    expect(granted.coveredBy?.kind).toBe("pre-grant");
  });

  it("declares nothing for a tool name it never registered", () => {
    expect(world.forTool("bash")).toBeNull();
  });
});

describe("integrationWriteAsk / decideApproval", () => {
  it("a human is never gated, whatever the reversibility", () => {
    const ask = integrationWriteAsk({
      producerId: "github-fake",
      action: actions[0] as IntegrationWriteActionDeclaration,
      summary: "merge PR #1",
    });
    const verdict = decideApproval(ask, {
      actor: humanAuthor,
      sessionId: A,
      workstreamId: W,
    });
    expect(verdict.kind).toBe("allowed");
  });

  it("a session asking for a reversible write must-asks with nothing pre-granted", () => {
    const ask = integrationWriteAsk({
      producerId: "github-fake",
      action: actions[1] as IntegrationWriteActionDeclaration,
      summary: "comment on PR #1",
    });
    const verdict = decideApproval(ask, {
      actor: sessionAuthor(A),
      sessionId: A,
      workstreamId: W,
      preGrants: [],
    });
    expect(verdict.kind).toBe("must-ask");
  });
});
