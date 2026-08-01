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
import { createPiWriteIntents } from "../adapters/pi/write-intents.js";
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

describe("pi write intents", () => {
  const intents = createPiWriteIntents();

  it("treats a shell as unbounded — it can write anything", () => {
    const intent = intents.intentOf("bash", { command: "echo hi" });
    expect(intent.kind).toBe("unbounded");
  });

  it("treats an undeclared tool as unbounded rather than as harmless", () => {
    expect(
      intents.intentOf("some_new_pi_tool", { path: "src/a.ts" }).kind,
    ).toBe("unbounded");
  });

  it("reads declared path fields, including lists", () => {
    const declared = createPiWriteIntents([
      { toolName: "write", extent: { kind: "paths", pathFields: ["path"] } },
      { toolName: "multi", extent: { kind: "paths", pathFields: ["paths"] } },
      { toolName: "grep", extent: { kind: "none" } },
    ]);
    expect(declared.intentOf("write", { path: "src/a.ts" })).toEqual({
      kind: "paths",
      paths: ["src/a.ts"],
    });
    expect(declared.intentOf("multi", { paths: ["a", "b"] })).toEqual({
      kind: "paths",
      paths: ["a", "b"],
    });
    expect(declared.intentOf("grep", { pattern: "x" }).kind).toBe("none");
  });

  it("falls back to unbounded when a declared path field is absent", () => {
    const declared = createPiWriteIntents([
      { toolName: "write", extent: { kind: "paths", pathFields: ["path"] } },
    ]);
    expect(declared.intentOf("write", { contents: "x" }).kind).toBe(
      "unbounded",
    );
    expect(declared.intentOf("write", null).kind).toBe("unbounded");
  });
});
