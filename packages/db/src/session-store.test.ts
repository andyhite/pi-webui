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
import { ObjectStore } from "./object-store.js";
import { SessionStore } from "./session-store.js";
import { WorkstreamStore } from "./workstream-store.js";

let dir: string;
let state: PlotroomDatabase;
let clock: ManualClock;
let sessions: SessionStore;
let graph: GraphStore;
let objects: ObjectStore;
let workstreamId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-sessions-"));
  state = openDatabase({ stateDir: dir });
  clock = manualClock();
  sessions = new SessionStore(state, clock.now);
  graph = new GraphStore(state, clock.now);
  objects = new ObjectStore(state, clock.now);
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

/**
 * A session record is deletable, always — and recoverable, because deletion is
 * recoverable for authored state (§3.6, principle 10).
 */
describe("deleting a session record", () => {
  it("soft-deletes, and the record stays readable", () => {
    const { session } = startSession();

    const deleted = sessions.delete(session.id);

    expect(deleted.session.deletion.deletedAt).toBe(clock.now());
    // §3.6's "readable ... always" is not qualified by deletion.
    expect(sessions.get(session.id).session.id).toBe(session.id);
  });

  it("leaves the observation log — the record itself — alone", () => {
    const { session } = startSession();
    sessions.appendObservation(session.id, {
      kind: "turn-started",
      at: millis(),
      turn: 1,
    });

    sessions.delete(session.id);

    // Decision 0001: the log *is* the record, so a restore that lost it would
    // put back a session in name only.
    expect(sessions.observationRecords(session.id)).toHaveLength(1);
  });

  it("drops out of the default list and comes back on request", () => {
    const { session } = startSession();
    sessions.delete(session.id);

    expect(sessions.list().map((s) => s.session.id)).toEqual([]);
    expect(
      sessions.list({ includeDeleted: true }).map((s) => s.session.id),
    ).toEqual([session.id]);
  });

  it("keeps the first deletion's time when deleted twice", () => {
    const { session } = startSession();
    const first = sessions.delete(session.id).session.deletion.deletedAt;

    clock.advance(60);
    expect(sessions.delete(session.id).session.deletion.deletedAt).toBe(first);
  });

  it("restores, and lists what the undo verb can put back", () => {
    const live = startSession().session;
    const gone = startSession({
      runtime: { adapterId: "scripted", ref: "native-2" },
    }).session;
    sessions.delete(gone.id);

    expect(sessions.deleted().map((s) => s.session.id)).toEqual([gone.id]);

    const restored = sessions.restore(gone.id);
    expect(restored.session.deletion.deletedAt).toBeNull();
    expect(sessions.deleted()).toEqual([]);
    expect(
      sessions
        .list()
        .map((s) => s.session.id)
        .sort(),
    ).toEqual([live.id, gone.id].sort());
  });

  it("is not what `inFlight` reports, so a restart interrupts nothing deleted", () => {
    const { session } = startSession();
    sessions.delete(session.id);

    // Principle 11 reports in-flight work as interrupted at boot; a deleted
    // record is not work in flight.
    expect(sessions.inFlight()).toEqual([]);
  });

  it("refuses to delete a session it has never seen", () => {
    expect(() => sessions.delete("sess-nope")).toThrowError();
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

describe("the plan (§3.6, §3.1)", () => {
  it("stays null until the first plan-updated observation, then versions on the transcript's own event", () => {
    const { session } = startSession();

    append(session.id, {
      kind: "turn-started",
      turn: 1,
      at: millis(),
    });

    // A turn publishes nothing, and there is no plan yet either way.
    expect(
      sessions.publishTranscript(session.id, {
        kind: "turn-ended",
        at: clock.now(),
        turn: 1,
      }),
    ).toBeNull();

    append(
      session.id,
      {
        kind: "plan-updated",
        at: millis(),
        phases: [
          {
            name: "Implementation",
            tasks: [{ content: "wire the route", status: "in_progress" }],
          },
        ],
      },
      {
        kind: "turn-ended",
        turn: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
        at: millis(),
      },
    );

    const published = sessions.publishTranscript(session.id, {
      kind: "checkpoint",
      at: clock.now(),
      by: humanAuthor,
    });

    expect(published?.planObjectId).not.toBeNull();
    expect(sessions.get(session.id).planObjectId).toBe(published?.planObjectId);
    expect(
      objects.read(published?.planObjectId as string).renderings.agentContent,
    ).toContain("wire the route");
  });

  it("re-versions the same plan object rather than writing a second one", () => {
    const { session } = startSession();

    append(
      session.id,
      {
        kind: "plan-updated",
        at: millis(),
        phases: [
          {
            name: "Implementation",
            tasks: [{ content: "wire the route", status: "in_progress" }],
          },
        ],
      },
      {
        kind: "turn-ended",
        turn: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
        at: millis(),
      },
    );
    const first = sessions.publishTranscript(session.id, {
      kind: "checkpoint",
      at: clock.now(),
      by: humanAuthor,
    });

    append(
      session.id,
      {
        kind: "plan-updated",
        at: millis(),
        phases: [
          {
            name: "Implementation",
            tasks: [{ content: "wire the route", status: "completed" }],
          },
        ],
      },
      {
        kind: "turn-ended",
        turn: 2,
        usage: { inputTokens: 1, outputTokens: 1 },
        at: millis(),
      },
    );
    const second = sessions.publishTranscript(session.id, {
      kind: "checkpoint",
      at: clock.now(),
      by: humanAuthor,
    });

    expect(second?.planObjectId).toBe(first?.planObjectId);
    expect(second?.planVersionId).not.toBe(first?.planVersionId);
    expect(
      objects.read(second?.planObjectId as string).renderings.agentContent,
    ).toContain("[x] wire the route");
  });

  it("reads the live log, not the last published version (§7.2's need to see a block immediately)", () => {
    const { session } = startSession();

    append(session.id, {
      kind: "plan-updated",
      at: millis(),
      phases: [
        {
          name: "Implementation",
          tasks: [
            {
              content: "ship it",
              status: "blocked",
              blocker: "waiting on review",
            },
          ],
        },
      ],
    });

    // Nothing has been checkpointed — sessions.get(session.id).planObjectId
    // is still null — but the live read already sees the block.
    expect(sessions.get(session.id).planObjectId).toBeNull();
    expect(sessions.blockedTasks(session.id)).toEqual([
      {
        phaseName: "Implementation",
        content: "ship it",
        blocker: "waiting on review",
        since: expect.any(Number),
      },
    ]);
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
      failedConditionIds: ["checks_green"],
      queuedAt: clock.now(),
    });

    expect(feedback.author).toBeNull();
    expect(feedback.nodeId).toBeNull();
    expect(feedback.failedConditionIds).toEqual(["checks_green"]);

    sessions.markDelivered("inj-fb", clock.now());
    sessions.appendObservation(session.id, {
      kind: "injection-delivered",
      injectionId: "inj-fb" as never,
      at: millis(),
    });

    // Its own entry kind, not an injection with an invented author: the loop
    // §3.5 describes is visible in the transcript, and the conditions that were
    // false are named rather than left inside the sentence (§6.1).
    const { transcript } = sessions.transcript(session.id as SessionId);
    expect(transcript.turns.flatMap((turn) => turn.entries)).toEqual([
      {
        kind: "feedback",
        source: "world-condition",
        text: "checks_green: the checks are red",
        failedConditionIds: ["checks_green"],
      },
    ]);
  });

  it("renders steering as an authored injection, feedback as neither", () => {
    const { session } = startSession();
    const node = graph.place({
      role: "content",
      refId: "obj-steering",
      workstreamId,
    });

    sessions.queueInjection({
      id: "inj-steer" as never,
      sessionId: session.id,
      origin: "steering",
      author: humanAuthor,
      nodeId: node.id,
      text: "look at this too",
      queuedAt: clock.now(),
    });
    sessions.queueInjection({
      id: "inj-fb" as never,
      sessionId: session.id,
      origin: "condition-feedback",
      text: "output_written: out.txt does not exist",
      failedConditionIds: ["output_written"],
      queuedAt: clock.now(),
    });

    for (const id of ["inj-steer", "inj-fb"]) {
      sessions.markDelivered(id, clock.now());
      sessions.appendObservation(session.id, {
        kind: "injection-delivered",
        injectionId: id as never,
        at: millis(),
      });
    }

    const { transcript } = sessions.transcript(session.id as SessionId);
    const kinds = transcript.turns
      .flatMap((turn) => turn.entries)
      .map((entry) => entry.kind);

    // Two things delivered the same way, recorded as the two different things
    // they are: intent, and proof.
    expect(kinds).toEqual(["injection", "feedback"]);
  });
});
