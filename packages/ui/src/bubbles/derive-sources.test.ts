import { describe, expect, it } from "vitest";
import {
  EMPTY_INJECTIONS,
  humanAuthor,
  markDelivered,
  queueInjection,
  type NodeId,
  type SessionId,
  type Transcript,
} from "@plotroom/core";

import {
  deriveCommandBubbleSources,
  deriveInjectionBubbleSources,
  deriveSessionBubbleSources,
} from "./derive-sources.js";

const SESSION_ID = "session-1" as SessionId;

function transcript(turns: Transcript["turns"]): Transcript {
  return { sessionId: SESSION_ID, turns };
}

describe("deriveCommandBubbleSources", () => {
  it("shows the dispatched prompt for a command with assembled context", () => {
    const sources = deriveCommandBubbleSources([
      {
        nodeId: "cmd1",
        assembledContent: "fix the bug in auth.ts",
        updatedAt: 10,
      },
    ]);
    expect(sources).toEqual([
      {
        id: "cmd1:command-prompt",
        nodeId: "cmd1",
        kind: "command-prompt",
        text: "fix the bug in auth.ts",
        updatedAt: 10,
        wantsAttention: false,
      },
    ]);
  });

  it("a command with no assembled context yet produces no bubble", () => {
    const sources = deriveCommandBubbleSources([
      { nodeId: "cmd1", assembledContent: "   ", updatedAt: 10 },
    ]);
    expect(sources).toEqual([]);
  });
});

describe("deriveSessionBubbleSources", () => {
  it("shows the latest output/reasoning entry as what the session is saying", () => {
    const t = transcript([
      {
        ordinal: 1,
        startedAt: 5,
        entries: [
          { kind: "reasoning", text: "thinking..." },
          { kind: "output", text: "here is my answer" },
        ],
      },
    ]);
    const sources = deriveSessionBubbleSources({
      nodeId: "s1",
      transcript: t,
      phase: { kind: "responding" },
      now: 100,
    });
    expect(sources).toEqual([
      {
        id: "s1:session-output",
        nodeId: "s1",
        kind: "session-output",
        text: "here is my answer",
        updatedAt: 5,
        wantsAttention: false,
      },
    ]);
  });

  it("skips tool-call/result entries when finding the latest saying", () => {
    const t = transcript([
      {
        ordinal: 1,
        startedAt: 5,
        entries: [
          { kind: "output", text: "let me check" },
          {
            kind: "tool-call",
            callId: "c1",
            toolName: "grep",
            input: "TODO",
          },
        ],
      },
    ]);
    const sources = deriveSessionBubbleSources({
      nodeId: "s1",
      transcript: t,
      phase: { kind: "tool-running", toolName: "grep" },
      now: 100,
    });

    const saying = sources.find((s) => s.kind === "session-output");
    expect(saying?.text).toBe("let me check");
  });

  it("adds a distinct tool-in-flight bubble while a tool is running", () => {
    const sources = deriveSessionBubbleSources({
      nodeId: "s1",
      transcript: transcript([]),
      phase: { kind: "tool-running", toolName: "grep" },
      now: 100,
    });
    expect(sources).toEqual([
      {
        id: "s1:tool:grep",
        nodeId: "s1",
        kind: "tool-in-flight",
        text: "grep",
        updatedAt: 100,
        wantsAttention: false,
      },
    ]);
  });

  it("an empty, idle session produces no bubble at all", () => {
    const sources = deriveSessionBubbleSources({
      nodeId: "s1",
      transcript: transcript([]),
      phase: { kind: "idle" },
      now: 100,
    });
    expect(sources).toEqual([]);
  });
});

describe("deriveInjectionBubbleSources", () => {
  it("renders a queued injection distinctly from a delivered one", () => {
    let ledger = EMPTY_INJECTIONS;
    ledger = queueInjection(ledger, {
      id: "inj-1",
      sessionId: SESSION_ID,
      author: humanAuthor,
      nodeId: "node-1" as NodeId,
      text: "stop grepping, the answer is in the docs",
      queuedAt: 10,
    });
    ledger = queueInjection(ledger, {
      id: "inj-2",
      sessionId: SESSION_ID,
      author: humanAuthor,
      nodeId: "node-1" as NodeId,
      text: "delivered one",
      queuedAt: 5,
    });
    ledger = markDelivered(ledger, "inj-2", 20);

    const sources = deriveInjectionBubbleSources("s1", ledger);
    const queued = sources.find((s) => s.id === "s1:injection:inj-1");
    const delivered = sources.find((s) => s.id === "s1:injection:inj-2");

    expect(queued?.injectionStatus).toBe("queued");
    expect(delivered?.injectionStatus).toBe("delivered");
    expect(queued?.kind).toBe("injection");
  });

  it("an empty ledger produces no injection bubbles", () => {
    expect(deriveInjectionBubbleSources("s1", EMPTY_INJECTIONS)).toEqual([]);
  });
});
