import { describe, expect, it } from "vitest";

import {
  contextWindowLevel,
  secondsSinceLastActivity,
  totalTokens,
} from "./accounting.js";
import {
  DEFAULT_SILENCE_TIMEOUT_MS,
  deriveSessionHealth,
  deriveSessionPhase,
  deriveSessionStatus,
  initialObservationState,
  phaseFacts,
  reduceObservation,
  type SessionObservationState,
} from "./phases.js";
import type { RuntimeObservation } from "./runtime.js";

const T0 = 1_700_000_000_000;

function replay(
  observations: readonly RuntimeObservation[],
  startedAt = T0,
): SessionObservationState {
  return observations.reduce(
    (state, observation) => reduceObservation(state, observation),
    initialObservationState(startedAt),
  );
}

describe("phase derivation (§3.6, principle 7)", () => {
  it("starts idle, before anything has been observed", () => {
    const state = initialObservationState(T0);

    expect(deriveSessionPhase(state, { now: T0 })).toEqual({ kind: "idle" });
  });

  it("derives thinking, responding, tool-running and compacting from the stream", () => {
    const turnStart: RuntimeObservation = {
      kind: "turn-started",
      turn: 1,
      at: T0,
    };

    expect(deriveSessionPhase(replay([turnStart]), { now: T0 })).toEqual({
      kind: "thinking",
    });

    expect(
      deriveSessionPhase(
        replay([
          turnStart,
          { kind: "reasoning-delta", text: "hmm", at: T0 + 1 },
        ]),
        { now: T0 + 1 },
      ),
    ).toEqual({ kind: "thinking" });

    expect(
      deriveSessionPhase(
        replay([turnStart, { kind: "output-delta", text: "hi", at: T0 + 2 }]),
        { now: T0 + 2 },
      ),
    ).toEqual({ kind: "responding" });

    expect(
      deriveSessionPhase(
        replay([
          turnStart,
          {
            kind: "tool-started",
            toolName: "bash",
            callId: "c1",
            input: {},
            at: T0 + 3,
          },
        ]),
        { now: T0 + 3 },
      ),
    ).toEqual({ kind: "tool-running", toolName: "bash" });

    expect(
      deriveSessionPhase(
        replay([turnStart, { kind: "compaction-started", at: T0 + 4 }]),
        { now: T0 + 4 },
      ),
    ).toEqual({ kind: "compacting" });
  });

  it("returns to a streaming phase when a tool finishes", () => {
    const state = replay([
      { kind: "turn-started", turn: 1, at: T0 },
      {
        kind: "tool-started",
        toolName: "bash",
        callId: "c1",
        input: {},
        at: T0 + 1,
      },
      {
        kind: "tool-finished",
        callId: "c1",
        output: "ok",
        isError: false,
        at: T0 + 2,
      },
    ]);

    expect(deriveSessionPhase(state, { now: T0 + 3 })).toEqual({
      kind: "thinking",
    });
  });

  it("waits on an approval the runtime raised (§6.6)", () => {
    const state = replay([
      { kind: "turn-started", turn: 1, at: T0 },
      {
        kind: "request-raised",
        requestId: "r1",
        request: { kind: "tool-permission", toolName: "bash", input: {} },
        at: T0 + 1,
      },
    ]);

    expect(deriveSessionPhase(state, { now: T0 + 2 })).toEqual({
      kind: "waiting-approval",
    });

    const settled = reduceObservation(state, {
      kind: "request-settled",
      requestId: "r1",
      outcome: { kind: "allow" },
      at: T0 + 3,
    });
    expect(deriveSessionPhase(settled, { now: T0 + 4 })).toEqual({
      kind: "thinking",
    });
  });

  it("joins in PlotRoom's own approval and claim state", () => {
    const state = replay([{ kind: "turn-started", turn: 1, at: T0 }]);

    expect(
      deriveSessionPhase(state, { now: T0, pendingApproval: true }),
    ).toEqual({ kind: "waiting-approval" });
    expect(
      deriveSessionPhase(state, {
        now: T0,
        pendingApproval: true,
        waitingOnClaim: true,
      }),
    ).toEqual({ kind: "waiting-on-claim" });
  });

  it("waits for input between turns, once the session has spoken", () => {
    const state = replay([
      { kind: "turn-started", turn: 1, at: T0 },
      {
        kind: "turn-ended",
        turn: 1,
        usage: { inputTokens: 10, outputTokens: 5 },
        at: T0 + 10,
      },
    ]);

    expect(deriveSessionPhase(state, { now: T0 + 11 })).toEqual({
      kind: "waiting-input",
    });
  });

  it("maps end reasons onto phases without inventing one", () => {
    const ended = (reason: RuntimeObservation) =>
      deriveSessionPhase(replay([reason]), { now: T0 + 1 });

    expect(
      ended({ kind: "session-ended", reason: { kind: "completed" }, at: T0 }),
    ).toEqual({ kind: "idle" });
    expect(
      ended({
        kind: "session-ended",
        reason: { kind: "failed", message: "boom" },
        at: T0,
      }),
    ).toEqual({ kind: "failed" });
    expect(
      ended({
        kind: "session-ended",
        reason: { kind: "stopped", by: "user" },
        at: T0,
      }),
    ).toEqual({ kind: "stopped" });
    expect(
      ended({
        kind: "session-ended",
        reason: { kind: "interrupted", message: "restart" },
        at: T0,
      }),
    ).toEqual({ kind: "idle" });
  });

  it("keeps the first end reason when the stream repeats itself", () => {
    const state = replay([
      {
        kind: "session-ended",
        reason: { kind: "stopped", by: "user" },
        at: T0,
      },
      {
        kind: "session-ended",
        reason: { kind: "failed", message: "late" },
        at: T0 + 1,
      },
    ]);

    expect(state.ended).toEqual({ kind: "stopped", by: "user" });
  });

  it("fails on a fatal runtime error", () => {
    const state = replay([
      { kind: "turn-started", turn: 1, at: T0 },
      {
        kind: "runtime-error",
        message: "adapter died",
        fatal: true,
        at: T0 + 1,
      },
    ]);

    expect(deriveSessionPhase(state, { now: T0 + 2 })).toEqual({
      kind: "failed",
    });
  });

  it("says whether each phase is busy and whether it wants attention", () => {
    expect(phaseFacts({ kind: "tool-running", toolName: "bash" })).toEqual({
      busy: true,
      wantsAttention: false,
    });
    expect(phaseFacts({ kind: "waiting-approval" })).toEqual({
      busy: false,
      wantsAttention: true,
    });
    expect(phaseFacts({ kind: "idle" })).toEqual({
      busy: false,
      wantsAttention: false,
    });
  });
});

