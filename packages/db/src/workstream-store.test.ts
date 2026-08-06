import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  humanAuthor,
  sessionAuthor,
  EMPTY_ATTENTION,
  type SessionId,
} from "@plotroom/core";
import {
  makeRenderings,
  manualClock,
  type ManualClock,
} from "@plotroom/core/testing";
import { openDatabase, type PlotroomDatabase } from "./client.js";
import { ObjectStore } from "./object-store.js";
import { GraphStore } from "./graph-store.js";
import { LifecycleRefused, WorkstreamStore } from "./workstream-store.js";

let dir: string;
let state: PlotroomDatabase;
let store: WorkstreamStore;
let clock: ManualClock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-workstreams-"));
  state = openDatabase({ stateDir: dir });
  clock = manualClock();
  store = new WorkstreamStore(state, clock.now);
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("identity: the subject is authored and optional (§3.3)", () => {
  it("creates a subject-less scratch workstream", () => {
    const scratch = store.create({ author: humanAuthor });

    expect(scratch.subjectObjectId).toBeNull();
    expect(scratch.status).toBe("active");
    expect(scratch.archivedAt).toBeNull();
  });

  it("takes its identity from a dragged-in subject", () => {
    const objects = new ObjectStore(state, clock.now);
    const ticket = objects.write({
      kind: "ticket",
      title: "OXY-2982",
      renderings: makeRenderings(),
    });

    const stream = store.create({
      author: humanAuthor,
      subjectId: ticket.objectId,
    });

    expect(stream.subjectObjectId).toBe(ticket.objectId);
  });

  it("records who set the subject", () => {
    const objects = new ObjectStore(state, clock.now);
    const ticket = objects.write({
      kind: "ticket",
      title: "OXY-2982",
      renderings: makeRenderings(),
    });

    const scratch = store.create({ author: humanAuthor });
    store.setSubject(
      scratch.id,
      ticket.objectId,
      sessionAuthor("sess_peer" as SessionId),
    );

    const events = store.events(scratch.id);
    expect(events.map((event) => event.kind)).toEqual([
      "created",
      "subject_set",
    ]);
    expect(events[1]?.value).toBe(ticket.objectId);
    expect(events[1]?.authorKind).toBe("session");
    expect(events[1]?.authorSession).toBe("sess_peer");
  });

  it("refuses a subject that is not an object", () => {
    expect(() =>
      store.create({ author: humanAuthor, subjectId: "obj_nowhere" }),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe("lifecycle is authored, never automatic (§3.3)", () => {
  it("lets the human set every state", () => {
    const stream = store.create({ author: humanAuthor });

    expect(store.setStatus(stream.id, "done", humanAuthor).status).toBe("done");
    expect(store.setStatus(stream.id, "abandoned", humanAuthor).status).toBe(
      "abandoned",
    );
    expect(store.setStatus(stream.id, "active", humanAuthor).status).toBe(
      "active",
    );
  });

  it("refuses a session setting lifecycle directly", () => {
    const stream = store.create({ author: humanAuthor });

    expect(() =>
      store.setStatus(stream.id, "done", sessionAuthor("s1" as SessionId)),
    ).toThrow(LifecycleRefused);
    expect(store.get(stream.id)?.status).toBe("active");
  });

  it("attributes every transition", () => {
    const stream = store.create({ author: humanAuthor });
    clock.advance(60);
    store.setStatus(stream.id, "done", humanAuthor);

    const events = store.events(stream.id);
    expect(events.map((event) => event.kind)).toEqual([
      "created",
      "status_set",
    ]);
    expect(events[1]?.value).toBe("done");
    expect(events[1]?.authorKind).toBe("human");
    expect(events[1]?.createdAt).toBe(1_000_060);
  });

  it("records nothing for a no-op transition", () => {
    const stream = store.create({ author: humanAuthor });
    store.setStatus(stream.id, "active", humanAuthor);

    expect(store.events(stream.id)).toHaveLength(1);
  });

  it("cannot store an unattributed transition (schema-level)", () => {
    const stream = store.create({ author: humanAuthor });

    expect(() =>
      state.sqlite
        .prepare(
          `INSERT INTO workstream_events (id, workstream_id, kind, value, author_kind)
           VALUES ('e1', ?, 'status_set', 'done', 'session')`,
        )
        .run(stream.id),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe("the archive gesture (§3.3, principle 10)", () => {
  it("leaves the board but stays reported as archived", () => {
    const keep = store.create({ author: humanAuthor });
    const gone = store.create({ author: humanAuthor });

    clock.advance(30);
    store.archive(gone.id, humanAuthor);

    expect(store.list().map((row) => row.id)).toEqual([keep.id]);

    const all = store.list({ includeArchived: true });
    expect(all).toHaveLength(2);
    expect(all.find((row) => row.id === gone.id)?.archivedAt).toBe(1_000_030);
  });

  it("is recoverable", () => {
    const stream = store.create({ author: humanAuthor });
    store.archive(stream.id, humanAuthor);
    store.unarchive(stream.id, humanAuthor);

    expect(store.get(stream.id)?.archivedAt).toBeNull();
    expect(store.events(stream.id).map((event) => event.kind)).toEqual([
      "created",
      "archived",
      "unarchived",
    ]);
  });

  it("is a lifecycle gesture: sessions are refused", () => {
    const stream = store.create({ author: humanAuthor });

    expect(() =>
      store.archive(stream.id, sessionAuthor("s1" as SessionId)),
    ).toThrow(LifecycleRefused);
  });
});

describe("containment (§3.3)", () => {
  it("reports the nodes and local objects inside", () => {
    const objects = new ObjectStore(state, clock.now);
    const graph = new GraphStore(state, clock.now);
    const stream = store.create({ author: humanAuthor });

    const local = objects.write({
      kind: "note",
      title: "scratch note",
      workstreamId: stream.id,
      renderings: makeRenderings(),
    });
    graph.place({
      role: "content",
      refId: local.objectId,
      workstreamId: stream.id,
    });
    graph.place({ role: "command", refId: "cmd_1", workstreamId: stream.id });
    graph.place({ role: "session", refId: "sess_1", workstreamId: stream.id });
    graph.place({ role: "command", refId: "cmd_elsewhere" });

    const contents = store.contents(stream.id);
    expect(contents.nodes).toHaveLength(3);
    expect(contents.localObjects.map((row) => row.id)).toEqual([
      local.objectId,
    ]);
  });
});

describe("attention rolls up onto the card (§3.3, §7)", () => {
  it("starts with no rollup", () => {
    const stream = store.create({ author: humanAuthor });

    expect(store.attention(stream.id)).toBeNull();
    expect(store.get(stream.id)?.attentionStatus).toBeNull();
  });

  it("stores the derived rollup where the card reads it", () => {
    const stream = store.create({ author: humanAuthor });

    const rollup = store.updateAttention(stream.id, {
      ...EMPTY_ATTENTION,
      questions: 2,
      runningSessions: 3,
    });

    expect(rollup.status).toBe("needs_decision");
    expect(store.attention(stream.id)).toEqual(rollup);
    expect(store.get(stream.id)?.attentionStatus).toBe("needs_decision");
  });

  it("recomputes as the feeds quiet down", () => {
    const stream = store.create({ author: humanAuthor });

    store.updateAttention(stream.id, { ...EMPTY_ATTENTION, questions: 1 });
    store.updateAttention(stream.id, EMPTY_ATTENTION);

    expect(store.attention(stream.id)?.status).toBe("quiet");
  });

  it("leaves no attribution trail: derived, never authored", () => {
    const stream = store.create({ author: humanAuthor });
    store.updateAttention(stream.id, { ...EMPTY_ATTENTION, drift: 1 });

    expect(store.events(stream.id)).toHaveLength(1);
  });
});

describe("deletion is recoverable, and attributed (principle 10)", () => {
  it("takes a deleted workstream off the board and puts it back", () => {
    const stream = store.create({ author: humanAuthor });

    store.delete(stream.id, humanAuthor);

    expect(store.list()).toHaveLength(0);
    expect(store.list({ includeArchived: true })).toHaveLength(0);
    expect(store.deleted().map((row) => row.id)).toEqual([stream.id]);

    store.restore(stream.id, humanAuthor);

    expect(store.list().map((row) => row.id)).toEqual([stream.id]);
    expect(store.deleted()).toHaveLength(0);
  });

  it("records who deleted it — an agent deletion is recoverable too", () => {
    const stream = store.create({ author: humanAuthor });

    store.delete(stream.id, sessionAuthor("sess_agent" as SessionId));

    const [, deletion] = store.events(stream.id);
    expect(deletion?.kind).toBe("deleted");
    expect(deletion?.authorKind).toBe("session");
    expect(deletion?.authorSession).toBe("sess_agent");
  });
});
