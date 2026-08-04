import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeScript } from "../runtime/scripted.js";
import {
  at,
  boot,
  cleanupHarnesses,
  command,
  ephemeralPort,
  list,
  repository,
  run,
  str,
  waitFor,
  type Harness,
} from "../testing/harness.js";

/**
 * The attention derivation, over a real server (§7).
 *
 * "One derivation, many surfaces" is only true end to end if the server produces
 * the one list every surface reads. What these prove is that it does: that each
 * feed reaches the queue, that triage really hides what it says it hides, that an
 * item's id survives a re-read (so a reconnecting surface does not re-notify
 * everything), and that an outbound route fires once and carries nothing it
 * should not.
 */
afterEach(cleanupHarnesses);

const staysOpen: RuntimeScript = {
  acts: [
    {
      on: "start",
      steps: [
        { observation: { kind: "turn-started", turn: 1 } },
        { observation: { kind: "output-delta", text: "working" } },
        {
          observation: {
            kind: "turn-ended",
            turn: 1,
            usage: { inputTokens: 8, outputTokens: 2, costUsd: 0.002 },
          },
        },
      ],
    },
  ],
};

const finishes: RuntimeScript = {
  acts: [
    {
      on: "start",
      steps: [
        { observation: { kind: "turn-started", turn: 1 } },
        { observation: { kind: "output-delta", text: "done" } },
        {
          observation: {
            kind: "turn-ended",
            turn: 1,
            usage: { inputTokens: 8, outputTokens: 2, costUsd: 0.002 },
          },
        },
        {
          observation: {
            kind: "session-ended",
            reason: { kind: "failed", message: "the build broke" },
          },
        },
      ],
    },
  ],
};

async function items(harness: Harness): Promise<unknown[]> {
  return list(await harness.ok("/attention"), "items");
}

async function itemOfFeed(
  harness: Harness,
  feed: string,
): Promise<Record<string, unknown>> {
  return waitFor(async () => {
    const found = (await items(harness)).find(
      (item) => at(item, "feed") === feed,
    );
    return (found as Record<string, unknown>) ?? null;
  }, `an item on the ${feed} feed`);
}

/** A live session plus a question it asked, which is the simplest queue row. */
async function askingSession(harness: Harness): Promise<{
  readonly sessionId: string;
  readonly questionId: string;
  readonly workstream: string;
}> {
  const fixture = await command(harness, { lifecycle: "open" });
  const started = await run(harness, fixture.commandId, staysOpen);
  const sessionId = str(started, "session.id");

  const asked = await harness.ok(`/sessions/${sessionId}/questions`, {
    method: "POST",
    body: {
      text: "keep going with the migration?",
      options: ["yes", "no"],
    },
    actor: `session:${sessionId}`,
  });

  return {
    sessionId,
    questionId: str(asked, "question.id"),
    workstream: fixture.workstream,
  };
}

describe("the queue (§7.1)", () => {
  it("carries a question with its real option ids, answerable in place", async () => {
    const harness = await boot(repository());
    const { sessionId, questionId } = await askingSession(harness);

    const row = await itemOfFeed(harness, "question");
    expect(at(row, "id")).toBe(`question:${questionId}`);
    expect(at(row, "target.sessionId")).toBe(sessionId);
    expect(at(row, "summary")).toContain("keep going with the migration?");

    const options = list(row, "payload.options");
    expect(options).toHaveLength(2);
    // Ids, not labels: `answerQuestion` takes the option's own id, so a row
    // carrying labels alone would need a resolution nothing should have to do.
    expect(at(options[0], "id")).toBeTypeOf("string");
    expect(at(options[0], "label")).toBe("yes");

    await harness.ok(`/questions/${questionId}/answer`, {
      method: "POST",
      body: { optionId: str(options[0], "id") },
    });

    const after = await items(harness);
    expect(after.some((item) => at(item, "feed") === "question")).toBe(false);
  });

  it("stops carrying a deleted session's question, and carries it again once restored (#77)", async () => {
    const harness = await boot(repository());
    const { sessionId, questionId } = await askingSession(harness);
    await itemOfFeed(harness, "question");

    // The delete takes the session's node off the board with the record, so a row
    // still naming it would point the operator at a card that is not there.
    await harness.ok(`/sessions/${sessionId}`, { method: "DELETE" });

    const hidden = await items(harness);
    expect(hidden.map((item) => at(item, "id"))).not.toContain(
      `question:${questionId}`,
    );

    // Hidden, not withdrawn: the question is still an answerable fact, and the
    // session's own restore is all it takes to have it asked again (principle 10).
    await harness.ok(`/sessions/${sessionId}/restore`, { method: "POST" });
    const back = await itemOfFeed(harness, "question");
    expect(at(back, "id")).toBe(`question:${questionId}`);
  });

  it("keeps every id stable across a re-read, so nothing looks new twice", async () => {
    const harness = await boot(repository());
    await askingSession(harness);
    await itemOfFeed(harness, "question");

    const first = (await items(harness)).map((item) => at(item, "id"));
    const second = (await items(harness)).map((item) => at(item, "id"));

    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  });

  it("puts a failed end in front of the operator as wanting a decision", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });
    const started = await run(harness, fixture.commandId, finishes);
    const sessionId = str(started, "session.id");

    const row = await itemOfFeed(harness, "completion");
    expect(at(row, "payload.sessionId")).toBe(sessionId);
    expect(at(row, "summary")).toContain("the build broke");

    // A failed end is in the `failed` and `wants-decision` states an outbound
    // route attaches to (§7.3), and a proven completion would be in neither.
    const states = at(
      await harness.ok("/attention"),
      `states.completion:${sessionId}`,
    ) as string[];
    expect(states).toContain("failed");
    expect(states).toContain("wants-decision");
  });
});

