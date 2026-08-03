import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  humanAuthor,
  sessionAuthor,
  type ObjectKind,
  type SessionId,
} from "@plotroom/core";
import { manualClock, type ManualClock } from "@plotroom/core/testing";
import { openDatabase, type PlotroomDatabase } from "./client.js";
import { ObjectStore } from "./object-store.js";
import { StandingInstructionStore } from "./standing-instruction-store.js";
import { WorkstreamStore } from "./workstream-store.js";

/**
 * Standing instructions at rest (§3.8, migration 26).
 *
 * Every refusal asserted here is `@plotroom/core`'s, reached through the store: what
 * this file proves is that the store *calls* the rule rather than restating it, and
 * that the schema refuses what the predicate refuses (principle 8).
 */
let dir: string;
let state: PlotroomDatabase;
let clock: ManualClock;
let store: StandingInstructionStore;
let objects: ObjectStore;
let workstreamId: string;
let otherWorkstreamId: string;

const SESSION = "sess_a" as SessionId;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-standing-"));
  state = openDatabase({ stateDir: dir });
  clock = manualClock(1_000);
  store = new StandingInstructionStore(state, clock.now);
  objects = new ObjectStore(state, clock.now);
  const workstreams = new WorkstreamStore(state, clock.now);
  workstreamId = workstreams.create({ author: humanAuthor }).id;
  otherWorkstreamId = workstreams.create({ author: humanAuthor }).id;
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

function object(
  options: {
    readonly kind?: ObjectKind;
    readonly local?: boolean;
    readonly body?: string;
  } = {},
): string {
  return objects.write({
    kind: options.kind ?? "note",
    title: "This repository uses pnpm",
    renderings: {
      card: {},
      summary: "pnpm, never npm",
      agentContent: options.body ?? "This repository uses pnpm, never npm.",
    },
    ...(options.local === true ? { workstreamId } : {}),
  }).objectId;
}

