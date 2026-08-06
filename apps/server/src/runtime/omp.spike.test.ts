import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INHERIT_APP_TOOLS } from "@plotroom/core";
import {
  deriveSessionPhase,
  initialObservationState,
  reduceObservation,
} from "@plotroom/core";
import type {
  RuntimeObservation,
  RuntimeSessionHandle,
  SessionRuntimeAdapter,
} from "@plotroom/core";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { createOmpRuntime } from "./omp.js";

/**
 * The whole seam, for real: the session host this build ships, run by Bun, with
 * the agent SDK embedded and a live model behind it (issue #80's acceptance),
 * and — the coverage issue #83 names as the pin-bump's own proof — the
 * permission gate (#81), injection delivery and fork (#82) exercised against
 * the real SDK rather than a fake.
 *
 * Everything else about the sidecar is provable without a model — the translator
 * and the loop under `apps/session-host`, the frames and lifecycle in
 * `@plotroom/core`, spawning and stop modes in `omp.test.ts`. What only this can
 * show is that the pieces fit together against the SDK's real behaviour, which
 * is exactly what a dependency bump can silently change.
 *
 * Opt-in, because it needs Bun, credentials and money:
 *
 *     PLOTROOM_SESSION_HOST_SPIKE=1 pnpm --filter @plotroom/server test
 *
 * A scheduled CI job runs this on a timer and on every bump to
 * `@oh-my-pi/pi-coding-agent` (`.github/workflows/spike.yml`) — red here is
 * the SDK having moved under the adapter, not a flake to retry past.
 *
 * **The boot assertion is the `restrictToolNames` regression test.** Issue #66
 * found that `restrictToolNames: true` silently drops every inline extension —
 * no error, no warning. `main.ts`'s boot assertion (issue #81) checks the SDK's
 * own `extensionsResult` for the gate's exact handler and refuses to start
 * otherwise, so any test below that reaches a `request-raised` observation has
 * already proven the trap did not reopen; a second, separate test would only
 * repeat what every other test here already depends on.
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

/** A fresh workspace subdirectory, so concurrent-effect tests never collide. */
function workspace(name: string): string {
  return mkdtempSync(join(workdir, `${name}-`));
}

/** Drains observations until `predicate` matches one, returning the stream so far. */
async function drainUntil(
  handle: RuntimeSessionHandle,
  predicate: (observation: RuntimeObservation) => boolean,
  iterator: AsyncIterator<RuntimeObservation> = handle
    .observations()
    [Symbol.asyncIterator](),
): Promise<{
  readonly observations: readonly RuntimeObservation[];
  readonly iterator: AsyncIterator<RuntimeObservation>;
}> {
  const observations: RuntimeObservation[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done === true) break;
    observations.push(next.value);
    if (predicate(next.value)) break;
  }
  return { observations, iterator };
}

/**
 * `PLOTROOM_SESSION_HOST` points this at the `bun build --compile` binary
 * (issue #92) instead of `bun` + this build's `dist/main.js` — the CI spike
 * job runs the whole suite against it, because the compiled binary is what a
 * real installation ships and the inline gate extension (#81) is a typed
 * callback, not a legacy extension the compile step's own smoke test can
 * probe on its own.
 */
function spikeAdapter(): SessionRuntimeAdapter {
  return createOmpRuntime({
    stateDir: workdir,
    program: process.env.PLOTROOM_SESSION_HOST ?? null,
    ...(process.env.PLOTROOM_SESSION_HOST_BUN === undefined
      ? {}
      : { bunProgram: process.env.PLOTROOM_SESSION_HOST_BUN }),
  });
}

