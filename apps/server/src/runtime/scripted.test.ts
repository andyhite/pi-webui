import { expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "bun:test";
import {
  INHERIT_APP_TOOLS,
  type RuntimeObservation,
  type RuntimeRequestId,
  type RuntimeSessionHandle,
  type RuntimeStartConfig,
} from "@plotroom/core";
import {
  createScriptedRuntime,
  runtimeScriptSchema,
  SCRIPTED_MAX_DELAY_MS,
  type RuntimeScript,
} from "./scripted.js";

/**
 * The scripted runtime's own contract (decision 0001's second adapter).
 *
 * What matters here is pacing. Everything downstream of the seam reads the same
 * observations off the same stream whether or not a script pauses — so a delay
 * cannot be tested by its effect on the product, only by when the stream hands
 * each observation over.
 */
let workspacePath: string;

beforeEach(() => {
  workspacePath = mkdtempSync(join(tmpdir(), "plotroom-scripted-"));
});

afterEach(() => {
  rmSync(workspacePath, { recursive: true, force: true });
});

function config(): RuntimeStartConfig {
  return {
    prompt: "do the thing",
    launch: {
      model: "fixture-model",
      effort: "medium",
      toolPermissions: INHERIT_APP_TOOLS,
    },
    workspacePath,
  };
}

function start(script: RuntimeScript) {
  const adapter = createScriptedRuntime({ now: () => Date.now() });
  return adapter.startWithScript(script, config());
}

/** The id of the next request this session raises and waits on. */
async function nextRequestId(
  handle: RuntimeSessionHandle,
): Promise<RuntimeRequestId> {
  for await (const observation of handle.observations()) {
    if (observation.kind === "request-raised") return observation.requestId;
  }
  throw new Error("the session ended without raising a request");
}

/** Read the stream, stamping when each observation actually arrived. */
async function drain(
  observations: AsyncIterable<RuntimeObservation>,
  take: number,
): Promise<{ kind: string; elapsed: number }[]> {
  const startedAt = Date.now();
  const seen: { kind: string; elapsed: number }[] = [];

  for await (const observation of observations) {
    seen.push({ kind: observation.kind, elapsed: Date.now() - startedAt });
    if (seen.length === take) break;
  }

  return seen;
}

describe("a scripted delay paces the stream (Epic 4.1's test double)", () => {
  it("holds the rest of the act back for real time", async () => {
    const handle = await start({
      acts: [
        {
          on: "start",
          steps: [
            { observation: { kind: "turn-started", turn: 1 } },
            { delay: { ms: 60 } },
            { observation: { kind: "output-delta", text: "thinking" } },
            {
              observation: {
                kind: "turn-ended",
                turn: 1,
                usage: { inputTokens: 1, outputTokens: 1 },
              },
            },
          ],
        },
      ],
    });

    const seen = await drain(handle.observations(), 3);

    expect(seen.map((entry) => entry.kind)).toEqual([
      "turn-started",
      "output-delta",
      "turn-ended",
    ]);
    // The turn opens promptly and the rest arrives after the pause, which is
    // what lets a client observe a turn *in flight* rather than finding a
    // finished one and calling that streaming.
    expect(seen[0]?.elapsed).toBeLessThan(50);
    expect(seen[1]?.elapsed).toBeGreaterThanOrEqual(50);
  });

  it("keeps acts in order when an injection arrives mid-pause", async () => {
    const handle = await start({
      acts: [
        {
          on: "start",
          steps: [
            { observation: { kind: "turn-started", turn: 1 } },
            { delay: { ms: 40 } },
            { observation: { kind: "output-delta", text: "still going" } },
          ],
        },
        {
          on: "injection",
          steps: [{ observation: { kind: "turn-started", turn: 2 } }],
        },
      ],
    });

    // Injected while the first act is still paused.
    await handle.inject({ id: "inj-1", text: "look at this" });

    const seen = await drain(handle.observations(), 4);

    // The paused act finishes before the act the injection triggers: a script's
    // meaning must not depend on how long its pauses are.
    expect(seen.map((entry) => entry.kind)).toEqual([
      "turn-started",
      "injection-delivered",
      "output-delta",
      "turn-started",
    ]);
  });

  it("abandons the rest of a paused act when the session is stopped", async () => {
    const handle = await start({
      acts: [
        {
          on: "start",
          steps: [
            { observation: { kind: "turn-started", turn: 1 } },
            { delay: { ms: 5_000 } },
            { observation: { kind: "output-delta", text: "never said" } },
          ],
        },
      ],
    });

    const first = await drain(handle.observations(), 1);
    expect(first.map((entry) => entry.kind)).toEqual(["turn-started"]);

    await handle.stop("abort");

    // The stream ends at the stop, and nothing the script would have said next
    // is recorded: it never happened.
    const rest: string[] = [];
    for await (const observation of handle.observations()) {
      rest.push(observation.kind);
    }
    expect(rest).toEqual(["session-ended"]);
  });
});

describe("a raised request is identified uniquely (§6.4, §6.6)", () => {
  const asks: RuntimeScript = {
    acts: [
      {
        on: "start",
        steps: [{ ask: { text: "ship it?", options: ["yes", "no"] } }],
      },
    ],
  };

  it("never mints an id another session could mint", async () => {
    const adapter = createScriptedRuntime({ now: () => Date.now() });
    const one = await adapter.startWithScript(asks, config());
    const two = await adapter.startWithScript(asks, config());

    // A question is found by its request id across sessions
    // (`QuestionStore#forRequest`), which is what makes answering settle *that*
    // blocked call. Two sessions sharing one id means one session's answer
    // settles the other's call.
    expect(await nextRequestId(one)).not.toBe(await nextRequestId(two));

    // The same holds for two adapters in one process, which is what a test that
    // boots two servers has.
    const three = await start(asks);
    const four = await start(asks);
    expect(await nextRequestId(three)).not.toBe(await nextRequestId(four));
  });

  it("never reuses the id of a request it has already settled", async () => {
    const handle = await start({
      acts: [
        {
          on: "start",
          steps: [
            { ask: { text: "ship it?", options: ["yes", "no"] } },
            { ask: { text: "and deploy it?", options: ["yes", "no"] } },
          ],
        },
      ],
    });

    const first = await nextRequestId(handle);
    await handle.respond(first, { kind: "answer", value: "yes" });

    // The act carries on and asks again. An id derived from how many requests
    // are *outstanding* would be the settled one over again, and the second
    // question would be found as the first.
    expect(await nextRequestId(handle)).not.toBe(first);
  });

  it("raises a declared re-raise as one call, still scoped to its session", async () => {
    const retries: RuntimeScript = {
      acts: [
        {
          on: "start",
          steps: [
            { ask: { text: "ship it?", options: ["yes"], asRequest: "again" } },
            { ask: { text: "ship it?", options: ["yes"], asRequest: "again" } },
          ],
        },
      ],
    };

    const handle = await start(retries);
    const first = await nextRequestId(handle);
    await handle.respond(first, { kind: "answer", value: "yes" });

    // The same call asked again, which is what a runtime retrying a denied one
    // does: PlotRoom settles it from the answer it already has (§6.6).
    expect(await nextRequestId(handle)).toBe(first);

    // But a name is a name within one session only — a script must not be able to
    // make one session's answer settle another session's call.
    const other = await start(retries);
    expect(await nextRequestId(other)).not.toBe(first);
  });
});

describe("the script format refuses what it cannot honestly replay", () => {
  it("caps a delay rather than clamping it", () => {
    const parsed = runtimeScriptSchema.safeParse({
      acts: [
        { on: "start", steps: [{ delay: { ms: SCRIPTED_MAX_DELAY_MS } }] },
      ],
    });
    expect(parsed.success).toBe(true);

    const tooLong = runtimeScriptSchema.safeParse({
      acts: [
        { on: "start", steps: [{ delay: { ms: SCRIPTED_MAX_DELAY_MS + 1 } }] },
      ],
    });

    expect(tooLong.success).toBe(false);
    // Refused with the reason, not silently shortened: a minute-long pause is a
    // hung test, and a script that fails to parse says so immediately.
    expect(JSON.stringify(tooLong.error?.issues)).toMatch(/capped at 5000ms/);
  });

  it("refuses a delay that is not a positive whole number of milliseconds", () => {
    for (const ms of [0, -1, 12.5]) {
      expect(
        runtimeScriptSchema.safeParse({
          acts: [{ on: "start", steps: [{ delay: { ms } }] }],
        }).success,
      ).toBe(false);
    }
  });

  it("refuses a step that is two things at once", () => {
    const parsed = runtimeScriptSchema.safeParse({
      acts: [
        {
          on: "start",
          steps: [
            {
              delay: { ms: 10 },
              observation: { kind: "output-delta", text: "both" },
            },
          ],
        },
      ],
    });

    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(
      /exactly one of observation, effect, submit, ask, call, or delay/,
    );
  });
});
