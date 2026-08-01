import { describe, expect, it } from "vitest";

import { humanAuthor, sessionAuthor } from "../author.js";
import { newSessionId } from "../ids.js";
import type { PriorRunCost } from "../runs.js";
import type { DivergenceReport } from "../workspaces/divergence.js";
import {
  checkWindowFit,
  compareContinueVsFresh,
  DEFAULT_CONTINUE_HEADROOM_FRACTION,
  dispositionOfTypedInput,
  planResume,
  type SessionContinuation,
} from "./continuation.js";
import { markDeleted } from "./deletion.js";
import { endSession } from "./session.js";
import { makeSession } from "./testing.js";

const ENDED = endSession(makeSession(), { kind: "completed", at: 5_000 });

const diverged: DivergenceReport = {
  diverged: true,
  changes: [
    {
      rootKey: "root",
      kind: "history-rewritten",
      // The rebase §4.3 is written about.
      detail: "the recorded head is no longer reachable (someone rebased).",
    },
  ],
  observedAt: 9_000,
};

const clean: DivergenceReport = {
  diverged: false,
  changes: [],
  observedAt: 9_000,
};

describe("typing is never an implicit continuation (§6.3)", () => {
  it("injects into a live session", () => {
    const disposition = dispositionOfTypedInput(makeSession());
    expect(disposition.kind).toBe("inject");
  });

  it("demands the explicit choice once the session has ended", () => {
    const disposition = dispositionOfTypedInput(ENDED);

    expect(disposition.kind).toBe("choice-required");
    if (disposition.kind !== "choice-required") return;
    expect(disposition.options).toEqual(["resume", "fork"]);
  });

  it("has no third disposition that continues something quietly", () => {
    // The union is exactly two variants, and a continuation value has to name
    // which verb it is — there is no default.
    // @ts-expect-error resume and fork are the only continuations (§6.3)
    const implicit: SessionContinuation = { kind: "continue" };
    expect(implicit).toBeDefined();
  });
});

describe("resume continues the same record (§6.3)", () => {
  it("carries the runtime binding, the launch choices, and who asked", () => {
    const resumed = planResume(ENDED, {
      resumedBy: humanAuthor,
      firstTurn: "the checks are green now",
      divergence: clean,
      at: 10_000,
    });

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.plan.sessionId).toBe(ENDED.id);
    expect(resumed.plan.runtime).toEqual(ENDED.runtime);
    expect(resumed.plan.launch).toEqual(ENDED.launch);
    expect(resumed.plan.resumedBy).toEqual(humanAuthor);
    expect(resumed.plan.firstTurn).toBe("the checks are green now");
  });

  it("records a session as the resumer when a session asked", () => {
    const peer = newSessionId();
    const resumed = planResume(ENDED, {
      resumedBy: sessionAuthor(peer),
      at: 10_000,
    });

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.plan.resumedBy).toEqual({
      kind: "session",
      sessionId: peer,
    });
  });

  it("refuses a session that never stopped: that is injection", () => {
    const resumed = planResume(makeSession(), {
      resumedBy: humanAuthor,
      at: 10_000,
    });

    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.refusal.reason).toBe("already_running");
  });

  it("refuses a deleted session rather than un-deleting it", () => {
    const resumed = planResume(
      { ...ENDED, deletion: markDeleted(ENDED.deletion, 6_000, humanAuthor) },
      { resumedBy: humanAuthor, at: 10_000 },
    );

    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.refusal.reason).toBe("deleted");
  });

  it("refuses when the workspace diverged, and says what changed", () => {
    const resumed = planResume(ENDED, {
      resumedBy: humanAuthor,
      divergence: diverged,
      at: 10_000,
    });

    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.refusal.reason).toBe("workspace_diverged");
    expect(resumed.refusal.message).toContain("rebased");
    expect(resumed.refusal.gate?.blocking).toHaveLength(1);
  });
});

describe("the window-fit gate (§4.3)", () => {
  it("needs headroom, not merely a fit", () => {
    const fits = checkWindowFit({
      combinedTokens: 100_000,
      windowTokens: 200_000,
    });
    expect(fits.fits).toBe(true);
    expect(fits.requiredHeadroomTokens).toBe(
      200_000 * DEFAULT_CONTINUE_HEADROOM_FRACTION,
    );

    const tight = checkWindowFit({
      combinedTokens: 170_000,
      windowTokens: 200_000,
    });
    expect(tight.fits).toBe(false);
    expect(tight.headroomTokens).toBe(30_000);
    expect(tight.description).toContain("headroom continuation needs");
  });

  it("scales the headroom with the window", () => {
    expect(
      checkWindowFit({ combinedTokens: 90_000, windowTokens: 100_000 }).fits,
    ).toBe(false);
    expect(
      checkWindowFit({
        combinedTokens: 90_000,
        windowTokens: 100_000,
        requiredHeadroomFraction: 0.05,
      }).fits,
    ).toBe(true);
  });
});

