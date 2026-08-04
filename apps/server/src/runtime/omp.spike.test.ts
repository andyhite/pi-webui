import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INHERIT_APP_TOOLS } from "@plotroom/core";
import {
  deriveSessionPhase,
  initialObservationState,
  reduceObservation,
} from "@plotroom/core";
import type { RuntimeObservation } from "@plotroom/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createOmpRuntime } from "./omp.js";

/**
 * The whole seam, for real: the session host this build ships, run by Bun, with
 * the agent SDK embedded and a live model behind it (issue #80's acceptance).
 *
 * Everything else about the sidecar is provable without a model — the translator
 * and the loop under `apps/session-host`, the frames and lifecycle in
 * `@plotroom/core`, spawning and stop modes in `omp.test.ts`. What only this can
 * show is that the three fit together: that a real `AgentSessionEvent` stream
 * becomes observations the phase reducer accepts unchanged, and that a real turn
 * reports what accounting needs.
 *
 * Opt-in, because it needs Bun, credentials and money:
 *
 *     PLOTROOM_SESSION_HOST_SPIKE=1 pnpm --filter @plotroom/server test
 *
 * The pin-bump spike suite (issue #83) is where this becomes a scheduled CI job.
 */
const ENABLED = process.env.PLOTROOM_SESSION_HOST_SPIKE === "1";
const MODEL = process.env.PLOTROOM_SPIKE_MODEL ?? "anthropic/claude-haiku-4-5";

let workdir = "";

beforeAll(() => {
  if (!ENABLED) return;
  workdir = mkdtempSync(join(tmpdir(), "plotroom-session-host-spike-"));
});

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

describe.skipIf(!ENABLED)("the session host, against the real SDK", () => {
  it("streams a real turn as observations the reducer accepts", async () => {
    const adapter = createOmpRuntime({
      stateDir: workdir,
      ...(process.env.PLOTROOM_SESSION_HOST_BUN === undefined
        ? {}
        : { bunProgram: process.env.PLOTROOM_SESSION_HOST_BUN }),
    });

    const handle = await adapter.start({
      prompt: "Reply with exactly the word READY, and nothing else.",
      launch: {
        model: MODEL,
        effort: "off",
        toolPermissions: INHERIT_APP_TOOLS,
      },
      workspacePath: workdir,
    });

    // The ref is the runtime's own session file, not a process identity: it is
    // what a resume is addressed by, so it must outlive the process.
    expect(handle.ref).toMatch(/\.jsonl$/);

    const observations: RuntimeObservation[] = [];
    const iterator = handle.observations()[Symbol.asyncIterator]();
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      observations.push(next.value);
      // One turn is the whole experiment; the model has no reason to take
      // another, and waiting for the stream to end on its own would mean waiting
      // for a session nobody stopped.
      if (next.value.kind === "turn-ended") break;
    }

    const kinds = observations.map((observation) => observation.kind);
    expect(kinds).toContain("turn-started");
    expect(kinds).toContain("output-delta");
    expect(kinds).toContain("turn-ended");

    const ended = observations.find(
      (observation) => observation.kind === "turn-ended",
    );
    expect(
      ended?.kind === "turn-ended" && ended.usage.inputTokens,
    ).toBeGreaterThan(0);
    // `reportsCost: true` is a claim about the runtime; this is the check.
    expect(ended?.kind === "turn-ended" && ended.usage.costUsd).toBeGreaterThan(
      0,
    );

    let state = initialObservationState(observations[0]?.at ?? 0);
    for (const observation of observations) {
      state = reduceObservation(state, observation);
    }
    expect(state.turnsCompleted).toBe(1);
    expect(state.accounting.costUsd).toBeGreaterThan(0);
    expect(deriveSessionPhase(state, { now: state.lastObservedAt }).kind).toBe(
      "waiting-input",
    );

    await handle.stop("graceful");
  }, 120_000);
});
