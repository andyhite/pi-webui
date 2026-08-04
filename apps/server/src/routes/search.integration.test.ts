import type { RuntimeScript } from "../runtime/scripted.js";
import { afterEach, describe, expect, it } from "vitest";
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

  it("refuses an empty query rather than asking SQLite to explain itself", async () => {
    const harness = await boot(repository());
    const res = await harness.call("/search?q=");

    expect(res.status).toBe(400);
  });

  it("refuses a session actor (principle 1): a snippet of another session's transcript is not this session's to read", async () => {
    const harness = await boot(repository());
    const res = await harness.call("/search?q=anything", {
      actor: "session:sess_curious",
    });

    expect(res.status).toBe(403);
  });
});