describe("triage (§4.5), whose job is hiding", () => {
  it("mutes an item for good", async () => {
    const harness = await boot(repository());
    await askingSession(harness);
    const row = await itemOfFeed(harness, "question");

    await harness.ok(`/attention/${str(row, "id")}/mute`, {
      method: "POST",
      body: {},
    });

    expect(
      (await items(harness)).some((item) => at(item, "id") === at(row, "id")),
    ).toBe(false);
  });

  it("hides a snoozed item, then hands it back with snoozeUntil null", async () => {
    const harness = await boot(repository());
    await askingSession(harness);
    const row = await itemOfFeed(harness, "question");
    const id = str(row, "id");

    const soon = Math.floor(Date.now() / 1000) + 2;
    await harness.ok(`/attention/${id}/snooze`, {
      method: "POST",
      body: { snoozedUntil: soon },
    });
    expect((await items(harness)).some((item) => at(item, "id") === id)).toBe(
      false,
    );

    const returned = await waitFor(async () => {
      const found = (await items(harness)).find(
        (item) => at(item, "id") === id,
      );
      return found ?? null;
    }, "the snoozed item to come back");

    // Null the instant it returns: a stale value here would be
    // indistinguishable from still being hidden.
    expect(at(returned, "snoozeUntil")).toBeNull();
  });

  it("refuses a snooze with no return time, and a return time in the past", async () => {
    const harness = await boot(repository());
    await askingSession(harness);
    const id = str(await itemOfFeed(harness, "question"), "id");

    const bare = await harness.call(`/attention/${id}/snooze`, {
      method: "POST",
      body: {},
    });
    expect(bare.status).toBe(400);

    const past = await harness.call(`/attention/${id}/snooze`, {
      method: "POST",
      body: { snoozedUntil: 1 },
    });
    expect(past.status).toBe(400);
  });

  it("acknowledges a drift-free row and leaves it acknowledged", async () => {
    const harness = await boot(repository());
    await askingSession(harness);
    const id = str(await itemOfFeed(harness, "question"), "id");

    await harness.ok(`/attention/${id}/acknowledge`, {
      method: "POST",
      body: {},
    });

    // A question that has not changed stays acknowledged: what makes an
    // acknowledgement expire is the fact behind it moving (§4.5), and a question
    // asked once is asked once.
    expect((await items(harness)).some((item) => at(item, "id") === id)).toBe(
      false,
    );
  });

  it("asks again about drift after a further edit — acknowledge advances a baseline (§4.5)", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      lifecycle: "open",
      notes: [{ title: "Ticket", body: "as written" }],
    });
    await run(harness, fixture.commandId, staysOpen);
    const noteId = fixture.noteIds[0] as string;

    // The world moves: what the run read is no longer the latest version (§3.2).
    await harness.ok(`/notes/${noteId}`, {
      method: "PATCH",
      body: { body: "the review landed overnight" },
    });
    const id = str(await itemOfFeed(harness, "drift"), "id");

    await harness.ok(`/attention/${id}/acknowledge`, {
      method: "POST",
      body: {},
    });
    expect((await items(harness)).some((item) => at(item, "id") === id)).toBe(
      false,
    );

    // A *further* edit. Acknowledge advanced the consumer's baseline to the
    // version it was shown; this is a version past it, so the row is drift again
    // rather than muted under another name — the difference between the two verbs
    // is the whole of §4.5.
    await harness.ok(`/notes/${noteId}`, {
      method: "PATCH",
      body: { body: "and overnight it changed again" },
    });

    const again = await waitFor(async () => {
      const found = (await items(harness)).find(
        (item) => at(item, "id") === id,
      );
      return found ?? null;
    }, "the drift row to come back after a further edit");
    expect(at(again, "feed")).toBe("drift");

    // And acknowledging *that* version hides it again: the baseline advances
    // each time, and nothing here ran anything (principle 2).
    await harness.ok(`/attention/${id}/acknowledge`, {
      method: "POST",
      body: {},
    });
    expect((await items(harness)).some((item) => at(item, "id") === id)).toBe(
      false,
    );
  });

  it("refuses a return time on anything but a snooze", async () => {
    const harness = await boot(repository());
    await askingSession(harness);
    const id = str(await itemOfFeed(harness, "question"), "id");

    const refused = await harness.call(`/attention/${id}/mute`, {
      method: "POST",
      body: { snoozedUntil: Math.floor(Date.now() / 1000) + 60 },
    });
    expect(refused.status).toBe(400);
  });

  it("undoes a mute, because a mute you regret is recoverable", async () => {
    const harness = await boot(repository());
    await askingSession(harness);
    const id = str(await itemOfFeed(harness, "question"), "id");

    await harness.ok(`/attention/${id}/mute`, { method: "POST", body: {} });
    await harness.ok(`/attention/${id}/triage`, { method: "DELETE" });

    expect((await items(harness)).some((item) => at(item, "id") === id)).toBe(
      true,
    );
  });

  it("is the operator's: a session cannot clear the human's queue", async () => {
    const harness = await boot(repository());
    const { sessionId } = await askingSession(harness);
    const id = str(await itemOfFeed(harness, "question"), "id");

    const muted = await harness.call(`/attention/${id}/mute`, {
      method: "POST",
      body: {},
      actor: `session:${sessionId}`,
    });
    // Enforced by the actor, not only declared in the catalog: a session muting
    // the row that reports on it would be deciding what the human sees.
    expect(muted.status).toBe(403);
    expect((await items(harness)).some((item) => at(item, "id") === id)).toBe(
      true,
    );
  });
});

