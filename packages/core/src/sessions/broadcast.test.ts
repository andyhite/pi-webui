import { describe, expect, it } from "vitest";

import {
  newEdgeId,
  newNodeId,
  newObjectId,
  newSessionId,
  newWorkstreamId,
  type SessionId,
} from "../ids.js";
import type { LineageIndex } from "../lineage.js";
import { newRepositoryId, newWorkspaceId } from "../workspaces/ids.js";
import {
  attributeBroadcastSpend,
  broadcastActivity,
  broadcastAttention,
  checkBroadcastRate,
  createBroadcastRateLimiter,
  DEFAULT_SESSION_BROADCAST_POLICY,
  evaluateHumanBroadcastTarget,
  evaluateSessionBroadcastScope,
  planHumanBroadcast,
  planSessionBroadcast,
  senderSharesScope,
  type BroadcastIds,
  type BroadcastMember,
  type BroadcastSend,
  type BroadcastWorld,
} from "./broadcast.js";
import { attributedTotal } from "./tools/delegation.js";

const REPO = newRepositoryId();
const OTHER_REPO = newRepositoryId();
const WORKSPACE = newWorkspaceId();

const parent = newSessionId();
const sender = newSessionId();
const peer = newSessionId();
const elsewhere = newSessionId();
const stopped = newSessionId();

const senderWorkstream = newWorkstreamId();
const peerWorkstream = newWorkstreamId();

function member(
  sessionId: SessionId,
  overrides: Partial<BroadcastMember> = {},
): BroadcastMember {
  return {
    sessionId,
    workstreamId: peerWorkstream,
    nodeId: newNodeId(),
    workspaceId: WORKSPACE,
    repositoryIds: [REPO],
    running: true,
    ...overrides,
  };
}

const world: BroadcastWorld = {
  members: [
    member(sender, { workstreamId: senderWorkstream }),
    member(parent, { workstreamId: senderWorkstream }),
    member(peer),
    member(elsewhere, {
      repositoryIds: [OTHER_REPO],
      workspaceId: newWorkspaceId(),
    }),
    member(stopped, { running: false }),
  ],
};

/** sender's parent is `parent`; everyone else was started by a human. */
const lineage: LineageIndex = {
  parentOf: (session) => (session === sender ? parent : null),
};

function ids(): BroadcastIds {
  return {
    broadcastId: "bcast-1",
    objectId: newObjectId(),
    nodeId: newNodeId(),
    forRecipient: (sessionId) => ({
      // Derived from the batch key, so a replay writes the same rows.
      injectionId: `bcast-1:${sessionId}`,
      edgeId: newEdgeId(),
      ordinal: 1,
    }),
  };
}

describe("scope of material state, never a recipient list (§6.5)", () => {
  it("resolves everyone-in-repository from workspace facts", () => {
    const recipients = evaluateSessionBroadcastScope(
      world,
      { kind: "everyone-in-repository", repositoryId: REPO },
      sender,
    );

    expect(recipients.map((entry) => entry.sessionId).sort()).toEqual(
      [parent, peer].sort(),
    );
  });

  it("resolves everyone-in-workspace, and never a session that ended", () => {
    const recipients = evaluateSessionBroadcastScope(
      world,
      { kind: "everyone-in-workspace", workspaceId: WORKSPACE },
      sender,
    );

    expect(recipients.map((entry) => entry.sessionId)).not.toContain(stopped);
    expect(recipients.map((entry) => entry.sessionId)).not.toContain(elsewhere);
  });

  it("includes the sender's own chain: the scope rule closes the channel, not lineage", () => {
    // §6.5, quoted in broadcast.ts: "Excluding the sender's chain would exclude
    // exactly the sessions most likely affected."
    const recipients = evaluateSessionBroadcastScope(
      world,
      { kind: "everyone-in-repository", repositoryId: REPO },
      sender,
    );

    expect(recipients.map((entry) => entry.sessionId)).toContain(parent);
    // The sender itself is not a recipient: it already knows.
    expect(recipients.map((entry) => entry.sessionId)).not.toContain(sender);
  });
});