describe("the silence timeout", () => {
  const busy = replay([
    { kind: "turn-started", turn: 1, at: T0 },
    {
      kind: "tool-started",
      toolName: "bash",
      callId: "c1",
      input: {},
      at: T0 + 1,
    },
  ]);

  it("reports silence as health, never as a phase", () => {
    // The last observation was at T0 + 1, so this is a whole timeout of
    // silence and then some.
    const now = T0 + DEFAULT_SILENCE_TIMEOUT_MS + 1_000;
    const status = deriveSessionStatus(busy, { now });

    // The last thing observed was a tool starting; claiming anything else
    // would be inference, not observation (principle 7).
    expect(status.phase).toEqual({ kind: "tool-running", toolName: "bash" });
    expect(status.health.possiblyStalled).toBe(true);
    expect(status.health.silentForMs).toBeGreaterThan(
      DEFAULT_SILENCE_TIMEOUT_MS,
    );
  });

  it("stays quiet inside the timeout", () => {
    const health = deriveSessionHealth(busy, { now: T0 + 1_000 });

    expect(health.possiblyStalled).toBe(false);
  });

  it("respects a configured timeout", () => {
    const health = deriveSessionHealth(busy, {
      now: T0 + 2_000,
      silenceTimeoutMs: 1_000,
    });

    expect(health.possiblyStalled).toBe(true);
  });

  it("never calls an ended session stalled", () => {
    const ended = reduceObservation(busy, {
      kind: "session-ended",
      reason: { kind: "stopped", by: "user" },
      at: T0 + 2,
    });

    expect(
      deriveSessionHealth(ended, { now: T0 + 10_000_000 }).possiblyStalled,
    ).toBe(false);
  });
});

describe("accounting folded from the same log (§3.6)", () => {
  it("counts turns, tokens, cost and last activity", () => {
    const state = replay([
      { kind: "turn-started", turn: 1, at: T0 },
      {
        kind: "turn-ended",
        turn: 1,
        usage: {
          inputTokens: 1_000,
          outputTokens: 200,
          cacheReadTokens: 50,
          costUsd: 0.02,
        },
        at: T0 + 5_000,
      },
    ]);

    expect(state.accounting.turns).toBe(1);
    expect(totalTokens(state.accounting.tokens)).toBe(1_250);
    expect(state.accounting.costUsd).toBeCloseTo(0.02);
    expect(state.accounting.costBasis).toBe("runtime-reported");
    expect(
      secondsSinceLastActivity(state.accounting, Math.floor(T0 / 1000) + 10),
    ).toBe(5);
  });

  it("prices tokens itself when the runtime reports no cost", () => {
    const state = reduceObservation(
      initialObservationState(T0),
      {
        kind: "turn-ended",
        turn: 1,
        usage: { inputTokens: 1_000_000, outputTokens: 0 },
        at: T0,
      },
      {
        pricing: {
          inputPerMillionUsd: 3,
          outputPerMillionUsd: 15,
          cacheReadPerMillionUsd: 0.3,
          cacheWritePerMillionUsd: 3.75,
        },
      },
    );

    expect(state.accounting.costUsd).toBeCloseTo(3);
    expect(state.accounting.costBasis).toBe("priced-from-tokens");
  });

  it("meters the context window, reported or estimated, and says which", () => {
    const reported = reduceObservation(initialObservationState(T0), {
      kind: "turn-ended",
      turn: 1,
      usage: {
        inputTokens: 10,
        outputTokens: 10,
        contextWindow: { usedTokens: 190_000, maxTokens: 200_000 },
      },
      at: T0,
    });

    expect(reported.accounting.contextWindow).toMatchObject({
      basis: "reported",
    });
    expect(
      contextWindowLevel(reported.accounting.contextWindow ?? never()),
    ).toBe("critical");

    const estimated = reduceObservation(
      initialObservationState(T0),
      {
        kind: "turn-ended",
        turn: 1,
        usage: { inputTokens: 80_000, outputTokens: 1_000 },
        at: T0,
      },
      { contextWindowTokens: 100_000 },
    );

    expect(estimated.accounting.contextWindow).toMatchObject({
      basis: "estimated",
      usedTokens: 81_000,
    });
    expect(
      contextWindowLevel(estimated.accounting.contextWindow ?? never()),
    ).toBe("warning");
  });
});

function never(): never {
  throw new Error("expected a context-window meter");
}
