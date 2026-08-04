import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  humanAuthor,
  sessionAuthor,
  INHERIT_APP_TOOLS,
  type SessionId,
} from "@plotroom/core";
import { manualClock, type ManualClock } from "@plotroom/core/testing";
import { openDatabase, type PlotroomDatabase } from "@plotroom/db";
import { createEventBus } from "../events/bus.js";
import { ApiError } from "../http/errors.js";
import { createStores, type ApiStores } from "../routes/api.js";
import { performDestruction } from "./destruction.js";

/**
 * The backstop under the destruction guard (§6.6, principle 10).
 *
 * The guard is what routes a session's destructive gesture through an approval;
 * this is what catches a call that never went through it. `checkDeletion` is
 * `@plotroom/core`'s predicate and it refuses a session-authored deletion with no
 * approval behind it — so a future call site that forgets the routing fails
 * closed rather than deleting, which is the property the guard's own docstring
 * now claims and this proves.
 */
let dir: string;
let state: PlotroomDatabase;
let clock: ManualClock;
let stores: ApiStores;
let workstreamId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-destruction-"));
  state = openDatabase({ stateDir: dir });
  clock = manualClock();
  stores = createStores(state, createEventBus(clock.now), clock.now);
  workstreamId = stores.workstreams.create({ author: humanAuthor }).id;
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The stop a session's deletion performs (§3.6). Records what it was asked to
 * stop and ends the record the way §6.7's stop does, so a test can tell "the
 * gesture stopped it" from "the gesture found it already ended".
 */
function stopper(): {
  readonly stop: (sessionId: string) => Promise<void>;
  readonly stopped: string[];
} {
  const stopped: string[] = [];
  return {
    stopped,
    stop: async (sessionId) => {
      stopped.push(sessionId);
      stores.sessions.end(sessionId, {
        kind: "stopped",
        by: "user",
        at: clock.now(),
      });
    },
  };
}

function session(): string {
  return stores.sessions.start({
    workstreamId,
    mode: "open",
    launch: {
      model: "fixture-model",
      effort: "medium",
      toolPermissions: INHERIT_APP_TOOLS,
    },
    initiatedBy: humanAuthor,
    runtime: { adapterId: "scripted", ref: `native-${clock.now()}` },
  }).session.id;
}

function note(): string {
  return stores.objects.write({
    kind: "note",
    title: "the arrangement",
    renderings: {
      card: { title: "the arrangement" },
      summary: "the arrangement",
      agentContent: "something the operator authored",
    },
    workstreamId,
  }).objectId;
}

describe("performDestruction", () => {
  it("refuses a session's destruction with no approval behind it", async () => {
    const objectId = note();
    const agent = sessionAuthor("sess-1" as SessionId);

    await expect(
      performDestruction(stores, stores.bus, "object", objectId, agent, {
        stopSession: stopper().stop,
      }),
    ).rejects.toThrowError(ApiError);
    // Nothing was removed: the refusal is before the effect, not after it.
    expect(stores.objects.get(objectId)?.deletedAt).toBeNull();
  });

  it("performs it once the caller states an operator approved", async () => {
    const objectId = note();
    const agent = sessionAuthor("sess-1" as SessionId);

    const outcome = await performDestruction(
      stores,
      stores.bus,
      "object",
      objectId,
      agent,
      { approved: true, stopSession: stopper().stop },
    );

    expect(outcome.changed).toBe(true);
    expect(stores.objects.get(objectId)?.deletedAt).not.toBeNull();
  });

  it("never gates the operator, who is the authority §6.6 terminates at", async () => {
    const objectId = note();

    const outcome = await performDestruction(
      stores,
      stores.bus,
      "object",
      objectId,
      humanAuthor,
      { stopSession: stopper().stop },
    );

    expect(outcome.changed).toBe(true);
    expect(stores.objects.get(objectId)?.deletedAt).not.toBeNull();
  });
});

/**
 * Deleting a session record (§3.6, issue #42).
 *
 * "Readable, resumable, forkable, deletable, always" — including while it is
 * live, which is why the gesture stops it rather than refusing, and why the stop
 * is a recorded end state rather than a side effect nobody can see.
 */
