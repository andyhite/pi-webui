import { expect, afterEach, describe, it } from "bun:test";
import type { DomainEvent } from "@plotroom/core";
import { openWebSocket } from "../test-support/bun-websocket.js";
import type { RuntimeScript } from "../runtime/scripted.js";
import {
  at,
  boot,
  cleanupHarnesses,
  command,
  endedSession,
  list,
  repository,
  run,
  str,
  type Harness,
} from "../testing/harness.js";

/**
 * Run comparison and cross-run outcomes (§4.4, Epic 6.4) — §15-1 paying off.
 *
 * "Adjust → re-run → compare is the most-repeated action in context engineering",
 * and these drive that loop over the real server: run, change an input, run again,
 * compare. What makes the answer trustworthy is that neither run is re-derived
 * from the current state of anything — each recorded its whole self, which is the
 * invariant this epic exists to spend.
 */
afterEach(cleanupHarnesses);

const oneTurn: RuntimeScript = {
  acts: [
    {
      on: "start",
      steps: [
        { observation: { kind: "turn-started", turn: 1 } },
        {
          observation: {
            kind: "turn-ended",
            turn: 1,
            usage: { inputTokens: 20, outputTokens: 8, costUsd: 0.02 },
          },
        },
        {
          observation: {
            kind: "session-ended",
            reason: { kind: "ended-by-user" },
          },
        },
      ],
    },
  ],
};

const fails: RuntimeScript = {
  acts: [
    {
      on: "start",
      steps: [
        {
          observation: {
            kind: "session-ended",
            reason: { kind: "failed", message: "the tests would not pass" },
          },
        },
      ],
    },
  ],
};

/** Run a command, wait for its session to end, and answer with the run's id. */
async function completedRun(
  harness: Harness,
  commandId: string,
  script: RuntimeScript = oneTurn,
): Promise<string> {
  const started = await run(harness, commandId, script);
  await endedSession(harness, str(started, "session.id"));
  return str(started, "run.id");
}

describe("comparing two runs (§4.4)", () => {
  it("says what went in, what changed, which model, and what it cost", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      lifecycle: "open",
      notes: [{ title: "Ticket", body: "the first wording" }],
    });

    const first = await completedRun(harness, fixture.commandId);

    // The world moves: the note is edited, which is a new version and drift for
    // everything that consumed the old one (§3.2).
    await harness.ok(`/notes/${fixture.noteIds[0]}`, {
      method: "PATCH",
      body: { title: "Ticket", body: "the second wording" },
    });

    const second = await completedRun(harness, fixture.commandId);

    const read = await harness.ok(`/runs/${first}/compare?with=${second}`);
    const inputs = list(read, "comparison.inputs");

    // Same object, a different version: the adjust-then-re-run case, named as a
    // content change rather than as an addition or a replacement.
    expect(inputs.map((one) => at(one, "change"))).toEqual(["content"]);
    expect(at(inputs[0], "left.versionId")).not.toBe(
      at(inputs[0], "right.versionId"),
    );

    // Both assembled bodies stay addressable, so a diff is derivable without the
    // comparison carrying two whole contexts.
    expect(at(read, "comparison.sameAssembledContent")).toBe(false);
    const leftBody = await harness.ok(
      String(at(read, "comparison.left.assembledAddress")).replace("/api", ""),
    );
    expect(String(at(leftBody, "content"))).toContain("the first wording");

    // Which model, and what it cost.
    expect(at(read, "comparison.configuration")).toEqual([]);
    expect(at(read, "comparison.cost.leftMicros")).toBe(20_000);
    expect(at(read, "comparison.cost.deltaMicros")).toBe(0);
    expect(String(at(read, "comparison.summary"))).toContain("1 of 1 inputs");
  });

  it("refuses two runs of different definitions, with the reason (§4.4)", async () => {
    const harness = await boot(repository());
    const one = await command(harness, { lifecycle: "open", name: "Alpha" });
    const other = await command(harness, { lifecycle: "open", name: "Beta" });

    const left = await completedRun(harness, one.commandId);
    const right = await completedRun(harness, other.commandId);

    const refused = await harness.call(`/runs/${left}/compare?with=${right}`);
    expect(refused.status).toBe(409);
    expect(at(refused.body, "error.details.reason")).toBe(
      "different_definitions",
    );
  });

  it("asks for the other run rather than guessing one", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });
    const only = await completedRun(harness, fixture.commandId);

    const bad = await harness.call(`/runs/${only}/compare`);
    expect(bad.status).toBe(400);
  });
});

