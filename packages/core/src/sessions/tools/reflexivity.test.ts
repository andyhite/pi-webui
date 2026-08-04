import { describe, expect, it } from "vitest";

import { humanAuthor, sessionAuthor } from "../../author.js";
import type { ProposalId } from "../../claims/ids.js";
import type { SessionId } from "../../ids.js";
import type { LineageIndex } from "../../lineage.js";
import {
  checkToolCall,
  decideProposal,
  proposeToolCall,
  type ToolTarget,
  type ToolTargetIndex,
} from "./reflexivity.js";

/**
 * Principle 1 at the point of call: "no session authors context/capabilities/
 * budget into its own initiation chain" — enforced, including when the attempt is
 * routed through a chain the caller started.
 */

const ROOT = "sess_root" as SessionId;
const CHILD = "sess_child" as SessionId;
const GRANDCHILD = "sess_grandchild" as SessionId;
const STRANGER = "sess_stranger" as SessionId;

/** ROOT → CHILD → GRANDCHILD; STRANGER was started by a human directly. */
const lineage: LineageIndex = {
  parentOf: (session) => {
    if (session === GRANDCHILD) return CHILD;
    if (session === CHILD) return ROOT;
    return null;
  },
};

function targetsOf(map: Record<string, readonly SessionId[]>): ToolTargetIndex {
  return { sessionsAffected: (target: ToolTarget) => map[target.id] ?? [] };
}

const commandFeedingChild: ToolTarget = { kind: "command", id: "cmd_child" };
const commandFeedingStranger: ToolTarget = {
  kind: "command",
  id: "cmd_stranger",
};

const targets = targetsOf({
  cmd_child: [CHILD],
  cmd_stranger: [STRANGER],
  cmd_grandchild: [GRANDCHILD],
  cmd_root: [ROOT],
});

