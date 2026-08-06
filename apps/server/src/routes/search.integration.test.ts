import type { RuntimeScript } from "../runtime/scripted.js";
import { DEFAULT_SEARCH_LIMIT } from "@plotroom/db";
import { afterEach, describe, expect, it } from "bun:test";
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
} from "../testing/harness.js";

/**
 * FTS search over sessions, including archived ones (§6.8, Epic 8.2).
 *
 * Drives the real app: a real server, a real SQLite state directory, the
 * scripted runtime. What this proves about ranking and archived-reporting is
 * true of a real session too (decision 0001).
 */

afterEach(cleanupHarnesses);

/** A script that streams one turn and ends the session (ended-by-user). */
const oneTurn: RuntimeScript = {
  acts: [
    {
      on: "start",
      steps: [
        { observation: { kind: "turn-started", turn: 1 } },
        {
          observation: {
            kind: "output-delta",
            text: "found the flaky assertion in the login test",
          },
        },
        {
          observation: {
            kind: "turn-ended",
            turn: 1,
            usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.001 },
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

/** A script that updates the plan, streams one turn, and ends the session. */
const oneTurnWithPlan: RuntimeScript = {
  acts: [
    {
      on: "start",
      steps: [
        {
          observation: {
            kind: "plan-updated",
            phases: [
              {
                name: "Implementation",
                tasks: [
                  {
                    content: "chase the ferret out of the login form",
                    status: "in_progress",
                  },
                ],
              },
            ],
          },
        },
        { observation: { kind: "turn-started", turn: 1 } },
        { observation: { kind: "output-delta", text: "on it" } },
        {
          observation: {
            kind: "turn-ended",
            turn: 1,
            usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.001 },
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

describe("search (§6.8)", () => {
  it("finds a session by its command's title, ranks the title above a body-only hit, and reports its workstream's location", async () => {
    const harness = await boot(repository());

    const fixture = await command(harness, {
      lifecycle: "open",
      name: "Fix the flaky login test",
    });

    const subject = await harness.ok("/notes", {
      method: "POST",
      body: {
        title: "OXY-2982",
        body: "the login test fails intermittently",
        workstreamId: fixture.workstream,
      },
    });
    await harness.ok(`/workstreams/${fixture.workstream}`, {
      method: "PATCH",
      body: { subjectId: str(subject, "object.id") },
    });

    const started = await run(harness, fixture.commandId, oneTurn);
    const sessionId = str(started, "session.id");
    await endedSession(harness, sessionId);

    const found = await harness.ok(`/search?q=${encodeURIComponent("flaky")}`);
    const hits = list(found, "hits");
    const hit = hits.find((one) => at(one, "refId") === sessionId);

    expect(hit).toBeDefined();
    expect(at(hit, "kind")).toBe("session");
    expect(at(hit, "refKind")).toBe("session");
    expect(at(hit, "title")).toBe("Fix the flaky login test");
    expect(at(hit, "location")).toBe("OXY-2982");
    expect(at(hit, "archived")).toBe(false);
  });

  it("indexes a session's transcript content, findable by a word only the transcript said", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      lifecycle: "open",
      name: "Unrelated command name",
    });

    const started = await run(harness, fixture.commandId, oneTurn);
    const sessionId = str(started, "session.id");
    await endedSession(harness, sessionId);

    const found = await harness.ok(
      `/search?q=${encodeURIComponent("assertion")}`,
    );
    const hits = list(found, "hits");

    expect(hits.map((hit) => at(hit, "refId"))).toContain(sessionId);
  });

  it("indexes the plan alongside the transcript, findable by a word only the plan said (§3.6, §6.8)", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      lifecycle: "open",
      name: "Unrelated command name",
    });

    const started = await run(harness, fixture.commandId, oneTurnWithPlan);
    const sessionId = str(started, "session.id");
    await endedSession(harness, sessionId);

    const found = await harness.ok(`/search?q=${encodeURIComponent("ferret")}`);
    const hits = list(found, "hits");

    expect(hits.map((hit) => at(hit, "refId"))).toContain(sessionId);
  });

  it("reports an archived session's workstream as archived rather than hiding it (§3.3, §6.8)", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      lifecycle: "open",
      name: "A command worth archiving later",
    });

    const started = await run(harness, fixture.commandId, oneTurn);
    const sessionId = str(started, "session.id");
    await endedSession(harness, sessionId);

    await harness.ok(`/workstreams/${fixture.workstream}/archive`, {
      method: "POST",
    });

    const found = await harness.ok(
      `/search?q=${encodeURIComponent("archiving")}`,
    );
    const hits = list(found, "hits");
    const hit = hits.find((one) => at(one, "refId") === sessionId);

    expect(hit).toBeDefined();
    expect(at(hit, "archived")).toBe(true);
  });

  it("finds a hyphenated ticket id (a term FTS5's own grammar reads as NOT) with sane hits, never a 500", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      lifecycle: "open",
      name: "Fix the flaky login test",
    });

    const subject = await harness.ok("/notes", {
      method: "POST",
      body: {
        title: "OXY-2982",
        body: "the login test fails intermittently",
        workstreamId: fixture.workstream,
      },
    });
    await harness.ok(`/workstreams/${fixture.workstream}`, {
      method: "PATCH",
      body: { subjectId: str(subject, "object.id") },
    });

    const started = await run(harness, fixture.commandId, oneTurn);
    const sessionId = str(started, "session.id");
    await endedSession(harness, sessionId);

    const found = await harness.ok(
      `/search?q=${encodeURIComponent("OXY-2982")}`,
    );
    const hits = list(found, "hits");
    const hit = hits.find((one) => at(one, "refId") === sessionId);

    expect(hit).toBeDefined();
    expect(at(hit, "location")).toBe("OXY-2982");
  });

  it("treats an unbalanced quote as literal text (200, empty hits) rather than raising SQLite's 'unterminated string'", async () => {
    const harness = await boot(repository());
    const res = await harness.call(
      `/search?q=${encodeURIComponent('"unterminated')}`,
    );

    expect(res.status).toBe(200);
    expect(list(res.body, "hits")).toEqual([]);
  });

  it("treats stray parens and asterisks as literal text (200, empty hits) rather than an FTS5 syntax error", async () => {
    const harness = await boot(repository());

    const parens = await harness.call(
      `/search?q=${encodeURIComponent("foo(bar")}`,
    );
    expect(parens.status).toBe(200);
    expect(list(parens.body, "hits")).toEqual([]);

    const stars = await harness.call(
      `/search?q=${encodeURIComponent("foo*bar*")}`,
    );
    expect(stars.status).toBe(200);
    expect(list(stars.body, "hits")).toEqual([]);
  });

  it("matches a query containing literal quote characters as literal text rather than raising a syntax error", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      lifecycle: "open",
      name: 'Fix the "flaky" login test',
    });

    const started = await run(harness, fixture.commandId, oneTurn);
    const sessionId = str(started, "session.id");
    await endedSession(harness, sessionId);

    const found = await harness.ok(
      `/search?q=${encodeURIComponent('"flaky"')}`,
    );
    const hits = list(found, "hits");

    expect(hits.map((hit) => at(hit, "refId"))).toContain(sessionId);
  });

  it("refuses an empty query rather than asking SQLite to explain itself", async () => {
    const harness = await boot(repository());
    const res = await harness.call("/search?q=");

    expect(res.status).toBe(400);
  });

  it("says when hits were left out, and says the limit it applied (no silent truncation)", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      lifecycle: "open",
      name: "Fix the flaky login test",
    });

    // Two sessions of the same command: two hits for one word, which is the
    // smallest arrangement in which a limit of one has something to hide.
    for (let i = 0; i < 2; i += 1) {
      const started = await run(harness, fixture.commandId, oneTurn);
      await endedSession(harness, str(started, "session.id"));
    }

    const clamped = await harness.ok(
      `/search?q=${encodeURIComponent("flaky")}&limit=1`,
    );
    expect(list(clamped, "hits")).toHaveLength(1);
    expect(at(clamped, "limit")).toBe(1);
    expect(at(clamped, "truncated")).toBe(true);

    const complete = await harness.ok(
      `/search?q=${encodeURIComponent("flaky")}&limit=5`,
    );
    expect(list(complete, "hits")).toHaveLength(2);
    expect(at(complete, "limit")).toBe(5);
    expect(at(complete, "truncated")).toBe(false);

    // The boundary the probe exists for: a full page that is also the whole
    // answer. `hits.length === limit` says "truncated" here and is wrong — the
    // only honest evidence is that no further hit existed.
    const exact = await harness.ok(
      `/search?q=${encodeURIComponent("flaky")}&limit=2`,
    );
    expect(list(exact, "hits")).toHaveLength(2);
    expect(at(exact, "limit")).toBe(2);
    expect(at(exact, "truncated")).toBe(false);
  });

  it("applies an integer limit rather than forwarding a fractional one into SQLite", async () => {
    const harness = await boot(repository());
    const res = await harness.call(
      `/search?q=${encodeURIComponent("flaky")}&limit=1.5`,
    );

    expect(res.status).toBe(200);
    expect(at(res.body, "limit")).toBe(1);
  });

  it("reports the default limit when the caller named none, and does not claim truncation under it", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      lifecycle: "open",
      name: "Fix the flaky login test",
    });
    const started = await run(harness, fixture.commandId, oneTurn);
    await endedSession(harness, str(started, "session.id"));

    const found = await harness.ok(`/search?q=${encodeURIComponent("flaky")}`);

    expect(at(found, "limit")).toBe(DEFAULT_SEARCH_LIMIT);
    expect(at(found, "truncated")).toBe(false);
  });

  it("refuses a session actor (principle 1): a snippet of another session's transcript is not this session's to read", async () => {
    const harness = await boot(repository());
    const res = await harness.call("/search?q=anything", {
      actor: "session:sess_curious",
    });

    expect(res.status).toBe(403);
  });
});
