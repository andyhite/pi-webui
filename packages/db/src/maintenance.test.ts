import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { humanAuthor, type VersionId } from "@plotroom/core";
import {
  makeRenderings,
  manualClock,
  type ManualClock,
} from "@plotroom/core/testing";
import { blobPath } from "./paths.js";
import { BlobStore } from "./blob-store.js";
import { openDatabase, type PlotroomDatabase } from "./client.js";
import { CommandStore } from "./command-store.js";
import { GraphStore } from "./graph-store.js";
import { Maintenance, WORKSPACE_DESTRUCTION_WARNING } from "./maintenance.js";
import { ObjectStore } from "./object-store.js";
import { RunStore } from "./run-store.js";
import { WorkstreamStore } from "./workstream-store.js";

const DAY = 24 * 60 * 60;

let dir: string;
let state: PlotroomDatabase;
let clock: ManualClock;
let maintenance: Maintenance;
let objects: ObjectStore;
let graph: GraphStore;
let commands: CommandStore;
let runs: RunStore;
let blobs: BlobStore;
let workstreamId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-maintenance-"));
  state = openDatabase({ stateDir: dir });
  clock = manualClock();
  maintenance = new Maintenance(state, clock.now);
  objects = new ObjectStore(state, clock.now);
  graph = new GraphStore(state, clock.now);
  commands = new CommandStore(state, clock.now);
  runs = new RunStore(state, clock.now);
  blobs = new BlobStore(state, clock.now);
  workstreamId = new WorkstreamStore(state, clock.now).create({
    author: humanAuthor,
  }).id;
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

/** An object with two versions: the older one is the compaction candidate. */
function twoVersions(title: string) {
  const first = objects.write({
    kind: "note",
    title,
    renderings: makeRenderings({ agentContent: `${title} v1` }),
    workstreamId,
  });
  const second = objects.edit(first.objectId, {
    renderings: makeRenderings({ agentContent: `${title} v2` }),
  });
  return { objectId: first.objectId, older: first, newer: second };
}

/** A run of a producing command over one note, so history has something in it. */
function aRun() {
  const definition = commands.define({
    name: "Implement",
    instruction: "Do it.",
    model: "fixture-model",
    effort: "medium",
    lifecycle: "producing",
    outcome: { name: "result", kind: "document", conditions: [] },
  });
  const instance = commands.instantiate({
    definitionId: definition.id,
    workstreamId,
    author: humanAuthor,
  });
  const note = objects.write({
    kind: "note",
    title: "input",
    renderings: makeRenderings({ agentContent: "the input" }),
    workstreamId,
  });
  const node = graph.place({
    role: "content",
    refId: note.objectId,
    workstreamId,
  });
  graph.addContextEdge({
    from: node.id,
    to: instance.node.id,
    author: humanAuthor,
  });

  return runs.start({ commandId: instance.command.id });
}

describe("the state inventory (§12)", () => {
  it("names the directory to back up, and what is in it", () => {
    twoVersions("note");

    const inventory = maintenance.inventory();

    expect(inventory.stateDir).toBe(dir);
    expect(inventory.databaseFile).toBe(join(dir, "plotroom.db"));
    expect(inventory.blobsDir).toBe(join(dir, "blobs"));
    expect(inventory.schemaVersion).toBeGreaterThanOrEqual(8);
    expect(inventory.counts["objects"]).toBe(1);
    expect(inventory.counts["object_versions"]).toBe(2);
    expect(inventory.blobBytes.inline).toBeGreaterThan(0);
  });
});

