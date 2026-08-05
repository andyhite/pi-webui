import { describe, expect, it, vi } from "vitest";
import { humanAuthor, phaseFacts } from "@plotroom/core";
import type {
  DomainEvent,
  Session,
  SessionId,
  SessionStatus,
  Transcript,
} from "@plotroom/core";
import { INHERIT_APP_TOOLS, startSession } from "@plotroom/core";

import type { HttpClient } from "../transport/http.js";
import type { MinimalWebSocket, WebSocketFactory } from "../transport/ws.js";
import {
  createApiSessionDataSource,
  createFixtureSessionDataSource,
} from "./data-source.js";

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
      runtime: { adapterId: "omp-session-host", ref: "session-1" },
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

  it("subscribeSession delivers the fixture session and its status immediately", () => {
    const running = session("sess-1");
    const status: SessionStatus = {
      phase: { kind: "thinking" },
      facts: phaseFacts({ kind: "thinking" }),
      health: { silentForMs: 0, possiblyStalled: false },
    };
    const source = createFixtureSessionDataSource({
      sessions: [running],
      statuses: new Map([["sess-1" as SessionId, status]]),
      transcripts: new Map(),
    });
    const onDetail = vi.fn();
    source.subscribeSession("sess-1" as SessionId, onDetail);
    expect(onDetail).toHaveBeenCalledWith({ session: running, status });
  });

  it("subscribeSession defaults to an idle status when none was given", () => {
    const source = createFixtureSessionDataSource({
      sessions: [session("sess-1")],
      transcripts: new Map(),
    });
    const onDetail = vi.fn();
    source.subscribeSession("sess-1" as SessionId, onDetail);
    expect(onDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        status: expect.objectContaining({ phase: { kind: "idle" } }),
      }),
    );
  });

  it("subscribeSession never calls back for a session that does not exist yet", () => {
    const source = createFixtureSessionDataSource({
      sessions: [],
      transcripts: new Map(),
    });
    const onDetail = vi.fn();
    source.subscribeSession("sess-missing" as SessionId, onDetail);
    expect(onDetail).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------- live (Stage 2) */

function fakeSocket(): MinimalWebSocket {
  return {
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send: vi.fn(),
    close: vi.fn(),
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sessionEventMessage(
  seq: number,
  target: Session,
  phase: SessionStatus["phase"] = { kind: "thinking" },
): string {
  const event: DomainEvent = {
    id: `evt_${seq}` as DomainEvent["id"],
    seq,
    occurredAt: 0,
    author: humanAuthor,
    entity: "session",
    verb: "updated",
    session: target,
    status: {
      phase,
      facts: phaseFacts(phase),
      health: { silentForMs: 0, possiblyStalled: false },
    },
  };
  return JSON.stringify({ type: "event", event });
}

describe("createApiSessionDataSource", () => {
  it("loadList reads GET /api/sessions, no socket involved", async () => {
    const target = session("sess-1");
    const get = vi.fn(async (path: string) => {
      expect(path).toBe("/api/sessions");
      return {
        sessions: [
          {
            session: target,
            runId: null,
            workspaceId: null,
            phase: { kind: "idle" },
            end: null,
          },
        ],
      };
    });
    const http = { get } as unknown as HttpClient;
    const createSocket = vi.fn() as unknown as WebSocketFactory;

    const source = createApiSessionDataSource({ http, createSocket });
    expect((await source.loadList()).map((s) => s.id)).toEqual(["sess-1"]);
    expect(createSocket).not.toHaveBeenCalled();
  });

  it("loadTranscript reads GET /api/sessions/:id/transcript", async () => {
    const get = vi.fn(async (path: string) => {
      expect(path).toBe("/api/sessions/sess-1/transcript");
      return {
        sessionId: "sess-1",
        turns: [{ ordinal: 1, startedAt: 1, entries: [] }],
      };
    });
    const http = { get } as unknown as HttpClient;
    const source = createApiSessionDataSource({
      http,
      createSocket: vi.fn() as unknown as WebSocketFactory,
    });
    const transcript = await source.loadTranscript("sess-1" as SessionId);
    expect(transcript.turns).toHaveLength(1);
  });

  it("loadReleasedContent always resolves null (no server release mechanism yet)", async () => {
    const source = createApiSessionDataSource({
      http: {} as HttpClient,
      createSocket: vi.fn() as unknown as WebSocketFactory,
    });
    expect(
      await source.loadReleasedContent("sess-1" as SessionId, "call-1", {
        releasedAt: 1,
        bytes: 1,
        contentHash: "h",
      }),
    ).toBeNull();
  });

  it("subscribeSession connects, buffers, resyncs off /api/snapshot, then applies the rest", async () => {
    const target = session("sess-1");
    const socket = fakeSocket();
    const createSocket: WebSocketFactory = vi.fn(() => socket);
    const get = vi.fn(async (path: string) => {
      expect(path).toBe("/api/snapshot");
      return {
        seq: 5,
        sessions: [{ session: target, runId: null, phase: { kind: "idle" } }],
      };
    });
    const http = { get } as unknown as HttpClient;

    const source = createApiSessionDataSource({ http, createSocket });
    const onDetail = vi.fn();
    source.subscribeSession("sess-1" as SessionId, onDetail);

    socket.onopen?.();
    // Buffered before the snapshot lands: seq 3 is already reflected (<=5),
    // seq 6 is not and must be applied after.
    socket.onmessage?.({
      data: sessionEventMessage(3, target, {
        kind: "tool-running",
        toolName: "bash",
      }),
    });
    socket.onmessage?.({
      data: sessionEventMessage(6, target, { kind: "responding" }),
    });
    await flush();

    const phases = onDetail.mock.calls.map((call) => call[0].status.phase.kind);
    expect(phases.at(-1)).toBe("responding");
    expect(phases).not.toContain("tool-running");
  });

  it("subscribeTranscript fetches once, then refetches on a session_observation event", async () => {
    const socket = fakeSocket();
    const createSocket: WebSocketFactory = vi.fn(() => socket);
    let turnCount = 1;
    const get = vi.fn(async (path: string) => {
      if (path === "/api/snapshot") return { seq: 0, sessions: [] };
      expect(path).toBe("/api/sessions/sess-1/transcript");
      return {
        sessionId: "sess-1",
        turns: Array.from({ length: turnCount }, (_, i) => ({
          ordinal: i + 1,
          startedAt: i,
          entries: [],
        })),
      };
    });
    const http = { get } as unknown as HttpClient;

    const source = createApiSessionDataSource({ http, createSocket });
    const onEvent = vi.fn();
    source.subscribeTranscript("sess-1" as SessionId, onEvent);
    await flush();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0].transcript.turns).toHaveLength(1);

    socket.onopen?.();
    await flush();

    turnCount = 2;
    const observation: DomainEvent = {
      id: "evt_1" as DomainEvent["id"],
      seq: 1,
      occurredAt: 0,
      author: humanAuthor,
      entity: "session_observation",
      verb: "created",
      sessionId: "sess-1" as SessionId,
      seqInSession: 1,
      observation: { kind: "turn-started", turn: 2, at: 0 },
    };
    socket.onmessage?.({
      data: JSON.stringify({ type: "event", event: observation }),
    });
    await flush();

    expect(onEvent.mock.calls.at(-1)?.[0].transcript.turns).toHaveLength(2);
  });

  it("unsubscribing the last listener closes the socket", async () => {
    const socket = fakeSocket();
    const createSocket: WebSocketFactory = vi.fn(() => socket);
    const http = {
      get: vi.fn(async () => ({ seq: 0, sessions: [] })),
    } as unknown as HttpClient;

    const source = createApiSessionDataSource({ http, createSocket });
    const unsubscribe = source.subscribeSession("sess-1" as SessionId, vi.fn());
    await flush();
    unsubscribe();
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("loadInjections reads GET /api/sessions/:id/injections", async () => {
    const get = vi.fn(async (path: string) => {
      expect(path).toBe("/api/sessions/sess-1/injections");
      return {
        sessionId: "sess-1",
        injections: [
          {
            id: "inj-1",
            text: "stop grepping",
            queuedAt: 1,
            deliveredAt: null,
            refusedAt: null,
          },
        ],
      };
    });
    const http = { get } as unknown as HttpClient;
    const source = createApiSessionDataSource({
      http,
      createSocket: vi.fn() as unknown as WebSocketFactory,
    });
    const injections = await source.loadInjections("sess-1" as SessionId);
    expect(injections).toHaveLength(1);
    expect(injections[0]?.id).toBe("inj-1");
  });

  it("subscribeInjections fetches once, then refetches on the session's own updated event (not session_observation)", async () => {
    const target = session("sess-1");
    const socket = fakeSocket();
    const createSocket: WebSocketFactory = vi.fn(() => socket);
    let delivered = false;
    const get = vi.fn(async (path: string) => {
      if (path === "/api/snapshot") return { seq: 0, sessions: [] };
      expect(path).toBe("/api/sessions/sess-1/injections");
      return {
        sessionId: "sess-1",
        injections: [
          {
            id: "inj-1",
            text: "stop grepping",
            queuedAt: 1,
            deliveredAt: delivered ? 2 : null,
            refusedAt: null,
          },
        ],
      };
    });
    const http = { get } as unknown as HttpClient;

    const source = createApiSessionDataSource({ http, createSocket });
    const onEvent = vi.fn();
    source.subscribeInjections("sess-1" as SessionId, onEvent);
    await flush();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0].injections[0]?.deliveredAt).toBeNull();

    socket.onopen?.();
    await flush();

    // A session_observation event must NOT trigger a refetch — delivery
    // rides the session's own updated event, not its observation log.
    const observation: DomainEvent = {
      id: "evt_obs" as DomainEvent["id"],
      seq: 1,
      occurredAt: 0,
      author: humanAuthor,
      entity: "session_observation",
      verb: "created",
      sessionId: "sess-1" as SessionId,
      seqInSession: 1,
      observation: { kind: "turn-started", turn: 2, at: 0 },
    };
    socket.onmessage?.({
      data: JSON.stringify({ type: "event", event: observation }),
    });
    await flush();
    expect(onEvent).toHaveBeenCalledTimes(1);

    delivered = true;
    socket.onmessage?.({ data: sessionEventMessage(2, target) });
    await flush();

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls.at(-1)?.[0].injections[0]?.deliveredAt).toBe(2);
  });
});