describe("the operator's broadcast is unconstrained (§6.5)", () => {
  it("targets a selection, a workstream, or everything running", () => {
    expect(
      evaluateHumanBroadcastTarget(world, {
        kind: "selection",
        sessionIds: [peer, stopped],
      }).map((entry) => entry.sessionId),
    ).toEqual([peer]);

    expect(
      evaluateHumanBroadcastTarget(world, {
        kind: "workstream",
        workstreamId: senderWorkstream,
      }).map((entry) => entry.sessionId),
    ).toEqual([sender, parent]);

    expect(
      evaluateHumanBroadcastTarget(world, { kind: "everything-running" }),
    ).toHaveLength(4);
  });

  it("carries no category, no rate bound, and one content node for all of them", () => {
    const planned = planHumanBroadcast(world, {
      ids: ids(),
      target: { kind: "everything-running" },
      text: "everyone stop touching main",
      at: 5_000,
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.category).toBeNull();
    expect(planned.plan.author).toEqual({ kind: "human" });
    expect(planned.plan.spendChargedTo).toEqual([]);
    expect(planned.plan.deliveries).toHaveLength(4);
    // The same content, once: every edge starts at one node (§6.5).
    for (const delivery of planned.plan.deliveries) {
      expect(delivery.edge.from).toBe(planned.plan.content.nodeId);
      expect(delivery.edge.author).toEqual({ kind: "human" });
    }
    expect(broadcastAttention(planned.plan)).toBeNull();
  });

  it("refuses when nothing in the selection is running", () => {
    const planned = planHumanBroadcast(world, {
      ids: ids(),
      target: { kind: "selection", sessionIds: [stopped] },
      text: "hello?",
      at: 5_000,
    });

    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.reason).toBe("empty_scope");
  });
});

describe("a session's broadcast carries its constraints (§6.5)", () => {
  const request = {
    ids: ids(),
    senderSessionId: sender,
    scope: { kind: "everyone-in-repository", repositoryId: REPO } as const,
    category: "material-state-changed" as const,
    text: "I rebased the shared branch; re-read before you write",
    at: 10_000,
  };

  it("puts the declared category on the content itself", () => {
    const planned = planSessionBroadcast(
      { world, history: [], lineage },
      request,
    );

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.content.title).toContain("[material-state-changed]");
    expect(planned.plan.category).toBe("material-state-changed");
    expect(planned.plan.author).toEqual({ kind: "session", sessionId: sender });
  });

  it("names the sender's whole chain as what the induced spend is charged to", () => {
    const planned = planSessionBroadcast(
      { world, history: [], lineage },
      request,
    );

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.spendChargedTo).toEqual([sender, parent]);

    // One recipient's induced turn: its own budget, plus the sender's chain.
    const entries = attributeBroadcastSpend(planned.plan, {
      sessionId: peer,
      amountUsd: 0.4,
      basis: "reported",
      at: 11_000,
    });

    expect(attributedTotal(entries, peer)).toBeCloseTo(0.4);
    expect(attributedTotal(entries, sender)).toBeCloseTo(0.4);
    expect(attributedTotal(entries, parent)).toBeCloseTo(0.4);
    expect(entries.filter((entry) => entry.basis === "own")).toHaveLength(1);
  });

  it("charges a recipient inside the sender's chain exactly once", () => {
    const planned = planSessionBroadcast(
      { world, history: [], lineage },
      request,
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const entries = attributeBroadcastSpend(planned.plan, {
      sessionId: parent,
      amountUsd: 1,
      basis: "priced",
      at: 11_000,
    });

    expect(entries.filter((entry) => entry.sessionId === parent)).toHaveLength(
      1,
    );
    expect(attributedTotal(entries, parent)).toBe(1);
  });

  it("refuses when nothing shares the material state, without spending the bound", () => {
    const planned = planSessionBroadcast(
      {
        world: {
          members: [member(sender, { workstreamId: senderWorkstream })],
        },
        history: [],
        lineage,
      },
      request,
    );

    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.reason).toBe("empty_scope");
  });

  it("refuses a scope the sender does not stand in (§6.5's 'this' repository)", () => {
    // The attack this closes: a foreign workspace with one session in it is a
    // recipient list of exactly one, dressed as a scope of shared state.
    const foreignWorkspace = newWorkspaceId();
    const alone = newSessionId();
    const planned = planSessionBroadcast(
      {
        world: {
          members: [
            member(sender, {
              workstreamId: senderWorkstream,
              workspaceId: WORKSPACE,
            }),
            member(alone, { workspaceId: foreignWorkspace }),
          ],
        },
        history: [],
        lineage,
      },
      {
        ...request,
        scope: { kind: "everyone-in-workspace", workspaceId: foreignWorkspace },
      },
    );

    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.reason).toBe("scope_not_shared");
  });

  it("refuses a repository the sender's workspace does not stand in", () => {
    const planned = planSessionBroadcast(
      { world, history: [], lineage },
      {
        ...request,
        scope: { kind: "everyone-in-repository", repositoryId: OTHER_REPO },
      },
    );

    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.reason).toBe("scope_not_shared");
  });

  it("refuses a sender the world does not know: absent membership is not membership", () => {
    const stranger = newSessionId();
    const planned = planSessionBroadcast(
      { world, history: [], lineage },
      { ...request, senderSessionId: stranger },
    );

    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.reason).toBe("scope_not_shared");
  });

  it("checks the shared scope before the rate bound, so probing costs nothing", () => {
    // Three sends already in the window: rate-limited if it got that far. It must
    // not, or a `rate_limited` answer would confirm a scope the sender is not in.
    const full: readonly BroadcastSend[] = [
      { senderSessionId: sender, at: 9_990 },
      { senderSessionId: sender, at: 9_991 },
      { senderSessionId: sender, at: 9_992 },
    ];
    const planned = planSessionBroadcast(
      { world, history: full, lineage },
      {
        ...request,
        scope: { kind: "everyone-in-repository", repositoryId: OTHER_REPO },
      },
    );

    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.reason).toBe("scope_not_shared");
  });

  it("tells the scope question apart from the may-I question", () => {
    // `evaluateSessionBroadcastScope` still answers "who is in that scope" for a
    // scope the sender is not in — that is the operator's question, and it is not
    // the one that gates a session.
    expect(
      evaluateSessionBroadcastScope(
        world,
        { kind: "everyone-in-repository", repositoryId: OTHER_REPO },
        sender,
      ).map((entry) => entry.sessionId),
    ).toEqual([elsewhere]);

    expect(
      senderSharesScope(
        world,
        { kind: "everyone-in-repository", repositoryId: REPO },
        sender,
      ),
    ).toBe(true);
    expect(
      senderSharesScope(
        world,
        { kind: "everyone-in-repository", repositoryId: OTHER_REPO },
        sender,
      ),
    ).toBe(false);
  });

  it("is visible to the operator: one attention row, one activity entry per workstream", () => {
    const planned = planSessionBroadcast(
      { world, history: [], lineage },
      request,
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const attention = broadcastAttention(planned.plan);
    expect(attention).toMatchObject({
      kind: "session-broadcast",
      senderSessionId: sender,
      category: "material-state-changed",
      recipientCount: 2,
    });
    expect([...(attention?.recipientWorkstreamIds ?? [])].sort()).toEqual(
      [senderWorkstream, peerWorkstream].sort(),
    );

    const activity = broadcastActivity(planned.plan);
    expect(activity).toHaveLength(2);
    expect(
      activity.every((entry) => entry.category === "material-state-changed"),
    ).toBe(true);
  });
});

