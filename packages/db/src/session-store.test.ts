import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  humanAuthor,
  sessionAuthor,
  INHERIT_APP_TOOLS,
  type RuntimeObservation,
  type SessionId,
} from "@plotroom/core";
import { manualClock, type ManualClock } from "@plotroom/core/testing";
import { openDatabase, type PlotroomDatabase } from "./client.js";
import { GraphStore } from "./graph-store.js";
import { SessionStore } from "./session-store.js";
import { WorkstreamStore } from "./workstream-store.js";

let dir: string;
let state: PlotroomDatabase;
let clock: ManualClock;
let sessions: SessionStore;
let graph: GraphStore;
let workstreamId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-sessions-"));
  state = openDatabase({ stateDir: dir });
  clock = manualClock();
  sessions = new SessionStore(state, clock.now);
  graph = new GraphStore(state, clock.now);
  workstreamId = new WorkstreamStore(state, clock.now).create({
    author: humanAuthor,
  }).id;
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

function startSession(overrides: Record<string, unknown> = {}) {
  return sessions.start({
    workstreamId,
    mode: "open",
    launch: {
      model: "fixture-model",
      effort: "medium",
      toolPermissions: INHERIT_APP_TOOLS,
    },
    initiatedBy: humanAuthor,
    runtime: { adapterId: "scripted", ref: "native-1" },
    ...overrides,
  });
}

/** Observations are stamped in milliseconds by the adapter (decision 0001). */
function millis(): number {
  return clock.now() * 1000;
}

function append(sessionId: string, ...observations: RuntimeObservation[]) {
  for (const observation of observations) {
    sessions.appendObservation(sessionId, observation);
  }
}

describe("session records", () => {
  it("stores launch choices, accounting, and a live end of null", () => {
    const { session } = startSession();

    expect(session.end).toBeNull();
    expect(session.launch.model).toBe("fixture-model");
    expect(session.launch.toolPermissions.allowedTools).toBeNull();
    expect(session.accounting.turns).toBe(0);
    expect(sessions.get(session.id).session).toEqual(session);
  });

  it("writes the initiation chain, so the reflexivity rule reads real data", () => {
    const parent = startSession().session;
    const child = startSession({
      initiatedBy: sessionAuthor(parent.id),
    }).session;

    const index = graph.lineageIndex();
    expect(index.parentOf(child.id)).toBe(parent.id);
    expect(index.parentOf(parent.id)).toBeNull();
  });

  it("narrows tool permissions as a list, never a null that means none", () => {
    const { session } = startSession({
      launch: {
        model: "fixture-model",
        effort: "high",
        toolPermissions: { allowedTools: ["read", "write"] },
      },
    });

    expect(session.launch.toolPermissions.allowedTools).toEqual([
      "read",
      "write",
    ]);
  });
});

