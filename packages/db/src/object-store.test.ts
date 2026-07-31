import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Renderings } from "@plotroom/core";
import { BlobStore } from "./blob-store.js";
import { openDatabase, type PlotroomDatabase } from "./client.js";
import { ObjectStore } from "./object-store.js";

let dir: string;
let state: PlotroomDatabase;
let store: ObjectStore;
let clock: number;

const DAY = 24 * 60 * 60;

function ticket(body: string, summary = "OXY-2982 · in progress"): Renderings {
  return {
    card: { status: "in_progress", assignee: "andy" },
    summary,
    agentContent: body,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-objects-"));
  state = openDatabase({ stateDir: dir });
  clock = 1_000_000;
  store = new ObjectStore(state, () => clock);
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("external identity reconciles, never duplicates (spec §3.1)", () => {
  const external = { system: "jira", id: "OXY-2982" };

  it("updates the same object on re-read", () => {
    const first = store.write({
      kind: "ticket",
      title: "Fix drift flags",
      external,
      renderings: ticket("original description"),
    });

    const second = store.write({
      kind: "ticket",
      title: "Fix drift flags (renamed)",
      external,
      renderings: ticket("edited description"),
    });

    expect(second.objectId).toBe(first.objectId);
    expect(second.ordinal).toBe(2);
    expect(store.get(first.objectId)?.title).toBe("Fix drift flags (renamed)");
  });

  it("writes no version when a re-read changed nothing", () => {
    store.write({
      kind: "ticket",
      title: "Fix drift flags",
      external,
      renderings: ticket("same"),
    });

    const again = store.write({
      kind: "ticket",
      title: "Fix drift flags",
      external,
      renderings: ticket("same"),
    });

    expect(again.created).toBe(false);
    expect(again.ordinal).toBe(1);
  });

  it("keeps distinct objects for distinct external ids", () => {
    const a = store.write({
      kind: "ticket",
      title: "A",
      external,
      renderings: ticket("a"),
    });
    const b = store.write({
      kind: "ticket",
      title: "B",
      external: { system: "jira", id: "OXY-3000" },
      renderings: ticket("b"),
    });

    expect(b.objectId).not.toBe(a.objectId);
  });
});

describe("three renderings and deltas (spec §3.2)", () => {
  it("round-trips card, summary, and agent content", () => {
    const written = store.write({
      kind: "ticket",
      title: "Fix drift flags",
      renderings: ticket("the full ticket body"),
    });

    const content = store.read(written.objectId);

    expect(content.renderings.card).toEqual({
      status: "in_progress",
      assignee: "andy",
    });
    expect(content.renderings.summary).toBe("OXY-2982 · in progress");
    expect(content.renderings.agentContent).toBe("the full ticket body");
  });

  it("keeps a delta smaller than the content", () => {
    const written = store.write({
      kind: "pull_request",
      title: "PR",
      renderings: ticket("a".repeat(500)),
      delta: { summary: "4 new review comments", body: "+4 comments" },
    });

    expect(store.read(written.objectId).delta).toEqual({
      summary: "4 new review comments",
      body: "+4 comments",
    });
  });

  it("falls back to full content when the delta is larger", () => {
    const written = store.write({
      kind: "pull_request",
      title: "PR",
      renderings: ticket("short"),
      delta: { summary: "everything changed", body: "x".repeat(200) },
    });

    expect(store.read(written.objectId).delta).toBeNull();
  });
});

describe("scope and promotion (spec §3.2)", () => {
  it("promotes a local object to world scope in one gesture", () => {
    const written = store.write({
      kind: "note",
      title: "finding",
      workstreamId: "ws_1",
      renderings: ticket("the answer is in docs/architecture.md"),
    });

    expect(store.get(written.objectId)?.scope).toBe("local");

    store.promote(written.objectId);
    const promoted = store.get(written.objectId);

    expect(promoted?.scope).toBe("world");
    expect(promoted?.workstreamId).toBeNull();
    expect(promoted?.promotedAt).toBe(clock);
  });

  it("refuses a local object with no workstream at the schema level", () => {
    expect(() =>
      state.sqlite
        .prepare(
          "INSERT INTO objects (id, kind, scope, title) VALUES ('x', 'note', 'local', 't')",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe("retention and compaction (spec §15 invariant 3)", () => {
  const external = { system: "jira", id: "OXY-2982" };

  function writeVersions(count: number): {
    objectId: string;
    versionIds: string[];
  } {
    const versionIds: string[] = [];
    let objectId = "";

    for (let index = 0; index < count; index += 1) {
      const written = store.write({
        kind: "ticket",
        title: "Ticket",
        external,
        renderings: ticket(`body ${index}`),
      });
      objectId = written.objectId;
      versionIds.push(written.versionId);
      clock += DAY;
    }

    return { objectId, versionIds };
  }

  it("compacts unreferenced intermediates outside the window", () => {
    const { objectId } = writeVersions(4);
    clock += 60 * DAY;

    expect(store.compactVersions({ windowSeconds: 30 * DAY }).removed).toBe(3);
    expect(store.versions(objectId)).toHaveLength(1);
  });

  it("never compacts the latest version", () => {
    const { objectId } = writeVersions(2);
    clock += 60 * DAY;

    store.compactVersions({ windowSeconds: 30 * DAY });
    const surviving = store.versions(objectId);

    expect(surviving).toHaveLength(1);
    expect(surviving[0]?.ordinal).toBe(2);
  });

  it("retains run-referenced versions forever", () => {
    const { objectId, versionIds } = writeVersions(3);
    store.markRunReferenced([versionIds[0]!]);
    clock += 365 * DAY;

    store.compactVersions({ windowSeconds: 30 * DAY });

    expect(store.versions(objectId).map((v) => v.ordinal)).toEqual([1, 3]);
  });

  it("retains pinned versions forever", () => {
    const { objectId, versionIds } = writeVersions(3);
    store.setPinned([versionIds[1]!], true);
    clock += 365 * DAY;

    store.compactVersions({ windowSeconds: 30 * DAY });

    expect(store.versions(objectId).map((v) => v.ordinal)).toEqual([2, 3]);
  });

  it("keeps everything inside the window", () => {
    const { objectId } = writeVersions(3);

    expect(store.compactVersions({ windowSeconds: 30 * DAY }).removed).toBe(0);
    expect(store.versions(objectId)).toHaveLength(3);
  });

  it("frees blob bytes only after the blob store compacts", () => {
    const { objectId } = writeVersions(2);
    clock += 60 * DAY;
    store.compactVersions({ windowSeconds: 30 * DAY });

    const blobs = new BlobStore(state);

    expect(blobs.compact().removed).toBeGreaterThan(0);
    // The surviving version's content is untouched.
    expect(store.read(objectId).renderings.agentContent).toBe("body 1");
  });
});

describe("last-known content survives (spec §3.2)", () => {
  it("still reads after reopening the state directory", () => {
    const written = store.write({
      kind: "document",
      title: "spec",
      renderings: ticket("durable content"),
    });

    state.close();
    state = openDatabase({ stateDir: dir });
    store = new ObjectStore(state, () => clock);

    expect(store.read(written.objectId).renderings.agentContent).toBe(
      "durable content",
    );
  });
});