describe("continue or fresh, side by side (§4.3)", () => {
  const priorRuns: readonly PriorRunCost[] = [
    { costMicros: 120_000, inputTokens: 30_000, outputTokens: 2_000 },
    { costMicros: 250_000, inputTokens: 40_000, outputTokens: 3_000 },
  ];

  it("makes a live session the cheap path", () => {
    const comparison = compareContinueVsFresh({
      priorSession: {
        sessionId: newSessionId(),
        running: true,
        deleted: false,
        historyTokens: 90_000,
      },
      assemblyTokens: 40_000,
      changedSinceTokens: 2_000,
      windowTokens: 200_000,
      divergence: clean,
      priorRuns,
      defaultMode: "continue",
    });

    expect(comparison.continue.available).toBe(true);
    expect(comparison.continue.inputTokens).toBe(2_000);
    expect(comparison.comparison.cheaper).toBe("continue");
    expect(comparison.recommended).toBe("continue");
    expect(comparison.forcedFresh).toBe(false);
  });

  it("brings the whole history back for a completed one, which can cost more", () => {
    const comparison = compareContinueVsFresh({
      priorSession: {
        sessionId: newSessionId(),
        running: false,
        deleted: false,
        historyTokens: 90_000,
      },
      assemblyTokens: 40_000,
      changedSinceTokens: 2_000,
      windowTokens: 200_000,
      divergence: clean,
      priorRuns,
    });

    expect(comparison.continue.inputTokens).toBe(92_000);
    expect(comparison.fresh.inputTokens).toBe(40_000);
    expect(comparison.comparison.cheaper).toBe("fresh");
    expect(comparison.comparison.description).toContain(
      "starting over sends less",
    );
    // Both options are described, and both state the basis of their money
    // estimate rather than a bare number (§4.1).
    expect(comparison.continue.cost.basis).toBe("prior-runs");
    expect(comparison.fresh.cost.description).toContain(
      "based on 2 prior runs",
    );
    // The default is reported separately from what is recommended.
    expect(comparison.defaultMode).toBe("fresh");
  });

  it("says nothing about money when nothing was ever priced", () => {
    const comparison = compareContinueVsFresh({
      priorSession: {
        sessionId: newSessionId(),
        running: true,
        deleted: false,
        historyTokens: 10,
      },
      assemblyTokens: 40_000,
      changedSinceTokens: 2_000,
      windowTokens: 200_000,
      priorRuns: [],
    });

    expect(comparison.continue.cost.range).toBeNull();
    expect(comparison.fresh.cost.range).toBeNull();
    expect(comparison.continue.cost.basis).toBe("input-size-only");
  });

  it("forces fresh when the workspace diverged, whatever the default says", () => {
    const comparison = compareContinueVsFresh({
      priorSession: {
        sessionId: newSessionId(),
        running: true,
        deleted: false,
        historyTokens: 10_000,
      },
      assemblyTokens: 40_000,
      changedSinceTokens: 1_000,
      windowTokens: 200_000,
      divergence: diverged,
      priorRuns,
      defaultMode: "continue",
    });

    expect(comparison.forcedFresh).toBe(true);
    expect(comparison.recommended).toBe("fresh");
    expect(comparison.continue.available).toBe(false);
    expect(comparison.continue.blocks.map((block) => block.reason)).toEqual([
      "workspace_diverged",
    ]);
    // The refused option is still described: a preview that hides it cannot be
    // argued with.
    expect(comparison.continue.inputTokens).toBe(1_000);
    expect(comparison.fresh.available).toBe(true);
  });

  it("forces fresh when the combined content does not fit with headroom", () => {
    const comparison = compareContinueVsFresh({
      priorSession: {
        sessionId: newSessionId(),
        running: false,
        deleted: false,
        historyTokens: 175_000,
      },
      assemblyTokens: 40_000,
      changedSinceTokens: 1_000,
      windowTokens: 200_000,
      divergence: clean,
      priorRuns,
      defaultMode: "continue",
    });

    expect(comparison.forcedFresh).toBe(true);
    expect(comparison.continue.blocks.map((block) => block.reason)).toEqual([
      "window_too_small",
    ]);
    expect(comparison.windowFit.fits).toBe(false);
  });

  it("collects both gates rather than reporting only the first", () => {
    const comparison = compareContinueVsFresh({
      priorSession: {
        sessionId: newSessionId(),
        running: false,
        deleted: true,
        historyTokens: 190_000,
      },
      assemblyTokens: 40_000,
      changedSinceTokens: 1_000,
      windowTokens: 200_000,
      divergence: diverged,
      priorRuns,
    });

    expect(comparison.continue.blocks.map((block) => block.reason)).toEqual([
      "session_deleted",
      "workspace_diverged",
      "window_too_small",
    ]);
  });

  it("offers only fresh when the command has never run", () => {
    const comparison = compareContinueVsFresh({
      priorSession: null,
      assemblyTokens: 12_000,
      changedSinceTokens: 0,
      windowTokens: 200_000,
      priorRuns: [],
    });

    expect(comparison.forcedFresh).toBe(true);
    expect(comparison.continue.blocks[0]?.reason).toBe("no_prior_session");
    expect(comparison.continue.description).toBe("nothing to continue");
  });
});