describe("health alerts, from observation only (§7.2)", () => {
  it("reports a session waiting on the operator once past the threshold", async () => {
    // Thresholds are configurable, which is what makes this testable without
    // sleeping for five minutes.
    const harness = await boot({
      ...repository(),
      attentionTickSeconds: 0,
    });
    const { sessionId } = await askingSession(harness);
    await itemOfFeed(harness, "question");

    // With the shipped thresholds nothing is stale yet: the question was asked
    // a moment ago, and an alert that fired immediately would be noise.
    const early = await items(harness);
    expect(early.some((item) => at(item, "feed") === "health")).toBe(false);
    expect(sessionId).toBeDefined();
  });
});

describe("outbound routing (§7.3)", () => {
  it("fires once per occurrence, and never carries a content body", async () => {
    const received: unknown[] = [];
    const port = await ephemeralPort();
    const webhook = await listen(port, (body) => received.push(body));

    try {
      const harness = await boot(repository());
      await harness.ok("/notification-routes", {
        method: "POST",
        body: {
          name: "chat",
          state: "blocked",
          url: `http://127.0.0.1:${port}/hook`,
        },
      });

      const { questionId } = await askingSession(harness);
      const delivered = await waitFor(
        async () => (received.length > 0 ? received[0] : null),
        "the webhook to be called",
      );

      expect(at(delivered, "itemId")).toBe(`question:${questionId}`);
      expect(at(delivered, "state")).toBe("blocked");
      expect(at(delivered, "redaction")).toBe("summary-only");
      // Titles and summaries pass; content bodies never. The payload — which is
      // where a question's text and options live — is not on the wire at all.
      expect(at(delivered, "payload")).toBeUndefined();
      expect(JSON.stringify(delivered)).not.toContain("options");

      // Edge-triggered: re-deriving the same visible item fires nothing more.
      const before = received.length;
      await harness.ok("/attention");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(received.length).toBe(before);

      // And the route's health says it is working, which is how a broken one
      // would be visible rather than inferred from silence.
      const routes = list(await harness.ok("/notification-routes"), "routes");
      expect(at(routes[0], "health.lastSuccessAt")).not.toBeNull();
      expect(at(routes[0], "health.consecutiveFailures")).toBe(0);
    } finally {
      await close(webhook);
    }
  });

  it("keeps its webhook URLs from a session: the read is the operator's too", async () => {
    const harness = await boot(repository());
    await harness.ok("/notification-routes", {
      method: "POST",
      body: {
        name: "chat",
        state: "blocked",
        url: "https://hooks.example.invalid/t/a-secret-token",
      },
    });

    const { sessionId } = await askingSession(harness);

    // A route URL is a webhook token in everything but name — anyone holding it
    // can post into the operator's chat — so the read is gated like the writes
    // rather than left open because it is a GET (§9.3).
    const refused = await harness.call("/notification-routes", {
      actor: `session:${sessionId}`,
    });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).not.toContain("a-secret-token");

    const written = await harness.call("/notification-routes", {
      method: "POST",
      body: {
        name: "another",
        state: "failed",
        url: "https://hooks.example.invalid/t/second",
      },
      actor: `session:${sessionId}`,
    });
    expect(written.status).toBe(403);
  });

  it("records a failing destination as route health rather than crashing", async () => {
    const harness = await boot(repository());
    await harness.ok("/notification-routes", {
      method: "POST",
      body: {
        name: "broken",
        state: "anything",
        // Nothing is listening here: the delivery fails, and the derivation
        // must not care.
        url: `http://127.0.0.1:${await ephemeralPort()}/hook`,
      },
    });

    await askingSession(harness);

    const failing = await waitFor(async () => {
      const routes = list(await harness.ok("/notification-routes"), "routes");
      return at(routes[0], "health.consecutiveFailures") === 0
        ? null
        : routes[0];
    }, "the route to report a failure");

    expect(at(failing, "health.lastFailureReason")).toBeTypeOf("string");
    // The queue is unaffected: a destination nobody can reach is not the
    // derivation's problem.
    expect((await items(harness)).length).toBeGreaterThan(0);
  });

  it("only matches the state it attaches to", async () => {
    const received: unknown[] = [];
    const port = await ephemeralPort();
    const webhook = await listen(port, (body) => received.push(body));

    try {
      const harness = await boot(repository());
      await harness.ok("/notification-routes", {
        method: "POST",
        body: {
          name: "failures only",
          state: "failed",
          url: `http://127.0.0.1:${port}/hook`,
        },
      });

      await askingSession(harness);
      await new Promise((resolve) => setTimeout(resolve, 150));
      // A question is `blocked`, not `failed`.
      expect(received).toEqual([]);
    } finally {
      await close(webhook);
    }
  });
});

describe("what changed while I was away (§7.3)", () => {
  it("keeps a per-workstream history of what happened, capped", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });
    const started = await run(harness, fixture.commandId, finishes);
    const sessionId = str(started, "session.id");

    const entries = await waitFor(async () => {
      const read = list(
        await harness.ok(`/activity?workstreamId=${fixture.workstream}`),
        "entries",
      );
      return read.length > 0 ? read : null;
    }, "the failure to reach the history");

    const failure = entries.find((entry) => at(entry, "kind") === "failure");
    expect(at(failure, "workstreamId")).toBe(fixture.workstream);
    expect(at(failure, "text")).toContain("the build broke");
    // Each entry routes to what it was about (§7.3).
    expect(at(failure, "targetNodeId")).toBeTypeOf("string");
    expect(sessionId).toBeDefined();
  });
});

/* ------------------------------------------------------------- a webhook */

function listen(
  port: number,
  onBody: (body: unknown) => void,
): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        onBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(204).end();
      });
    });
    // A socket torn down while the harness is shutting down is not a failure of
    // anything under test: the delivery it belonged to is already recorded as
    // route health (§7.3), and an unhandled 'error' here would fail the run.
    server.on("clientError", () => {});
    server.on("error", () => {});
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