describe("reset states what it removes first (§12)", () => {
  it("plans and clears the arrangement, and nothing else", () => {
    const object = objects.write({
      kind: "note",
      title: "note",
      renderings: makeRenderings({ agentContent: "content" }),
      workstreamId,
    });
    const node = graph.place({
      role: "content",
      refId: object.objectId,
      workstreamId,
    });
    graph.setPosition(node.id, { x: 10, y: 20 });

    const plan = maintenance.resetPlan("arrangement");
    expect(plan.counts["arrangedNodes"]).toBe(1);
    expect(plan.removes[0]).toMatch(/authored position of 1 node/);
    expect(plan.keeps.join(" ")).toMatch(/only where things sit is forgotten/);

    expect(maintenance.reset("arrangement")).toEqual({
      scope: "arrangement",
      removed: { arrangedNodes: 1 },
    });

    expect(graph.node(node.id).x).toBeNull();
    // The node itself is still there: the arrangement is not the board.
    expect(graph.liveNodes()).toHaveLength(1);
    expect(objects.live()).toHaveLength(1);
  });

  it("plans derived state as re-provisionable, keeping the records", () => {
    const plan = maintenance.resetPlan("derived");

    expect(plan.removes.join(" ")).toMatch(/provisioned again at the next run/);
    expect(plan.keeps.join(" ")).toMatch(/run history, sessions/);
    // Honest about what it will not touch and why (principle 12).
    expect(plan.keeps.join(" ")).toMatch(/no rebuild step yet/);
  });

  it("says plainly that deleting a checkout destroys what is only in it", () => {
    // "Re-provisioned" is lossless only for what git has somewhere else, and a
    // cleanup verb that reads as harmless is a data-loss bug with a friendly
    // name (§12, principle 12). Both scopes that delete a checkout say it, in
    // one wording.
    for (const scope of ["derived", "everything"] as const) {
      const removes = maintenance.resetPlan(scope).removes.join(" ");
      expect(removes).toContain(WORKSPACE_DESTRUCTION_WARNING);
      expect(removes).toMatch(/not committed and pushed is destroyed/);
      expect(removes).toMatch(/commits that only exist locally/);
    }

    // The harmless one does not carry the warning, because it removes no files.
    expect(
      maintenance.resetPlan("arrangement").removes.join(" "),
    ).not.toContain(WORKSPACE_DESTRUCTION_WARNING);
  });

  it("counts every row before emptying the store, and empties it", () => {
    const started = aRun();
    runs.complete(started.run.id, {
      cost: { inputTokens: 1, outputTokens: 1, costMicros: 10 },
    });

    const plan = maintenance.resetPlan("everything");
    expect(plan.counts["runs"]).toBe(1);
    expect(plan.counts["objects"]).toBeGreaterThan(0);
    expect(plan.removes[0]).toMatch(/every row in the store/);
    expect(plan.keeps[0]).toMatch(/the schema/);

    const result = maintenance.reset("everything");

    expect(result.removed["runs"]).toBe(1);
    expect(result.removed["blobs"]).toBeGreaterThan(0);
    expect(maintenance.inventory().counts["objects"]).toBe(0);
    expect(maintenance.inventory().counts["blobs"]).toBe(0);
    // Emptied, not broken: the schema is still there to write into.
    expect(
      new WorkstreamStore(state, clock.now).create({ author: humanAuthor }).id,
    ).toBeTruthy();
  });
});

describe("the compaction sweep (§15-3, §4.4)", () => {
  it("removes an old unreferenced intermediate version and its bytes", () => {
    const { objectId, older } = twoVersions("note");

    clock.advance(31 * DAY);
    const result = maintenance.compact();

    expect(result.versionsRemoved).toBe(1);
    expect(result.blobsRemoved).toBeGreaterThan(0);
    expect(result.bytesFreed).toBeGreaterThan(0);
    // The object and its latest version survive: only the intermediate went.
    expect(objects.versions(objectId).map((each) => each.id)).not.toContain(
      older.versionId,
    );
    expect(objects.read(objectId).renderings.agentContent).toBe("note v2");
  });

  it("never compacts a version a run consumed (§15-1's interplay)", () => {
    const started = aRun();
    const consumed = started.run.inputs[0];
    expect(consumed).toBeDefined();

    clock.advance(31 * DAY);
    const result = maintenance.compact();

    expect(result.versionsRemoved).toBe(0);
    // The run is inside the retention window, so nothing about it moved.
    expect(result.runsRemoved).toBe(0);
    expect(runs.run(started.run.id).inputs[0]?.versionId).toBe(
      consumed?.versionId,
    );
    expect(runs.assembledContent(started.run.id)).toContain("the input");
  });

  it("never compacts pinned content, at any age", () => {
    const { objectId, older } = twoVersions("note");
    objects.setPinned([older.versionId], true);

    clock.advance(365 * DAY);
    expect(maintenance.compact().versionsRemoved).toBe(0);
    expect(objects.versions(objectId).map((each) => each.id)).toContain(
      older.versionId as VersionId,
    );
  });

  it("keeps a blob any live reference still points at", () => {
    const stored = blobs.put("shared content", { kind: "test" });
    blobs.reference(stored.id, { ownerKind: "test", ownerId: "keeper" });

    clock.advance(365 * DAY);
    const result = maintenance.compact();

    expect(result.blobsRemoved).toBe(0);
    expect(blobs.text(stored.id)).toBe("shared content");
  });

  it("sweeps a blob nothing points at, file and row together", () => {
    const external = "x".repeat(100_000);
    const stored = blobs.put(external, { kind: "test" });
    const path = blobPath(state.layout.blobsDir, stored.hash);
    expect(existsSync(path)).toBe(true);

    const result = maintenance.compact();

    expect(result.blobsRemoved).toBe(1);
    expect(result.bytesFreed).toBe(external.length);
    expect(existsSync(path)).toBe(false);
  });
});

