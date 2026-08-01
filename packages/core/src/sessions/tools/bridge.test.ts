import { describe, expect, it } from "vitest";

import type { SessionId } from "../../ids.js";
import type { LineageIndex } from "../../lineage.js";
import {
  ACTOR_HEADER_NAME,
  buildToolRequest,
  createSessionToolBridge,
  RESERVED_INPUT_KEYS,
  type ToolHttpRequest,
  type ToolHttpResponse,
} from "./bridge.js";

/**
 * The actor-integrity fix (the plan's Epic 4.5 carry-over): the bridge sets the
 * actor from the session it serves, and a session-supplied actor is refused.
 */

const SESSION = "sess_worker" as SessionId;
const OTHER = "sess_victim" as SessionId;

const lineage: LineageIndex = { parentOf: () => null };

function recorder(): {
  sent: ToolHttpRequest[];
  send: (r: ToolHttpRequest) => Promise<ToolHttpResponse>;
} {
  const sent: ToolHttpRequest[] = [];
  return {
    sent,
    send: async (request) => {
      sent.push(request);
      return { status: 200, body: { ok: true } };
    },
  };
}

describe("buildToolRequest", () => {
  it("sets the actor header from the binding, on every call", () => {
    const built = buildToolRequest(
      { sessionId: SESSION },
      { tool: "note_create", input: { title: "t", body: "b" } },
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request.headers[ACTOR_HEADER_NAME]).toBe(`session:${SESSION}`);
    expect(built.request.method).toBe("POST");
    expect(built.request.path).toBe("/api/notes");
    expect(built.request.body).toEqual({ title: "t", body: "b" });
  });

  it("refuses an input that tries to declare an actor, rather than stripping it", () => {
    for (const key of RESERVED_INPUT_KEYS) {
      const built = buildToolRequest(
        { sessionId: SESSION },
        {
          tool: "note_create",
          input: { title: "t", body: "b", [key]: `session:${OTHER}` },
        },
      );
      expect(built.ok, key).toBe(false);
      if (built.ok) return;
      expect(built.refusal.reason, key).toBe("actor_supplied_by_session");
    }
  });

  it("declares no actor field in any tool schema, so a well-behaved agent cannot try", () => {
    const built = buildToolRequest(
      { sessionId: SESSION },
      { tool: "note_create", input: { title: "t", body: "b", nonsense: 1 } },
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.refusal.reason).toBe("unknown_input");
  });

  it("substitutes path parameters and never sends a literal `:id`", () => {
    const built = buildToolRequest(
      { sessionId: SESSION },
      {
        tool: "command_parameter_confirm",
        input: { id: "cmd_1", name: "repo", value: "x" },
      },
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request.path).toBe(
      "/api/commands/cmd_1/parameters/repo/confirm",
    );
    expect(built.request.body).toEqual({ value: "x" });
  });

  it("refuses a call missing a required input, naming it", () => {
    const built = buildToolRequest(
      { sessionId: SESSION },
      { tool: "note_create", input: { title: "t" } },
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.refusal.reason).toBe("missing_input");
    expect(built.refusal.message).toContain("body");
  });

  it("puts a read's inputs in the query string and sends no body", () => {
    const built = buildToolRequest(
      { sessionId: SESSION },
      { tool: "graph_warnings_read", input: { workstreamId: "ws_1" } },
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request.query).toEqual({ workstreamId: "ws_1" });
    expect(built.request.body).toBeNull();
  });

  it("refuses a tool nobody declared", () => {
    const built = buildToolRequest(
      { sessionId: SESSION },
      { tool: "nope", input: {} },
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.refusal.reason).toBe("unknown_tool");
  });
});

describe("createSessionToolBridge", () => {
  it("sends the request with the session's own actor", async () => {
    const transport = recorder();
    const bridge = createSessionToolBridge({
      binding: { sessionId: SESSION, adapterId: "pi" },
      transport,
      lineage,
    });

    const outcome = await bridge.call({
      tool: "note_create",
      input: { title: "t", body: "b" },
    });
    expect(outcome.ok).toBe(true);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.headers[ACTOR_HEADER_NAME]).toBe(
      `session:${SESSION}`,
    );
  });

  it("never reaches the transport when a call is refused", async () => {
    const transport = recorder();
    const bridge = createSessionToolBridge({
      binding: { sessionId: SESSION },
      transport,
      lineage,
    });

    const spoofed = await bridge.call({
      tool: "note_create",
      input: { title: "t", body: "b", actor: "human" },
    });
    expect(spoofed.ok).toBe(false);

    const operatorOnly = await bridge.call({
      tool: "claim_force_release",
      input: { id: "claim_1" },
    });
    expect(operatorOnly.ok).toBe(false);
    if (operatorOnly.ok) return;
    expect(operatorOnly.refusal.reason).toBe("human_only");

    // A refused call has no chance of a side effect: nothing was sent at all.
    expect(transport.sent).toEqual([]);
  });

  it("checks reflexivity before building the request", async () => {
    const transport = recorder();
    const child = "sess_child" as SessionId;
    const bridge = createSessionToolBridge({
      binding: { sessionId: child },
      transport,
      lineage: { parentOf: () => null },
      targets: { sessionsAffected: () => [child] },
    });

    const outcome = await bridge.call({
      tool: "edge_wire",
      input: { from: "n1", to: "n2" },
      target: { kind: "command", id: "cmd_1" },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.reason).toBe("own_chain");
    expect(transport.sent).toEqual([]);
  });
});
