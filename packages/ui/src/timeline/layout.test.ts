import { describe, expect, it } from "vitest";
import type { RuntimeObservation } from "@plotroom/core";

import { buildTimelineLayout } from "./layout.js";

function turnStarted(turn: number, at: number): RuntimeObservation {
  return { kind: "turn-started", turn, at };
}
function turnEnded(turn: number, at: number): RuntimeObservation {
  return {
    kind: "turn-ended",
    turn,
    at,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}
function toolStarted(
  callId: string,
  toolName: string,
  at: number,
): RuntimeObservation {
  return { kind: "tool-started", callId, toolName, input: {}, at };
}
function toolFinished(
  callId: string,
  at: number,
  isError = false,
): RuntimeObservation {
  return { kind: "tool-finished", callId, output: {}, isError, at };
}

describe("buildTimelineLayout", () => {
  it("is empty for no observations", () => {
    expect(buildTimelineLayout([])).toEqual({
      startAt: 0,
      endAt: 0,
      segments: [],
    });
  });

  it("lays out a turn as a fraction of the whole span", () => {
    const layout = buildTimelineLayout([
      turnStarted(1, 0),
      turnEnded(1, 1_000),
    ]);
    expect(layout.startAt).toBe(0);
    expect(layout.endAt).toBe(1_000);
    expect(layout.segments).toEqual([
      {
        kind: "turn",
        id: "1",
        label: "turn 1",
        startAt: 0,
        endAt: 1_000,
        startFraction: 0,
        endFraction: 1,
        isError: false,
      },
    ]);
  });

  it("nests a tool call's fraction inside its enclosing turn's", () => {
    const layout = buildTimelineLayout([
      turnStarted(1, 0),
      toolStarted("call-1", "grep", 250),
      toolFinished("call-1", 750),
      turnEnded(1, 1_000),
    ]);
    const tool = layout.segments.find((s) => s.id === "call-1");
    expect(tool?.startFraction).toBe(0.25);
    expect(tool?.endFraction).toBe(0.75);
    expect(tool?.label).toBe("grep");
  });

  it("reports an unterminated tool call as a zero-width point, never a guess", () => {
    const layout = buildTimelineLayout([
      turnStarted(1, 0),
      toolStarted("call-1", "grep", 500),
      turnEnded(1, 1_000),
    ]);
    const tool = layout.segments.find((s) => s.id === "call-1");
    expect(tool?.endAt).toBeNull();
    expect(tool?.startFraction).toBe(tool?.endFraction);
  });

  it("carries isError through from tool-finished", () => {
    const layout = buildTimelineLayout([
      toolStarted("call-1", "run-tests", 0),
      toolFinished("call-1", 100, true),
    ]);
    expect(layout.segments[0]?.isError).toBe(true);
  });

  it("orders multiple segments by their own start time", () => {
    const layout = buildTimelineLayout([
      turnStarted(1, 0),
      toolStarted("call-1", "a", 100),
      toolFinished("call-1", 200),
      toolStarted("call-2", "b", 50),
      toolFinished("call-2", 90),
      turnEnded(1, 1_000),
    ]);
    expect(layout.segments.map((s) => s.id)).toEqual(["1", "call-2", "call-1"]);
  });
});
