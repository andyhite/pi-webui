import { describe, expect, it } from "vitest";

import { sessionTimeline } from "./session-timeline.js";
import type { RuntimeObservation } from "./sessions/runtime.js";

/**
 * The session timeline (§8): "where the time and money went ... including for
 * finished sessions."
 *
 * Every assertion is about honesty over completeness: an unfinished turn is
 * reported as unfinished, a session that priced nothing prices nothing, and a call
 * observed outside a turn is not assigned to one.
 */
const at = (ms: number) => ms as unknown as RuntimeObservation["at"];

describe("sessionTimeline", () => {
  it("folds turns with the tool calls that ran inside them", () => {
    const timeline = sessionTimeline([
      { kind: "turn-started", turn: 1, at: at(1_000) },
      {
        kind: "tool-started",
        toolName: "read_file",
        callId: "c1",
        input: {},
        at: at(1_100),
      },
      {
        kind: "tool-finished",
        callId: "c1",
        output: "ok",
        isError: false,
        at: at(1_600),
      },
      {
        kind: "turn-ended",
        turn: 1,
        usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.5 },
        at: at(2_000),
      },
      { kind: "turn-started", turn: 2, at: at(3_000) },
      {
        kind: "turn-ended",
        turn: 2,
        usage: { inputTokens: 5, outputTokens: 1, costUsd: 0.25 },
        at: at(3_500),
      },
      { kind: "session-ended", reason: { kind: "completed" }, at: at(4_000) },
    ]);

    expect(timeline.turns).toHaveLength(2);
    expect(timeline.turns[0]?.elapsedMillis).toBe(1_000);
    expect(timeline.turns[0]?.toolCalls).toHaveLength(1);
    expect(timeline.turns[0]?.toolCalls[0]?.elapsedMillis).toBe(500);
    expect(timeline.turns[0]?.toolCalls[0]?.failed).toBe(false);
    // Busy is time inside turns; the second between them is idle, which is what
    // makes "where the time went" answerable rather than just "how long".
    expect(timeline.busyMillis).toBe(1_500);
    expect(timeline.idleMillis).toBe(1_000);
    expect(timeline.costUsd).toBe(0.75);
    expect(timeline.endedAt).toBe(4_000);
  });

  it("reports a turn a crash caught mid-flight as unfinished (principle 11)", () => {
    const timeline = sessionTimeline([
      { kind: "turn-started", turn: 1, at: at(1_000) },
      {
        kind: "tool-started",
        toolName: "write_file",
        callId: "c1",
        input: {},
        at: at(1_100),
      },
    ]);

    expect(timeline.turns[0]?.endedAt).toBeNull();
    expect(timeline.turns[0]?.elapsedMillis).toBeNull();
    expect(timeline.toolCalls[0]?.endedAt).toBeNull();
    // Not closed at the moment somebody happened to read it.
    expect(timeline.endedAt).toBeNull();
  });

  it("prices nothing when no turn reported a cost (§4.1's rule about money)", () => {
    const timeline = sessionTimeline([
      { kind: "turn-started", turn: 1, at: at(1_000) },
      {
        kind: "turn-ended",
        turn: 1,
        usage: { inputTokens: 10, outputTokens: 4 },
        at: at(2_000),
      },
    ]);

    // Null, not zero: zero reads as free.
    expect(timeline.costUsd).toBeNull();
  });

  it("keeps a call observed outside any turn out of every turn", () => {
    const timeline = sessionTimeline([
      {
        kind: "tool-started",
        toolName: "read_file",
        callId: "c1",
        input: {},
        at: at(500),
      },
      { kind: "turn-started", turn: 1, at: at(1_000) },
    ]);

    expect(timeline.toolCalls).toHaveLength(1);
    expect(timeline.turns[0]?.toolCalls).toEqual([]);
  });
});
