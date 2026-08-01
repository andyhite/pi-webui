import { describe, expect, it, vi } from "vitest";
import { humanAuthor } from "@plotroom/core";
import type { Session, SessionId, Transcript } from "@plotroom/core";
import { INHERIT_APP_TOOLS, startSession } from "@plotroom/core";

import { createFixtureSessionDataSource } from "./data-source.js";

function session(id: string): Session {
  return startSession(
    {
      id: id as SessionId,
      workstreamId: "ws_1" as Session["workstreamId"],
      commandId: null,
      mode: "open",
      launch: {
        model: "anthropic/claude-sonnet-4",
        effort: "medium",
        toolPermissions: INHERIT_APP_TOOLS,
      },
      initiatedBy: humanAuthor,
      runtime: { adapterId: "pi-coding-agent", ref: "pi-session-1" },
    },
    1_000_000,
  );
}

function emptyTranscript(id: string): Transcript {
  return { sessionId: id as SessionId, turns: [] };
}

describe("createFixtureSessionDataSource", () => {
  it("loads the session list and a session's transcript", async () => {
    const source = createFixtureSessionDataSource({
      sessions: [session("sess-1")],
      transcripts: new Map([
        ["sess-1" as SessionId, emptyTranscript("sess-1")],
      ]),
    });
    expect((await source.loadList()).map((s) => s.id)).toEqual(["sess-1"]);
    expect(await source.loadTranscript("sess-1" as SessionId)).toEqual(
      emptyTranscript("sess-1"),
    );
  });

  it("loadTranscript falls back to empty for an unknown session", async () => {
    const source = createFixtureSessionDataSource({
      sessions: [],
      transcripts: new Map(),
    });
    expect(await source.loadTranscript("sess-missing" as SessionId)).toEqual(
      emptyTranscript("sess-missing"),
    );
  });

  it("subscribeTranscript delivers the current transcript immediately", async () => {
    const transcript = {
      sessionId: "sess-1" as SessionId,
      turns: [{ ordinal: 1, startedAt: 1, entries: [] }],
    };
    const source = createFixtureSessionDataSource({
      sessions: [session("sess-1")],
      transcripts: new Map([["sess-1" as SessionId, transcript]]),
    });
    const onEvent = vi.fn();
    source.subscribeTranscript("sess-1" as SessionId, onEvent);
    expect(onEvent).toHaveBeenCalledWith({
      sessionId: "sess-1",
      transcript,
    });
  });

  it("plays back scripted turns in order, each after its own delay", () => {
    const scheduled: { fn: () => void; delayMs: number }[] = [];
    const schedule = (fn: () => void, delayMs: number) => {
      scheduled.push({ fn, delayMs });
    };

    const source = createFixtureSessionDataSource({
      sessions: [session("sess-1")],
      transcripts: new Map([
        ["sess-1" as SessionId, emptyTranscript("sess-1")],
      ]),
      script: [
        {
          sessionId: "sess-1" as SessionId,
          turn: {
            ordinal: 1,
            startedAt: 1,
            entries: [{ kind: "output", text: "a" }],
          },
          delayMs: 100,
        },
        {
          sessionId: "sess-1" as SessionId,
          turn: {
            ordinal: 2,
            startedAt: 2,
            entries: [{ kind: "output", text: "b" }],
          },
          delayMs: 200,
        },
      ],
      schedule,
    });

    const events: Transcript[] = [];
    source.subscribeTranscript("sess-1" as SessionId, (event) => {
      events.push(event.transcript);
    });

    expect(scheduled.map((s) => s.delayMs)).toEqual([100, 200]);

    // Immediate emission on subscribe, then the two scripted deliveries.
    expect(events).toHaveLength(1);
    scheduled[0]?.fn();
    expect(events).toHaveLength(2);
    expect(events[1]?.turns.map((t) => t.ordinal)).toEqual([1]);
    scheduled[1]?.fn();
    expect(events).toHaveLength(3);
    expect(events[2]?.turns.map((t) => t.ordinal)).toEqual([1, 2]);
  });

  it("does not restart playback for a second subscriber to the same session", () => {
    const schedule = vi.fn();
    const source = createFixtureSessionDataSource({
      sessions: [session("sess-1")],
      transcripts: new Map([
        ["sess-1" as SessionId, emptyTranscript("sess-1")],
      ]),
      script: [
        {
          sessionId: "sess-1" as SessionId,
          turn: { ordinal: 1, startedAt: 1, entries: [] },
          delayMs: 50,
        },
      ],
      schedule,
    });
    source.subscribeTranscript("sess-1" as SessionId, () => {});
    source.subscribeTranscript("sess-1" as SessionId, () => {});
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops delivering further events", () => {
    const scheduled: { fn: () => void }[] = [];
    const source = createFixtureSessionDataSource({
      sessions: [session("sess-1")],
      transcripts: new Map([
        ["sess-1" as SessionId, emptyTranscript("sess-1")],
      ]),
      script: [
        {
          sessionId: "sess-1" as SessionId,
          turn: { ordinal: 1, startedAt: 1, entries: [] },
          delayMs: 10,
        },
      ],
      schedule: (fn) => scheduled.push({ fn }),
    });
    const onEvent = vi.fn();
    const unsubscribe = source.subscribeTranscript(
      "sess-1" as SessionId,
      onEvent,
    );
    unsubscribe();
    scheduled[0]?.fn();
    // Only the immediate emission on subscribe, none after unsubscribing.
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("loadReleasedContent resolves fixture content keyed by session and call id", async () => {
    const source = createFixtureSessionDataSource({
      sessions: [],
      transcripts: new Map(),
      releasedContent: new Map([["sess-1:call-1", "the released bytes"]]),
    });
    expect(
      await source.loadReleasedContent("sess-1" as SessionId, "call-1", {
        releasedAt: 1,
        bytes: 10,
        contentHash: "hash",
      }),
    ).toBe("the released bytes");
    expect(
      await source.loadReleasedContent("sess-1" as SessionId, "call-missing", {
        releasedAt: 1,
        bytes: 10,
        contentHash: "hash",
      }),
    ).toBeNull();
  });
});