describe("the observation log", () => {
  it("derives the phase from what was observed, never from a report", () => {
    const { session } = startSession();

    append(
      session.id,
      { kind: "turn-started", turn: 1, at: millis() },
      { kind: "reasoning-delta", text: "thinking about it", at: millis() },
    );

    expect(sessions.status(session.id, { now: millis() }).phase).toEqual({
      kind: "thinking",
    });

    append(session.id, {
      kind: "tool-started",
      toolName: "write_file",
      callId: "call-1",
      input: { path: "a.txt" },
      at: millis(),
    });

    expect(sessions.status(session.id, { now: millis() }).phase).toEqual({
      kind: "tool-running",
      toolName: "write_file",
    });
  });

  it("folds accounting out of observed turns and snapshots it on the row", () => {
    const { session } = startSession();

    append(
      session.id,
      { kind: "turn-started", turn: 1, at: millis() },
      {
        kind: "turn-ended",
        turn: 1,
        usage: { inputTokens: 100, outputTokens: 40, costUsd: 0.5 },
        at: millis(),
      },
    );

    const observed = sessions.observationState(session.id);
    expect(observed.accounting.turns).toBe(1);
    expect(observed.accounting.costBasis).toBe("runtime-reported");

    const stored = sessions.saveDerived(
      session.id,
      observed,
      sessions.status(session.id, { now: millis() }).phase,
    );

    expect(stored.session.accounting.tokens.input).toBe(100);
    expect(stored.session.accounting.costUsd).toBeCloseTo(0.5, 6);
    expect(stored.session.accounting.costBasis).toBe("runtime-reported");
    expect(stored.phase).toEqual({ kind: "waiting-input" });
  });

  it("numbers the log per session, in append order", () => {
    const first = startSession().session;
    const second = startSession().session;

    append(first.id, { kind: "compaction-started", at: millis() });
    append(second.id, { kind: "compaction-started", at: millis() });
    append(first.id, { kind: "compaction-finished", at: millis() });

    expect(sessions.observationRecords(first.id).map((r) => r.seq)).toEqual([
      1, 2,
    ]);
    expect(sessions.observationRecords(second.id).map((r) => r.seq)).toEqual([
      1,
    ]);
  });
});

describe("end states", () => {
  it("keeps the first outcome, so a doubled observation cannot rewrite it", () => {
    const { session } = startSession();

    sessions.end(session.id, {
      kind: "out-of-budget",
      scope: "workstream",
      at: clock.now(),
    });
    sessions.end(session.id, { kind: "stopped", by: "user", at: clock.now() });

    expect(sessions.get(session.id).session.end).toEqual({
      kind: "out-of-budget",
      scope: "workstream",
      at: clock.now(),
    });
  });

  it("interrupts every in-flight session at a restart, distinctly", () => {
    const running = startSession().session;
    const failed = startSession().session;
    sessions.end(failed.id, {
      kind: "failed",
      message: "boom",
      at: clock.now(),
    });

    clock.advance(10);
    const interrupted = sessions.interruptInFlight("the server restarted");

    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]?.session.id).toBe(running.id);
    expect(sessions.get(running.id).session.end).toEqual({
      kind: "interrupted",
      message: "the server restarted",
      at: clock.now(),
    });
    // Not rewritten into an interruption: it already failed.
    expect(sessions.get(failed.id).session.end?.kind).toBe("failed");
    expect(sessions.inFlight()).toHaveLength(0);
  });

  it("takes a session node off running when it ends (§3.7)", () => {
    const { session } = startSession();
    const node = graph.place({
      role: "session",
      refId: session.id,
      workstreamId,
      running: true,
    });

    sessions.end(session.id, { kind: "ended-by-user", at: clock.now() });

    expect(graph.node(node.id).running).toBe(false);
  });
});