describe.skipIf(!ENABLED)("the session host, against the real SDK", () => {
  it("streams a real turn as observations the reducer accepts, with reported cost and context usage", async () => {
    const adapter = spikeAdapter();

    const handle = await adapter.start({
      prompt: "Reply with exactly the word READY, and nothing else.",
      launch: {
        model: MODEL,
        effort: "off",
        toolPermissions: INHERIT_APP_TOOLS,
      },
      workspacePath: workspace("turn"),
    });

    // The ref is the runtime's own session file, not a process identity: it is
    // what a resume is addressed by, so it must outlive the process.
    expect(handle.ref).toMatch(/\.jsonl$/);

    const { observations } = await drainUntil(
      handle,
      (observation) => observation.kind === "turn-ended",
    );

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
    // `reportsContextWindow: true` (issue #82) is the same kind of claim.
    expect(
      ended?.kind === "turn-ended" && ended.usage.contextWindow?.maxTokens,
    ).toBeGreaterThan(0);

    let state = initialObservationState(observations[0]?.at ?? 0);
    for (const observation of observations) {
      state = reduceObservation(state, observation);
    }
    expect(state.turnsCompleted).toBe(1);
    expect(state.accounting.costUsd).toBeGreaterThan(0);
    expect(state.accounting.contextWindow?.basis).toBe("reported");
    expect(deriveSessionPhase(state, { now: state.lastObservedAt }).kind).toBe(
      "waiting-input",
    );

    await handle.stop("graceful");
  }, 120_000);

  it("denies a gated tool call with no side effect, and the model sees an error (issue #81)", async () => {
    const adapter = spikeAdapter();
    const dir = workspace("deny");

    const handle = await adapter.start({
      prompt:
        "Run exactly this shell command using the bash tool and nothing else: touch marker.txt",
      launch: {
        model: MODEL,
        effort: "off",
        toolPermissions: INHERIT_APP_TOOLS,
      },
      workspacePath: dir,
    });

    const { observations, iterator } = await drainUntil(
      handle,
      (observation) => observation.kind === "request-raised",
    );
    const raised = observations.find(
      (observation) => observation.kind === "request-raised",
    );
    if (raised?.kind !== "request-raised") {
      throw new Error("the gate never raised a request");
    }
    expect(raised.request).toMatchObject({
      kind: "tool-permission",
      toolName: "bash",
    });

    await handle.respond(raised.requestId, {
      kind: "deny",
      reason: "spike: denied on purpose",
    });

    const { observations: rest } = await drainUntil(
      handle,
      (observation) => observation.kind === "tool-finished",
      iterator,
    );
    const finished = rest.find(
      (observation) => observation.kind === "tool-finished",
    );
    expect(finished?.kind === "tool-finished" && finished.isError).toBe(true);
    expect(existsSync(join(dir, "marker.txt"))).toBe(false);

    await handle.stop("abort");
  }, 120_000);

  it("gates a read-tier tool too, not only writes (issue #81)", async () => {
    const adapter = spikeAdapter();
    const dir = workspace("read-tier");
    writeFileSync(
      join(dir, "note.txt"),
      "the gate should still ask about this",
    );

    const handle = await adapter.start({
      prompt:
        "Use the read tool to read exactly the file note.txt, and nothing else.",
      launch: {
        model: MODEL,
        effort: "off",
        toolPermissions: INHERIT_APP_TOOLS,
      },
      workspacePath: dir,
    });

    // `read` has no write-intent at all (§3.4's write-intent is about what a
    // call *writes*), so a gate keyed on write-intent alone would let it
    // through ungated; this proves the gate wraps every `tool_call`, read or
    // write, which the deny test (on `bash`, always unbounded either way)
    // cannot distinguish on its own.
    const { observations } = await drainUntil(
      handle,
      (observation) => observation.kind === "request-raised",
    );
    const raised = observations.find(
      (observation) => observation.kind === "request-raised",
    );
    expect(raised?.kind === "request-raised" && raised.request).toMatchObject({
      kind: "tool-permission",
      toolName: "read",
    });

    await handle.stop("abort");
  }, 120_000);

  it("observes a mid-turn injection queued, then delivered (issue #82)", async () => {
    const adapter = spikeAdapter();
    const dir = workspace("steer");

    const handle = await adapter.start({
      prompt:
        "Run exactly this shell command using the bash tool and nothing else: sleep 5",
      launch: {
        model: MODEL,
        effort: "off",
        toolPermissions: INHERIT_APP_TOOLS,
      },
      workspacePath: dir,
    });

    // Allow the bash call so the turn is still running when the injection
    // lands — an idle session would deliver it immediately, which is a
    // different (also covered) path, not this one.
    const { iterator: afterGate, observations: untilRaised } = await drainUntil(
      handle,
      (observation) => observation.kind === "request-raised",
    );
    const raised = untilRaised.find(
      (observation) => observation.kind === "request-raised",
    );
    if (raised?.kind !== "request-raised") {
      throw new Error("the gate never raised a request");
    }
    await handle.respond(raised.requestId, { kind: "allow" });

    const receipt = await handle.inject({
      id: "spike-inj-1",
      text: "also say the word DONE",
    });
    expect(receipt.id).toBe("spike-inj-1");

    const { observations: rest } = await drainUntil(
      handle,
      (observation) =>
        observation.kind === "injection-delivered" &&
        observation.injectionId === "spike-inj-1",
      afterGate,
    );
    expect(
      rest.some((observation) => observation.kind === "injection-delivered"),
    ).toBe(true);

    await handle.stop("abort");
  }, 120_000);

  it("forks at a turn boundary and inherits exactly that prefix (issue #82)", async () => {
    const adapter = spikeAdapter();
    const dir = workspace("fork");

    const handle = await adapter.start({
      prompt: "Reply with exactly the word ONE, and nothing else.",
      launch: {
        model: MODEL,
        effort: "off",
        toolPermissions: INHERIT_APP_TOOLS,
      },
      workspacePath: dir,
    });
    await drainUntil(
      handle,
      (observation) => observation.kind === "turn-ended",
    );

    await handle.inject({
      id: "spike-fork-turn-2",
      text: "Now reply with exactly the word TWO, and nothing else.",
    });
    await drainUntil(
      handle,
      (observation) => observation.kind === "turn-ended",
    );
    await handle.stop("graceful");

    // `fork()` never runs a new turn of its own — it rewinds to the point and
    // stops, waiting for whatever prompts it next (§6.3) — so the prefix
    // claim is checked on the runtime's own transcript file, not the forked
    // handle's (empty, until something prompts it) observation stream.
    const forked = await adapter.fork(
      handle.ref,
      { turn: 1 },
      {
        prompt: "",
        launch: {
          model: MODEL,
          effort: "off",
          toolPermissions: INHERIT_APP_TOOLS,
        },
        workspacePath: dir,
      },
    );
    expect(forked.ref).not.toBe(handle.ref);

    const transcript = readFileSync(forked.ref, "utf8");
    await forked.stop("graceful");

    expect(transcript).toContain("ONE");
    expect(transcript).not.toContain("TWO");
  }, 60_000);

  it("kills a runaway child on abort, not just the turn (issue #71/#73)", async () => {
    const adapter = spikeAdapter();
    const dir = workspace("abort");
    const heartbeat = join(dir, "heartbeat");

    const handle = await adapter.start({
      prompt: `Run exactly this shell command using the bash tool and nothing else: for i in $(seq 1 60); do date +%s%N > ${heartbeat}; sleep 1; done`,
      launch: {
        model: MODEL,
        effort: "off",
        toolPermissions: INHERIT_APP_TOOLS,
      },
      workspacePath: dir,
    });

    const { observations: untilRaised } = await drainUntil(
      handle,
      (observation) => observation.kind === "request-raised",
    );
    const raised = untilRaised.find(
      (observation) => observation.kind === "request-raised",
    );
    if (raised?.kind !== "request-raised") {
      throw new Error("the gate never raised a request");
    }
    await handle.respond(raised.requestId, { kind: "allow" });

    // Let the loop actually start writing before pulling the plug.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await handle.stop("abort");

    const readHeartbeat = (): string => {
      try {
        return readFileSync(heartbeat, "utf8");
      } catch {
        return "";
      }
    };
    const atAbort = readHeartbeat();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const afterWait = readHeartbeat();

    // A killed process tree writes no more heartbeats; an orphaned one — the
    // failure this test exists to catch — keeps advancing after `stop`
    // resolved.
    expect(afterWait).toBe(atAbort);
  }, 60_000);
});
