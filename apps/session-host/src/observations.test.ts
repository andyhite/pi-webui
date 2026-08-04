import { describe, expect, it } from "bun:test";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";

import { createObservationTranslator } from "./observations.js";

/**
 * The translator reads a handful of fields per event. Constructing whole
 * provider-shaped messages would test the SDK's own types rather than the
 * mapping, so these are the fields under test and nothing else.
 */
function event(shape: unknown): AgentSessionEvent {
  const value = shape as AgentSessionEvent;
  return value;
}

const TURN_END = event({
  type: "turn_end",
  message: {
    role: "assistant",
    usage: {
      input: 120,
      output: 34,
      cacheRead: 4,
      cacheWrite: 2,
      cost: { total: 0.0031 },
    },
  },
  toolResults: [],
});

describe("the observation translator", () => {
  it("numbers turns itself, because the runtime does not", () => {
    const translator = createObservationTranslator();

    expect(translator.translate(event({ type: "turn_start" }), 1)).toEqual([
      { kind: "turn-started", turn: 1, at: 1 },
    ]);
    expect(translator.translate(TURN_END, 2)).toEqual([
      {
        kind: "turn-ended",
        turn: 1,
        usage: {
          inputTokens: 120,
          outputTokens: 34,
          cacheReadTokens: 4,
          cacheWriteTokens: 2,
          costUsd: 0.0031,
        },
        at: 2,
      },
    ]);
    expect(translator.translate(event({ type: "turn_start" }), 3)).toEqual([
      { kind: "turn-started", turn: 2, at: 3 },
    ]);
  });

  it("drops a turn end with no turn open", () => {
    // The reducer pairs ends to starts by ordinal; an unpaired end is an event
    // about a turn PlotRoom never saw begin.
    expect(createObservationTranslator().translate(TURN_END, 1)).toEqual([]);
  });

  it("separates thinking from speaking", () => {
    const translator = createObservationTranslator();

    expect(
      translator.translate(
        event({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: {
            type: "thinking_delta",
            contentIndex: 0,
            delta: "hmm",
          },
        }),
        1,
      ),
    ).toEqual([{ kind: "reasoning-delta", text: "hmm", at: 1 }]);

    expect(
      translator.translate(
        event({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "on it",
          },
        }),
        2,
      ),
    ).toEqual([{ kind: "output-delta", text: "on it", at: 2 }]);

    // Every other delta kind is the runtime's own streaming bookkeeping.
    expect(
      translator.translate(
        event({
          type: "message_update",
          message: { role: "assistant" },
          assistantMessageEvent: { type: "text_start", contentIndex: 0 },
        }),
        3,
      ),
    ).toEqual([]);
  });

  it("reports a tool call as started and finished, by call id", () => {
    const translator = createObservationTranslator();

    expect(
      translator.translate(
        event({
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "bash",
          args: { command: "ls" },
        }),
        1,
      ),
    ).toEqual([
      {
        kind: "tool-started",
        toolName: "bash",
        callId: "call-1",
        input: { command: "ls" },
        at: 1,
      },
    ]);

    expect(
      translator.translate(
        event({
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "bash",
          result: "a\nb",
          isError: true,
        }),
        2,
      ),
    ).toEqual([
      {
        kind: "tool-finished",
        callId: "call-1",
        output: "a\nb",
        isError: true,
        at: 2,
      },
    ]);
  });

  it("passes compaction through as its own two facts", () => {
    const translator = createObservationTranslator();

    expect(
      translator.translate(
        event({
          type: "auto_compaction_start",
          reason: "threshold",
          action: "context-full",
        }),
        1,
      ),
    ).toEqual([{ kind: "compaction-started", at: 1 }]);
    expect(
      translator.translate(
        event({
          type: "auto_compaction_end",
          action: "context-full",
          result: undefined,
          aborted: false,
          willRetry: false,
        }),
        2,
      ),
    ).toEqual([{ kind: "compaction-finished", at: 2 }]);
  });

  it("reports an error notice without ending the session", () => {
    const translator = createObservationTranslator();

    expect(
      translator.translate(
        event({
          type: "notice",
          level: "error",
          message: "provider returned 429",
          source: "anthropic",
        }),
        1,
      ),
    ).toEqual([
      {
        kind: "runtime-error",
        message: "anthropic: provider returned 429",
        fatal: false,
        at: 1,
      },
    ]);

    expect(
      translator.translate(
        event({ type: "notice", level: "info", message: "using cache" }),
        2,
      ),
    ).toEqual([]);
  });

  it("does not read a settled agent as a session that ended", () => {
    // `agent_end.isTerminal === false` means async delivery will resume the
    // session; PlotRoom's session ends when the process does, and nowhere else
    // (§3.6).
    expect(
      createObservationTranslator().translate(
        event({ type: "agent_end", messages: [], isTerminal: false }),
        1,
      ),
    ).toEqual([]);
    expect(
      createObservationTranslator().translate(
        event({ type: "agent_end", messages: [], isTerminal: true }),
        1,
      ),
    ).toEqual([]);
  });
});