describe("the transcript", () => {
  it("projects turns out of the log, coalescing streamed deltas", () => {
    const { session } = startSession();

    append(
      session.id,
      { kind: "turn-started", turn: 1, at: millis() },
      { kind: "output-delta", text: "hello ", at: millis() },
      { kind: "output-delta", text: "world", at: millis() },
      {
        kind: "tool-started",
        toolName: "read_file",
        callId: "c1",
        input: { path: "a" },
        at: millis(),
      },
      {
        kind: "tool-finished",
        callId: "c1",
        output: "contents",
        isError: false,
        at: millis(),
      },
      {
        kind: "turn-ended",
        turn: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
        at: millis(),
      },
    );

    const { transcript, completedTurns } = sessions.transcript(session.id);
    expect(completedTurns).toBe(1);
    expect(transcript.turns).toHaveLength(1);
    expect(transcript.turns[0]?.entries).toEqual([
      { kind: "output", text: "hello world" },
      {
        kind: "tool-call",
        callId: "c1",
        toolName: "read_file",
        input: '{"path":"a"}',
      },
      {
        kind: "tool-result",
        callId: "c1",
        toolName: "read_file",
        output: "contents",
        isError: false,
        released: null,
      },
    ]);
  });

  it("versions on checkpoint and on end, never per turn", () => {
    const { session } = startSession();

    append(
      session.id,
      { kind: "turn-started", turn: 1, at: millis() },
      { kind: "output-delta", text: "first", at: millis() },
      {
        kind: "turn-ended",
        turn: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
        at: millis(),
      },
    );

    // A turn publishes nothing: consumers would drift per turn otherwise.
    expect(
      sessions.publishTranscript(session.id, {
        kind: "turn-ended",
        at: clock.now(),
        turn: 1,
      }),
    ).toBeNull();
    expect(sessions.publications(session.id)).toHaveLength(0);

    const published = sessions.publishTranscript(session.id, {
      kind: "checkpoint",
      at: clock.now(),
      by: humanAuthor,
    });

    expect(published?.publication.ordinal).toBe(1);
    expect(published?.publication.throughTurn).toBe(1);
    expect(sessions.get(session.id).transcriptObjectId).toBe(
      published?.objectId,
    );

    // Nothing pending: an empty version would drift every consumer for nothing.
    expect(
      sessions.publishTranscript(session.id, {
        kind: "checkpoint",
        at: clock.now(),
        by: humanAuthor,
      }),
    ).toBeNull();

    append(
      session.id,
      { kind: "turn-started", turn: 2, at: millis() },
      { kind: "output-delta", text: "second", at: millis() },
      {
        kind: "turn-ended",
        turn: 2,
        usage: { inputTokens: 1, outputTokens: 1 },
        at: millis(),
      },
    );

    const onEnd = sessions.publishTranscript(session.id, {
      kind: "session-ended",
      at: clock.now(),
      end: { kind: "completed", at: clock.now() },
    });

    expect(onEnd?.publication.ordinal).toBe(2);
    expect(onEnd?.publication.throughTurn).toBe(2);
    expect(onEnd?.publication.trigger).toBe("session-end");
    expect(sessions.publications(session.id)).toHaveLength(2);
  });
});

describe("the injection ledger", () => {
  it("keeps queued and delivered as two facts (§6.5)", () => {
    const { session } = startSession();
    const node = graph.place({
      role: "content",
      refId: "obj-not-real",
      workstreamId,
    });

    const queued = sessions.queueInjection({
      id: "inj-1" as never,
      sessionId: session.id,
      origin: "steering",
      author: humanAuthor,
      nodeId: node.id,
      text: "look at this too",
      queuedAt: clock.now(),
    });

    expect(queued.deliveredAt).toBeNull();

    clock.advance(5);
    const delivered = sessions.markDelivered("inj-1", clock.now());
    expect(delivered.deliveredAt).toBe(clock.now());

    // Delivery happens once; a replayed observation does not move it.
    clock.advance(5);
    expect(sessions.markDelivered("inj-1", clock.now()).deliveredAt).toBe(
      delivered.deliveredAt,
    );
  });

  it("records the product's own condition feedback with no author to claim", () => {
    const { session } = startSession();

    const feedback = sessions.queueInjection({
      id: "inj-fb" as never,
      sessionId: session.id,
      origin: "condition-feedback",
      text: "checks_green: the checks are red",
      queuedAt: clock.now(),
    });

    expect(feedback.author).toBeNull();
    expect(feedback.nodeId).toBeNull();

    // Authored steering becomes a transcript entry; feedback has no author to
    // attribute, so it is recorded on the run instead of forged into one.
    sessions.markDelivered("inj-fb", clock.now());
    sessions.appendObservation(session.id, {
      kind: "injection-delivered",
      injectionId: "inj-fb" as never,
      at: millis(),
    });

    const { transcript } = sessions.transcript(session.id as SessionId);
    expect(transcript.turns.flatMap((turn) => turn.entries)).toHaveLength(0);
  });
});
