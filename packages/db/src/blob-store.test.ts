import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlobReleasedError, BlobStore } from "./blob-store.js";
import { openDatabase, type PlotroomDatabase } from "./client.js";
import { blobPath } from "./paths.js";
import { INLINE_MAX_BYTES } from "./schema.js";
import { SearchIndex } from "./search.js";

let dir: string;
let state: PlotroomDatabase;
let store: BlobStore;

const large = () => "x".repeat(INLINE_MAX_BYTES + 1);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-test-"));
  state = openDatabase({ stateDir: dir });
  store = new BlobStore(state);
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("blob storage split", () => {
  it("keeps small content inline, with no file on disk", () => {
    const stored = store.put("a note", { kind: "note" });

    expect(stored.external).toBe(false);
    expect(existsSync(blobPath(state.layout.blobsDir, stored.hash))).toBe(
      false,
    );
    expect(store.text(stored.id)).toBe("a note");
  });

  it("spills content over the threshold to a content-addressed file", () => {
    const stored = store.put(large(), { kind: "assembled_content" });

    expect(stored.external).toBe(true);
    expect(existsSync(blobPath(state.layout.blobsDir, stored.hash))).toBe(true);
    expect(store.text(stored.id)).toHaveLength(INLINE_MAX_BYTES + 1);
  });

  it("stores identical content once (assembled content repeats across runs)", () => {
    const first = store.put(large(), { kind: "assembled_content" });
    const second = store.put(large(), { kind: "assembled_content" });

    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
  });
});

describe("release and reload (spec §6.1)", () => {
  it("frees the file but keeps the row, then reloads", () => {
    const stored = store.put(large(), { kind: "transcript_part" });
    store.reference(stored.id, {
      ownerKind: "transcript_part",
      ownerId: "sess_1",
    });

    expect(store.release(stored.id)).toBe(true);
    expect(existsSync(blobPath(state.layout.blobsDir, stored.hash))).toBe(
      false,
    );
    expect(() => store.get(stored.id)).toThrow(BlobReleasedError);

    const reloaded = store.put(large(), { kind: "transcript_part" });
    expect(reloaded.id).toBe(stored.id);
    expect(store.text(stored.id)).toHaveLength(INLINE_MAX_BYTES + 1);
  });

  it("offers release candidates largest first", () => {
    const small = store.put(large(), { kind: "transcript_part" });
    const bigger = store.put(`${large()}yy`, { kind: "transcript_part" });

    for (const id of [small.id, bigger.id]) {
      store.reference(id, { ownerKind: "transcript_part", ownerId: "sess_1" });
    }

    const candidates = store.releaseCandidates("transcript_part", "sess_1");
    expect(candidates.map((candidate) => candidate.id)).toEqual([
      bigger.id,
      small.id,
    ]);
  });

  it("does not release inline content", () => {
    const stored = store.put("small", { kind: "note" });
    expect(store.release(stored.id)).toBe(false);
  });
});

describe("compaction (spec §3.2)", () => {
  it("removes only unreferenced blobs, and their files", () => {
    const kept = store.put(large(), { kind: "assembled_content" });
    const orphan = store.put(`${large()}zz`, { kind: "assembled_content" });

    store.reference(kept.id, { ownerKind: "run_input", ownerId: "run_1" });

    const result = store.compact();

    expect(result.removed).toBe(1);
    expect(existsSync(blobPath(state.layout.blobsDir, kept.hash))).toBe(true);
    expect(existsSync(blobPath(state.layout.blobsDir, orphan.hash))).toBe(
      false,
    );
    expect(store.text(kept.id)).toHaveLength(INLINE_MAX_BYTES + 1);
  });

  it("retains content once any reference exists, and drops it when the last goes", () => {
    const stored = store.put("shared", { kind: "note" });

    store.reference(stored.id, { ownerKind: "run_input", ownerId: "run_1" });
    store.reference(stored.id, { ownerKind: "run_input", ownerId: "run_2" });
    store.dereference(stored.id, { ownerKind: "run_input", ownerId: "run_1" });

    expect(store.compact().removed).toBe(0);

    store.dereference(stored.id, { ownerKind: "run_input", ownerId: "run_2" });
    expect(store.compact().removed).toBe(1);
  });
});

describe("search (spec §6.8)", () => {
  it("finds external content the same as inline content", () => {
    const search = new SearchIndex(state);
    const body = `${large()} needle in external content`;
    const external = store.put(body, { kind: "transcript_part" });

    search.index({
      title: "Fix the login bug",
      location: "Workstream OXY-2982",
      body,
      kind: "session",
      refKind: "session",
      refId: "sess_1",
    });
    search.index({
      title: "a note",
      location: "world",
      body: "an inline note mentioning needle",
      kind: "note",
      refKind: "note",
      refId: "note_1",
    });

    const hits = search.query("needle");

    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => hit.refId).sort()).toEqual(["note_1", "sess_1"]);
    expect(hits.every((hit) => hit.snippet.includes("[needle]"))).toBe(true);
    expect(external.external).toBe(true);
  });

  it("ranks a match in the title above the same word merely in the body", () => {
    const search = new SearchIndex(state);

    search.index({
      title: "unrelated",
      location: "world",
      body: "mentions needle only once, in passing",
      kind: "note",
      refKind: "note",
      refId: "body_match",
    });
    search.index({
      title: "needle",
      location: "world",
      body: "nothing relevant here",
      kind: "note",
      refKind: "note",
      refId: "title_match",
    });

    const hits = search.query("needle");

    expect(hits.map((hit) => hit.refId)).toEqual(["title_match", "body_match"]);
  });

  it("filters by kind and replaces an entry on reindex", () => {
    const search = new SearchIndex(state);

    search.index({
      title: "a note",
      location: "world",
      body: "first version",
      kind: "note",
      refKind: "note",
      refId: "note_1",
    });
    search.index({
      title: "a note",
      location: "world",
      body: "second version",
      kind: "note",
      refKind: "note",
      refId: "note_1",
    });

    expect(search.query("first")).toHaveLength(0);
    expect(search.query("second", { kinds: ["note"] })).toHaveLength(1);
    expect(search.query("second", { kinds: ["transcript_part"] })).toHaveLength(
      0,
    );
  });
});

describe("portability (spec §12)", () => {
  it("survives reopening the same state directory", () => {
    const stored = store.put(large(), { kind: "diff" });
    store.reference(stored.id, { ownerKind: "run_output", ownerId: "run_1" });
    state.close();

    state = openDatabase({ stateDir: dir });
    store = new BlobStore(state);

    expect(store.text(stored.id)).toHaveLength(INLINE_MAX_BYTES + 1);
  });
});