describe("marking content standing (§3.8)", () => {
  it("records the marker, the human who declared it, and nothing about content", () => {
    const objectId = object();
    const declared = store.declare({ objectId, by: humanAuthor });

    expect(declared.ok).toBe(true);
    if (!declared.ok) return;
    expect(declared.value.objectId).toBe(objectId);
    expect(declared.value.declaredBy).toEqual(humanAuthor);
    expect(declared.value.declaredAt).toBe(1_000);
    expect(declared.value.retiredAt).toBeNull();
    expect(store.live()).toHaveLength(1);
  });

  it("refuses a session author, and names the proposal path (principle 1)", () => {
    const refused = store.declare({
      objectId: object(),
      by: sessionAuthor(SESSION),
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.reason).toBe("human_only");
    expect(refused.refusal.message).toContain("proposal_create");
    // And nothing was written: a refusal is not a half-applied gesture.
    expect(store.list()).toEqual([]);
  });

  it("refuses a local object, pointing at promotion (§3.2)", () => {
    const refused = store.declare({
      objectId: object({ local: true }),
      by: humanAuthor,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.reason).toBe("not_world_scope");
  });

  it("refuses a kind whose content somebody else changes (§3.8)", () => {
    const refused = store.declare({
      objectId: object({ kind: "ticket" }),
      by: humanAuthor,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.reason).toBe("kind_cannot_be_standing");
  });

  it("refuses a second live marker for one object (principle 9)", () => {
    const objectId = object();
    expect(store.declare({ objectId, by: humanAuthor }).ok).toBe(true);

    const again = store.declare({ objectId, by: humanAuthor });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.refusal.reason).toBe("already_standing");
    expect(store.list()).toHaveLength(1);
  });

  it("lets a retired object be marked again — the index is partial for that reason", () => {
    const objectId = object();
    const first = store.declare({ objectId, by: humanAuthor });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    clock.advance(60);
    const retired = store.retire(first.value.id, humanAuthor);
    expect(retired.ok).toBe(true);
    if (!retired.ok) return;
    expect(retired.value.retiredAt).toBe(1_060);

    const second = store.declare({ objectId, by: humanAuthor });
    expect(second.ok).toBe(true);
    // Retired, not deleted: both facts are still readable (principle 10).
    expect(store.list()).toHaveLength(2);
    expect(store.live()).toHaveLength(1);
  });

  it("refuses a session's retire, and is idempotent for the human's", () => {
    const declared = store.declare({ objectId: object(), by: humanAuthor });
    expect(declared.ok).toBe(true);
    if (!declared.ok) return;

    const refused = store.retire(declared.value.id, sessionAuthor(SESSION));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.reason).toBe("human_only");

    clock.advance(10);
    const retired = store.retire(declared.value.id, humanAuthor);
    expect(retired.ok).toBe(true);
    clock.advance(10);
    const again = store.retire(declared.value.id, humanAuthor);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    // The first retirement's time stands: retiring twice is one event.
    expect(again.value.retiredAt).toBe(1_010);
  });
});

describe("opting a workstream in (§3.8)", () => {
  it("is opt-in only: an unopted workstream resolves to nothing (principle 6)", () => {
    const declared = store.declare({ objectId: object(), by: humanAuthor });
    expect(declared.ok).toBe(true);
    expect(store.resolve(workstreamId)).toEqual([]);
  });

  it("records the author, including a session's", () => {
    const declared = store.declare({ objectId: object(), by: humanAuthor });
    if (!declared.ok) return;

    const optedIn = store.optIn({
      workstreamId,
      instructionId: declared.value.id,
      by: sessionAuthor(SESSION),
    });
    expect(optedIn.by).toEqual(sessionAuthor(SESSION));
    expect(store.resolve(workstreamId).map((each) => each.id)).toEqual([
      declared.value.id,
    ]);
    // One workstream's opt-in decides nothing for another (§3.3's scoping).
    expect(store.resolve(otherWorkstreamId)).toEqual([]);
  });

  it("opts out by recording it, and opting in again revives the same row", () => {
    const declared = store.declare({ objectId: object(), by: humanAuthor });
    if (!declared.ok) return;
    store.optIn({
      workstreamId,
      instructionId: declared.value.id,
      by: humanAuthor,
    });

    clock.advance(5);
    const out = store.optOut(workstreamId, declared.value.id);
    expect(out.optedOutAt).toBe(1_005);
    expect(store.resolve(workstreamId)).toEqual([]);
    // Recorded, not erased: the row is still there saying it happened.
    expect(store.optIns()).toHaveLength(1);

    clock.advance(5);
    const back = store.optIn({
      workstreamId,
      instructionId: declared.value.id,
      by: humanAuthor,
    });
    expect(back.optedOutAt).toBeNull();
    expect(back.at).toBe(1_010);
    expect(store.optIns()).toHaveLength(1);
    expect(store.resolve(workstreamId)).toHaveLength(1);
  });

  it("stops resolving a retired instruction without touching the opt-in", () => {
    const declared = store.declare({ objectId: object(), by: humanAuthor });
    if (!declared.ok) return;
    store.optIn({
      workstreamId,
      instructionId: declared.value.id,
      by: humanAuthor,
    });
    store.retire(declared.value.id, humanAuthor);

    expect(store.resolve(workstreamId)).toEqual([]);
    expect(store.optIns()).toHaveLength(1);
  });

  it("resolves oldest first, then by id — the order run history compares by (§15-1)", () => {
    const second = store.declare({
      objectId: object({ body: "second" }),
      by: humanAuthor,
    });
    clock.advance(1);
    const third = store.declare({
      objectId: object({ body: "third" }),
      by: humanAuthor,
    });
    if (!second.ok || !third.ok) return;

    // Opted in newest-first, deliberately: row order must not decide assembly.
    store.optIn({
      workstreamId,
      instructionId: third.value.id,
      by: humanAuthor,
    });
    store.optIn({
      workstreamId,
      instructionId: second.value.id,
      by: humanAuthor,
    });

    expect(store.resolve(workstreamId).map((each) => each.declaredAt)).toEqual([
      1_000, 1_001,
    ]);
  });
});
