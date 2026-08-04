import { describe, expect, it } from "vitest";

import { humanAuthor, sessionAuthor } from "../../author.js";
import { session, ws } from "../../claims/testing.js";
import {
  AGENT_TOOL_CATALOG,
  destructionTools,
  toolByName,
} from "../tools/catalog.js";
import { answerApproval, raiseApproval } from "./approval.js";
import { decideDestruction, decideDestructionByName } from "./destruction.js";
import type { ApprovalId, PreGrantId } from "./ids.js";
import { ALL_APPROVAL_EXTENTS, type PreGrant } from "./pre-grants.js";

/**
 * Agent-requested destruction of authored state (§6.6, principle 10).
 */

const A = session("sess_a");
const W = ws("ws-1");
const context = {
  actor: sessionAuthor(A),
  sessionId: A,
  workstreamId: W,
} as const;

function objectDelete() {
  const tool = toolByName("object_delete");
  if (tool === undefined)
    throw new Error("object_delete is not in the catalog");
  return tool;
}

describe("the destruction class is catalog metadata", () => {
  it("is exactly the tools that remove authored state", () => {
    expect(
      destructionTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([
      "command_definition_delete",
      "command_delete",
      "edge_delete",
      "node_delete",
      "object_delete",
      // A session record is authored state too (§3.6): the transcript, the log,
      // and the provenance of everything it authored cannot be recreated.
      "session_delete",
      "workstream_delete",
    ]);
  });

  it("declares `destroys` if and only if it always raises an approval", () => {
    for (const tool of AGENT_TOOL_CATALOG) {
      expect(
        tool.requires.destroys !== undefined,
        `${tool.name}: destroys and approval:"always" must agree`,
      ).toBe(tool.requires.approval === "always");
    }
  });

  it("does not catch a DELETE that hands capability back rather than destroying state", () => {
    for (const name of [
      "claim_yield",
      "claim_wait_withdraw",
      "claim_policy_withdraw",
      "run_queue_cancel",
    ]) {
      expect(toolByName(name)?.requires.destroys).toBeUndefined();
    }
  });
});

describe("routing (§6.6)", () => {
  it("passes over a tool that destroys nothing", () => {
    const tool = toolByName("object_write");
    if (tool === undefined) throw new Error("object_write is missing");
    expect(decideDestruction({ tool, targetId: "obj_1" }, context).kind).toBe(
      "not-destruction",
    );
    expect(decideDestructionByName("no_such_tool", "x", context).kind).toBe(
      "not-destruction",
    );
  });

  it("raises rather than executing when a session asks", () => {
    const routing = decideDestruction(
      { tool: objectDelete(), targetId: "obj_1" },
      context,
    );
    expect(routing.kind).toBe("destruction");
    if (routing.kind !== "destruction") return;
    expect(routing.target).toEqual({ kind: "object", id: "obj_1" });
    expect(routing.verdict.kind).toBe("must-ask");
    if (routing.verdict.kind === "must-ask") {
      expect(routing.verdict.ask.kind).toBe("destruction");
      expect(routing.verdict.ask.target?.id).toBe("obj_1");
    }
  });

  it("executes for the operator, who is never gated", () => {
    const routing = decideDestruction(
      { tool: objectDelete(), targetId: "obj_1" },
      { ...context, actor: humanAuthor },
    );
    expect(routing.kind).toBe("destruction");
    if (routing.kind === "destruction") {
      expect(routing.verdict.kind).toBe("allowed");
    }
  });

  it("executes once the operator approves, and the delete stays recoverable (principle 10)", () => {
    const raised = raiseApproval({
      id: "appr_1" as ApprovalId,
      sessionId: A,
      workstreamId: W,
      ask: {
        kind: "destruction",
        trigger: "destruction",
        tool: "object_delete",
        summary: "object_delete on object obj_1",
        writeExtent: "none",
        paths: [],
        world: null,
        target: { kind: "object", id: "obj_1" },
      },
      at: 10,
    });
    const answered = answerApproval(raised, {
      decision: "approve-once",
      by: humanAuthor,
      at: 11,
    });
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;

    const routing = decideDestruction(
      { tool: objectDelete(), targetId: "obj_1" },
      { ...context, approval: answered.value },
    );
    expect(routing.kind).toBe("destruction");
    if (routing.kind === "destruction") {
      expect(routing.verdict.kind).toBe("allowed");
    }
  });

  it("does not execute on an approval raised for another target (principle 9)", () => {
    // The caller supplies the approval, and a caller looking one up by session finds
    // the *session's* rather than this gesture's. `settlesAsk` is why an approved
    // delete of `obj_1` does not delete `obj_2`: this asks again instead.
    const answered = answerApproval(
      raiseApproval({
        id: "appr_9" as ApprovalId,
        sessionId: A,
        workstreamId: W,
        ask: {
          kind: "destruction",
          trigger: "destruction",
          tool: "object_delete",
          summary: "object_delete on object obj_1",
          writeExtent: "none",
          paths: [],
          world: null,
          target: { kind: "object", id: "obj_1" },
        },
        at: 10,
      }),
      { decision: "approve-once", by: humanAuthor, at: 11 },
    );
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;

    const routing = decideDestruction(
      { tool: objectDelete(), targetId: "obj_2" },
      { ...context, approval: answered.value },
    );
    expect(routing.kind).toBe("destruction");
    if (routing.kind === "destruction") {
      expect(routing.verdict.kind).toBe("must-ask");
    }
  });

  it("returns the operator's reason to the session when denied", () => {
    const raised = raiseApproval({
      id: "appr_2" as ApprovalId,
      sessionId: A,
      workstreamId: W,
      ask: {
        kind: "destruction",
        trigger: "destruction",
        tool: "workstream_delete",
        summary: "workstream_delete on workstream ws-1",
        writeExtent: "none",
        paths: [],
        world: null,
        target: { kind: "workstream", id: "ws-1" },
      },
      at: 10,
    });
    const answered = answerApproval(raised, {
      decision: "deny",
      reason: "archive it instead; I still want the history",
      by: humanAuthor,
      at: 11,
    });
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;

    const tool = toolByName("workstream_delete");
    if (tool === undefined) throw new Error("workstream_delete is missing");
    const routing = decideDestruction(
      { tool, targetId: "ws-1" },
      { ...context, approval: answered.value },
    );
    expect(routing.kind).toBe("destruction");
    if (routing.kind === "destruction" && routing.verdict.kind === "denied") {
      expect(routing.verdict.reason).toContain("archive it instead");
    } else {
      expect.fail("a denied approval must deny the destruction");
    }
  });

  it("can be pre-granted, because every one of these has an inverse", () => {
    const preGrant: PreGrant = {
      id: "pregrant_del" as PreGrantId,
      scope: { kind: "workstream", workstreamId: W },
      effect: "allow",
      kinds: ["destruction"],
      toolPattern: "*_delete",
      extents: [...ALL_APPROVAL_EXTENTS],
      grantedBy: humanAuthor,
      grantedAt: 1,
      withdrawnAt: null,
    };
    const routing = decideDestruction(
      { tool: objectDelete(), targetId: "obj_1" },
      { ...context, preGrants: [preGrant] },
    );
    expect(routing.kind).toBe("destruction");
    if (routing.kind === "destruction" && routing.verdict.kind === "allowed") {
      expect(routing.verdict.by.kind).toBe("pre-grant");
    } else {
      expect.fail("a covering pre-grant lets a reversible destruction proceed");
    }
  });
});