describe("bounded per sender per window (§6.5)", () => {
  const history: readonly BroadcastSend[] = [
    { senderSessionId: sender, at: 1_000 },
    { senderSessionId: sender, at: 1_100 },
    { senderSessionId: sender, at: 1_200 },
  ];

  it("allows up to the policy's count inside the window", () => {
    expect(
      checkBroadcastRate(history.slice(0, 2), sender, 1_300),
    ).toMatchObject({ allowed: true, sentInWindow: 2 });
  });

  it("refuses the next one and says when it frees up", () => {
    const check = checkBroadcastRate(history, sender, 1_300);

    expect(check.allowed).toBe(false);
    expect(check.sentInWindow).toBe(3);
    // The oldest send leaves the window an hour after it happened.
    expect(check.retryAfterSeconds).toBe(
      1_000 + DEFAULT_SESSION_BROADCAST_POLICY.windowSeconds - 1_300,
    );
  });

  it("counts per sender, not globally", () => {
    expect(checkBroadcastRate(history, peer, 1_300).allowed).toBe(true);
  });

  it("lets sends age out of the window", () => {
    const later = 1_000 + DEFAULT_SESSION_BROADCAST_POLICY.windowSeconds + 1;
    expect(checkBroadcastRate(history, sender, later).allowed).toBe(true);
  });

  it("refuses a fourth broadcast at the plan level", () => {
    const planned = planSessionBroadcast(
      { world, history, lineage },
      {
        ids: ids(),
        senderSessionId: sender,
        scope: { kind: "everyone-in-repository", repositoryId: REPO },
        category: "shared-resource-warning",
        text: "the test database is locked",
        at: 1_300,
      },
    );

    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.reason).toBe("rate_limited");
    expect(planned.refusal.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("takes an injected clock, and only records what it is told to", () => {
    let now = 1_000;
    const limiter = createBroadcastRateLimiter({
      now: () => now,
      policy: { windowSeconds: 60, maxPerWindow: 1 },
    });

    expect(limiter.check(sender).allowed).toBe(true);
    limiter.record(sender);
    expect(limiter.check(sender).allowed).toBe(false);

    now += 61;
    expect(limiter.check(sender).allowed).toBe(true);
    expect(limiter.history()).toEqual([{ senderSessionId: sender, at: 1_000 }]);
  });
});