describe("checkToolCall", () => {
  it("lets a human do anything", () => {
    const check = checkToolCall(
      { actor: humanAuthor, lineage, targets },
      {
        tool: "edge_wire",
        input: { from: "n1", to: "n2" },
        target: commandFeedingChild,
      },
    );
    expect(check.allowed).toBe(true);
  });

  it("refuses a session wiring context into itself", () => {
    const check = checkToolCall(
      { actor: sessionAuthor(CHILD), lineage, targets },
      { tool: "edge_wire", input: {}, target: commandFeedingChild },
    );
    expect(check.allowed).toBe(false);
    if (check.allowed) return;
    expect(check.refusal.reason).toBe("own_chain");
    expect(check.refusal.message).toContain("itself");
  });

  it("refuses authoring into an ancestor", () => {
    const check = checkToolCall(
      { actor: sessionAuthor(GRANDCHILD), lineage, targets },
      {
        tool: "edge_wire",
        input: {},
        target: { kind: "command", id: "cmd_root" },
      },
    );
    expect(check.allowed).toBe(false);
  });

  it("refuses routing around it through a chain the caller started", () => {
    // ROOT cannot author into GRANDCHILD either: it started the chain that
    // started it, which is precisely the route principle 1 closes.
    const check = checkToolCall(
      { actor: sessionAuthor(ROOT), lineage, targets },
      {
        tool: "context_reorder",
        input: {},
        target: { kind: "command", id: "cmd_grandchild" },
      },
    );
    expect(check.allowed).toBe(false);
    if (check.allowed) return;
    expect(check.refusal.reason).toBe("own_chain");
    expect(check.refusal.details?.chain).toEqual([ROOT]);
  });

  it("lets sessions outside each other's chains exchange context freely", () => {
    const check = checkToolCall(
      { actor: sessionAuthor(CHILD), lineage, targets },
      { tool: "edge_wire", input: {}, target: commandFeedingStranger },
    );
    expect(check.allowed).toBe(true);
  });

  it("refuses a capability grant routed at the caller's own chain", () => {
    const check = checkToolCall(
      { actor: sessionAuthor(CHILD), lineage, targets },
      {
        tool: "command_definition_edit",
        input: {
          id: "cmddef_1",
          permissions: { allowed: ["bash"], denied: [] },
        },
        target: { kind: "command", id: "cmd_grandchild" },
      },
    );
    expect(check.allowed).toBe(false);
    if (check.allowed) return;
    expect(check.refusal.message).toContain("grant capability to");
  });

  it("does not tell a session it authored context when it deleted a record", () => {
    // `session_delete` is `target-session` and destroys; `session_stop`'s catalog
    // entry states the distinction ("stopping is not authoring: it takes capability
    // away rather than granting any"). The refusal an agent parses names the
    // gesture it made, so the general word is "act on" and only the expansion
    // classes name what they expand.
    const check = checkToolCall(
      {
        actor: sessionAuthor(CHILD),
        lineage,
        // A session target resolves to itself, which is what the six
        // `/api/sessions/:id` verbs declare (`sessionTargetedTools`).
        targets: targetsOf({ [ROOT]: [ROOT] }),
      },
      {
        tool: "session_delete",
        input: { sessionId: ROOT },
        target: { kind: "session", id: ROOT },
      },
    );
    expect(check.allowed).toBe(false);
    if (check.allowed) return;
    expect(check.refusal.message).toContain("session_delete would act on");
    expect(check.refusal.message).not.toContain("author context into");
  });

  it("refuses the operator's own gestures to a session", () => {
    for (const tool of [
      "claim_grant",
      "claim_force_release",
      "proposal_accept",
    ]) {
      const check = checkToolCall(
        { actor: sessionAuthor(CHILD), lineage, targets },
        { tool, input: {} },
      );
      expect(check.allowed, tool).toBe(false);
      if (check.allowed) return;
      expect(check.refusal.reason, tool).toBe("human_only");
    }
  });

  it("turns a self-touching target into a proposal rather than a refusal to act", () => {
    const check = checkToolCall(
      { actor: sessionAuthor(CHILD), lineage, targets },
      {
        tool: "command_parameter_confirm",
        input: { id: "cmd_child", name: "repo", value: "plotroom" },
      },
    );
    expect(check.allowed).toBe(false);
    if (check.allowed) return;
    expect(check.refusal.reason).toBe("proposal_required");
    expect(check.refusal.details?.proposeWith).toBe("proposal_create");
  });

  it("refuses a tool nobody declared", () => {
    const check = checkToolCall(
      { actor: sessionAuthor(CHILD), lineage, targets },
      { tool: "rm_rf_everything", input: {} },
    );
    expect(check.allowed).toBe(false);
    if (check.allowed) return;
    expect(check.refusal.reason).toBe("unknown_tool");
  });

  it("allows a lineage-classed tool with no resolvable target", () => {
    // Nothing to reach means nothing to refuse; the graph, not this layer, decides
    // what a target feeds.
    const check = checkToolCall(
      { actor: sessionAuthor(CHILD), lineage },
      { tool: "edge_wire", input: {} },
    );
    expect(check.allowed).toBe(true);
  });

  it("lets a session dispatch a child — a delegation is not reflexive", () => {
    // A command nobody has run resolves to no sessions, which is why dispatch can
    // be lineage-checked without refusing delegation: "a delegation's result
    // returning to the delegator is not this" (principle 1).
    const check = checkToolCall(
      { actor: sessionAuthor(CHILD), lineage, targets },
      {
        tool: "run_one",
        input: { commandId: "cmd_new", initiationKey: "gesture-1" },
        target: { kind: "command", id: "cmd_new" },
      },
    );
    expect(check.allowed).toBe(true);
  });

  it("refuses re-running a command whose session is in the caller's own chain", () => {
    // §4.1's rule, now expressible: dispatch resolves to the sessions the command
    // has already run, so re-running work inside its own chain is refused while
    // starting new work is not.
    const check = checkToolCall(
      { actor: sessionAuthor(CHILD), lineage, targets },
      {
        tool: "run_one",
        input: { commandId: "cmd_grandchild", initiationKey: "gesture-2" },
        target: { kind: "command", id: "cmd_grandchild" },
      },
    );
    expect(check.allowed).toBe(false);
    if (check.allowed) return;
    expect(check.refusal.reason).toBe("own_chain");
    expect(check.refusal.details?.targetSessionId).toBe(GRANDCHILD);
  });

  it("still lets a session dispatch work outside its chain", () => {
    const check = checkToolCall(
      { actor: sessionAuthor(CHILD), lineage, targets },
      {
        tool: "run_one",
        input: { commandId: "cmd_stranger", initiationKey: "gesture-3" },
        target: commandFeedingStranger,
      },
    );
    expect(check.allowed).toBe(true);
  });
});

describe("propose and accept", () => {
  const proposal = proposeToolCall({
    id: "proposal_1" as ProposalId,
    proposedBy: CHILD,
    call: {
      tool: "command_parameter_confirm",
      input: { id: "cmd_child", name: "repo" },
    },
    rationale: "derived from the target",
    at: 1_700_000_000,
  });

  it("starts pending, never applied", () => {
    expect(proposal.state).toBe("pending");
    expect(proposal.decidedAt).toBeNull();
  });

  it("is accepted only by a human", () => {
    const bySession = decideProposal(
      proposal,
      "accept",
      sessionAuthor(ROOT),
      1,
    );
    expect(bySession.ok).toBe(false);
    if (bySession.ok) return;
    expect(bySession.refusal.reason).toBe("human_only");

    const byHuman = decideProposal(proposal, "accept", humanAuthor, 2);
    expect(byHuman.ok).toBe(true);
    if (!byHuman.ok) return;
    expect(byHuman.proposal.state).toBe("accepted");
    expect(byHuman.proposal.decidedAt).toBe(2);
  });

  it("cannot be decided twice", () => {
    const accepted = decideProposal(proposal, "accept", humanAuthor, 2);
    if (!accepted.ok) throw new Error("expected acceptance");
    const again = decideProposal(accepted.proposal, "reject", humanAuthor, 3);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.refusal.reason).toBe("already_decided");
  });

  it("records rejection as a decision, not as a disappearance", () => {
    const rejected = decideProposal(proposal, "reject", humanAuthor, 5);
    expect(rejected.ok && rejected.proposal.state).toBe("rejected");
  });
});