describe("the sweep leaves nothing half-removed (§12, principle 12)", () => {
  it("never leaves a blob row whose bytes are gone", () => {
    // Two external blobs: one referenced, one not. The unreferenced one is
    // swept, and the invariant asserted afterwards is the one the row-before-
    // file order exists to keep — every surviving row can still be read.
    const kept = blobs.put("k".repeat(80_000), { kind: "test" });
    blobs.reference(kept.id, { ownerKind: "test", ownerId: "keeper" });
    const doomed = blobs.put("d".repeat(80_000), { kind: "test" });

    const result = maintenance.compact();

    expect(result.blobsRemoved).toBe(1);
    expect(existsSync(blobPath(state.layout.blobsDir, doomed.hash))).toBe(
      false,
    );

    for (const row of state.sqlite
      .prepare<{ id: string; hash: string; is_external: number }, []>(
        "SELECT id, hash, is_external FROM blobs",
      )
      .all()) {
      if (row.is_external === 1) {
        expect(existsSync(blobPath(state.layout.blobsDir, row.hash))).toBe(
          true,
        );
      }
      // Readable through the store, which is the claim a row makes.
      expect(blobs.get(row.id).byteLength).toBeGreaterThan(0);
    }
    expect(blobs.text(kept.id)).toBe("k".repeat(80_000));
  });

  it("heals rather than dedupes into a hole when a file outlives its row", () => {
    // The crash window, made explicit: rows go first, so an interrupted sweep
    // can leave a file with no row. Re-putting that content must write a fresh
    // blob, not hand back a dead one — which is exactly what the reverse order
    // (file first) would have done.
    const content = "c".repeat(80_000);
    const first = blobs.put(content, { kind: "test" });
    const path = blobPath(state.layout.blobsDir, first.hash);

    state.sqlite.prepare("DELETE FROM blobs WHERE id = ?").run(first.id);
    expect(existsSync(path)).toBe(true);

    const again = blobs.put(content, { kind: "test" });

    expect(again.deduped).toBe(false);
    expect(again.id).not.toBe(first.id);
    expect(blobs.text(again.id)).toBe(content);
  });

  it("never leaves a version whose content nothing claims", () => {
    const { objectId } = twoVersions("note");
    const started = aRun();
    runs.complete(started.run.id, {
      cost: { inputTokens: 1, outputTokens: 1, costMicros: 10 },
    });

    clock.advance(31 * DAY);
    maintenance.compact();

    // Every surviving version still has a reference to its content, so the next
    // blob sweep cannot reclaim bytes something points at.
    const unclaimed = state.sqlite
      .prepare<{ count: number }, []>(
        `SELECT COUNT(*) AS count
           FROM object_versions v
          WHERE NOT EXISTS (
                  SELECT 1 FROM blob_refs r
                   WHERE r.blob_id = v.content_blob_id
                     AND r.owner_kind = 'object_version'
                     AND r.owner_id = v.id)`,
      )
      .get() as { count: number };

    expect(unclaimed.count).toBe(0);
    expect(objects.read(objectId).renderings.agentContent).toBe("note v2");
    expect(runs.assembledContent(started.run.id)).toContain("the input");
  });
});