describe("cross-run outcomes per definition (§4.4)", () => {
  it("counts attempts and keeps every end state its own", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });

    await completedRun(harness, fixture.commandId);
    await completedRun(harness, fixture.commandId, fails);

    const read = await harness.ok(
      `/command-definitions/${fixture.definitionId}/outcomes`,
    );

    expect(at(read, "outcomes.attempts")).toBe(2);
    const histogram = list(read, "outcomes.byStatus").map((entry) => [
      at(entry, "status"),
      at(entry, "runs"),
    ]);
    // An open session ended by the user leaves its run stopped, and a failure
    // leaves it failed — two different facts, counted as two (principle 11).
    expect(histogram).toEqual([
      ["failed", 1],
      ["stopped", 1],
    ]);

    // Nothing has completed, so there is no "typically N attempts" to report.
    expect(at(read, "outcomes.attemptsPerCompletion")).toBeNull();
  });

  it("prices from the same estimate the run preview shows", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });
    await completedRun(harness, fixture.commandId);

    const outcomes = await harness.ok(
      `/command-definitions/${fixture.definitionId}/outcomes`,
    );
    const preview = await harness.ok(`/commands/${fixture.commandId}/preview`);

    // One function, one answer: a cross-run cost and a pre-run estimate that could
    // disagree would make one of them wrong on every screen showing both.
    expect(at(outcomes, "outcomes.cost.basis")).toBe("prior-runs");
    expect(at(outcomes, "outcomes.cost.range")).toEqual(
      at(preview, "preview.estimate.range"),
    );
  });

  it("says nothing has been observed rather than reporting zeroes", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });

    const read = await harness.ok(
      `/command-definitions/${fixture.definitionId}/outcomes`,
    );
    expect(at(read, "outcomes.attempts")).toBe(0);
    // Null, not zero: nothing has ever been priced, so there is no number.
    expect(at(read, "outcomes.cost.range")).toBeNull();
  });
});

describe("pinning (§4.4)", () => {
  it("publishes the pin, because it changes what a run's future is", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      lifecycle: "open",
      notes: [{ title: "Ticket", body: "pinned run's input" }],
    });
    const runId = await completedRun(harness, fixture.commandId);

    const ws = openWebSocket(`ws://127.0.0.1:${harness.port}/ws`, {
      headers: { origin: `http://localhost:${harness.port}` },
    });
    const events: DomainEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("error", reject);
      ws.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          event?: DomainEvent;
        };
        if (message.type === "hello") resolve();
        if (message.type === "event" && message.event)
          events.push(message.event);
      });
    });

    const pinned = await harness.ok(`/runs/${runId}/pin`, { method: "POST" });
    expect(at(pinned, "run.pinned")).toBe(true);

    const unpinned = await harness.ok(`/runs/${runId}/pin`, {
      method: "DELETE",
    });
    expect(at(unpinned, "run.pinned")).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 50));
    ws.close();

    // "Pinning is how a run becomes comparable forever" (§3.7), so a surface
    // showing run history hears about it rather than discovering it on a refetch.
    const runEvents = events.filter((event) => event.entity === "run");
    expect(runEvents.map((event) => at(event, "run.pinned"))).toEqual([
      true,
      false,
    ]);
  });
});