describe("destroying a session", () => {
  it("stops a live one first, so no runtime outlives its record", async () => {
    const sessionId = session();
    const stop = stopper();

    const outcome = await performDestruction(
      stores,
      stores.bus,
      "session",
      sessionId,
      humanAuthor,
      { stopSession: stop.stop },
    );

    expect(outcome.changed).toBe(true);
    expect(stop.stopped).toEqual([sessionId]);
    // The end is on the record, so a restore gives back a session that says how
    // it ended rather than one still claiming to be live.
    expect(stores.sessions.get(sessionId).session.end?.kind).toBe("stopped");
    expect(
      stores.sessions.get(sessionId).session.deletion.deletedAt,
    ).not.toBeNull();
  });

  it("stops nothing when the session already ended", async () => {
    const sessionId = session();
    stores.sessions.end(sessionId, {
      kind: "completed",
      at: clock.now(),
    });
    const stop = stopper();

    await performDestruction(
      stores,
      stores.bus,
      "session",
      sessionId,
      humanAuthor,
      { stopSession: stop.stop },
    );

    expect(stop.stopped).toEqual([]);
    // The outcome it ended with is the outcome it keeps: a deletion is not a
    // second end state (§3.6's taxonomy is closed).
    expect(stores.sessions.get(sessionId).session.end?.kind).toBe("completed");
  });

  it("keeps the record readable, and the log under it intact", async () => {
    const sessionId = session();
    stores.sessions.appendObservation(sessionId, {
      kind: "turn-started",
      at: clock.now(),
      turn: 1,
    });

    await performDestruction(
      stores,
      stores.bus,
      "session",
      sessionId,
      humanAuthor,
      { stopSession: stopper().stop },
    );

    // §3.6: readable *always*. The observation log is the record (decision
    // 0001), so a restore that lost it would put back a session in name only.
    expect(stores.sessions.get(sessionId).session.id).toBe(sessionId);
    expect(stores.sessions.observationRecords(sessionId)).toHaveLength(1);
  });

  it("takes the node and its wires off the board, and puts them back", async () => {
    const sessionId = session();
    const node = stores.graph.place({
      role: "session",
      refId: sessionId,
      workstreamId,
      // §3.7: content wires into a *running* session and nothing else.
      running: true,
    });
    // A real wire into the session, so the cascade has something to take:
    // injecting into a running session is a context edge like any other (§6.5).
    const source = stores.graph.place({
      role: "content",
      refId: note(),
      workstreamId,
    });
    const edge = stores.graph.addContextEdge({
      from: source.id,
      to: node.id,
      author: humanAuthor,
    });

    await performDestruction(
      stores,
      stores.bus,
      "session",
      sessionId,
      humanAuthor,
      { stopSession: stopper().stop },
    );
    expect(stores.graph.node(node.id).deletedAt).not.toBeNull();
    // The wire goes with the node, or the board draws an edge to nothing.
    expect(stores.graph.edge(edge.id).deletedAt).not.toBeNull();

    stores.sessions.restore(sessionId);
    stores.graph.restoreNode(node.id);
    expect(stores.graph.node(node.id).deletedAt).toBeNull();
    expect(stores.graph.edge(edge.id).deletedAt).toBeNull();
    expect(
      stores.sessions.get(sessionId).session.deletion.deletedAt,
    ).toBeNull();
  });

  it("announces the deletion once when two gestures race it", async () => {
    const sessionId = session();
    const deletions: string[] = [];
    stores.bus.subscribe((event) => {
      if (event.entity === "session" && event.verb === "deleted") {
        deletions.push(event.sessionId);
      }
    });

    // The second gesture lands while the first is suspended in its stop — the
    // one interleaving the awaited stop makes reachable.
    const slow = performDestruction(
      stores,
      stores.bus,
      "session",
      sessionId,
      humanAuthor,
      {
        stopSession: async (id) => {
          stores.sessions.end(id, {
            kind: "stopped",
            by: "user",
            at: clock.now(),
          });
          await performDestruction(
            stores,
            stores.bus,
            "session",
            sessionId,
            humanAuthor,
            { stopSession: stopper().stop },
          );
        },
      },
    );

    // One deletion happened, so one deletion is announced and only one gesture
    // reports having changed anything.
    expect((await slow).changed).toBe(false);
    expect(deletions).toEqual([sessionId]);
  });

  it("is idempotent: a second delete changes nothing and stops nothing", async () => {
    const sessionId = session();
    await performDestruction(
      stores,
      stores.bus,
      "session",
      sessionId,
      humanAuthor,
      { stopSession: stopper().stop },
    );

    const again = stopper();
    const outcome = await performDestruction(
      stores,
      stores.bus,
      "session",
      sessionId,
      humanAuthor,
      { stopSession: again.stop },
    );

    expect(outcome.changed).toBe(false);
    expect(again.stopped).toEqual([]);
  });

  it("refuses a session's deletion with no approval behind it", async () => {
    const sessionId = session();
    const agent = sessionAuthor("sess-1" as SessionId);
    const stop = stopper();

    await expect(
      performDestruction(stores, stores.bus, "session", sessionId, agent, {
        stopSession: stop.stop,
      }),
    ).rejects.toThrowError(ApiError);
    // Fails closed *before* the stop: a refused deletion must not have ended
    // somebody's work on its way to being refused.
    expect(stop.stopped).toEqual([]);
    expect(stores.sessions.get(sessionId).session.end).toBeNull();
    expect(
      stores.sessions.get(sessionId).session.deletion.deletedAt,
    ).toBeNull();
  });
});
