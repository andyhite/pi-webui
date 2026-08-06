import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, afterEach, beforeEach, describe, it } from "bun:test";
import { humanAuthor } from "@plotroom/core";
import {
  GraphStore,
  WorkstreamStore,
  openDatabase,
  type PlotroomDatabase,
} from "@plotroom/db";
import { atomically } from "./atomic.js";
import { createEventBus, type EventBus } from "./bus.js";

/**
 * One gesture, one transaction, and nothing announced until it committed
 * (issue #76).
 *
 * The two halves of that are tested separately here because they fail
 * differently: rows come back, and an announcement does not. A subscriber told
 * "deleted" has already re-rendered by the time a later write in the same
 * gesture throws, and no rollback reaches it.
 */
let dir: string;
let state: PlotroomDatabase;
let bus: EventBus;
let workstreams: WorkstreamStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-atomic-"));
  state = openDatabase({ stateDir: dir });
  bus = createEventBus(() => 1_000);
  workstreams = new WorkstreamStore(state, () => 1_000);
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("atomically", () => {
  it("rolls every write back when the gesture throws part-way", () => {
    const id = workstreams.create({ author: humanAuthor }).id;

    expect(() =>
      atomically(state, bus, () => {
        workstreams.delete(id, humanAuthor);
        throw new Error("the second write failed");
      }),
    ).toThrowError(/second write failed/);

    expect(workstreams.get(id)?.deletedAt).toBeNull();
  });

  it("announces nothing that rolled back", () => {
    const id = workstreams.create({ author: humanAuthor }).id;
    const announced: unknown[] = [];
    bus.subscribe((event) => announced.push(event));

    expect(() =>
      atomically(state, bus, (announce) => {
        announce.publish({
          entity: "workstream",
          verb: "deleted",
          workstreamId: id as never,
          author: humanAuthor,
        });
        throw new Error("the second write failed");
      }),
    ).toThrowError(/second write failed/);

    // The whole point: the announcement was decided before the failure and
    // still never reached a subscriber.
    expect(announced).toEqual([]);
  });

  it("publishes what committed, in the order it was announced", () => {
    const id = workstreams.create({ author: humanAuthor }).id;
    const verbs: string[] = [];
    bus.subscribe((event) => verbs.push(`${event.entity}:${event.verb}`));

    const returned = atomically(state, bus, (announce) => {
      const row = workstreams.delete(id, humanAuthor);
      announce.publish({
        entity: "workstream",
        verb: "deleted",
        workstreamId: id as never,
        author: humanAuthor,
      });
      announce.publish({
        entity: "workstream",
        verb: "updated",
        workstream: { id, subjectId: null, status: "active" } as never,
        author: humanAuthor,
      });
      return row.id;
    });

    // Order is load-bearing: the announce helpers go leaves-first tearing down
    // and roots-first putting back, and buffering must not reshuffle that.
    expect(verbs).toEqual(["workstream:deleted", "workstream:updated"]);
    expect(returned).toBe(id);
    expect(workstreams.get(id)?.deletedAt).not.toBeNull();
  });

  it("composes with a store that opens its own transaction", () => {
    // SQLite nests these as savepoints, which is what lets each store keep its own
    // atomicity while a gesture over several of them keeps its own —
    // `GraphStore.removeNode` is one transaction, and a cascade wrapping it is
    // another.
    const graph = new GraphStore(state, () => 1_000);
    const source = graph.place({ role: "content", refId: "obj_1" });
    const target = graph.place({ role: "command", refId: "cmd_1" });
    const edge = graph.addContextEdge({
      from: source.id,
      to: target.id,
      author: humanAuthor,
    });

    expect(() =>
      atomically(state, bus, () => {
        graph.removeNode(source.id);
        throw new Error("too late");
      }),
    ).toThrowError(/too late/);

    expect(graph.node(source.id).deletedAt).toBeNull();
    expect(graph.edge(edge.id).deletedAt).toBeNull();
  });
});
