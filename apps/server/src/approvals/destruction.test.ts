import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { humanAuthor, sessionAuthor, type SessionId } from "@plotroom/core";
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
  it("refuses a session's destruction with no approval behind it", () => {
    const objectId = note();
    const agent = sessionAuthor("sess-1" as SessionId);

    expect(() =>
      performDestruction(stores, stores.bus, "object", objectId, agent),
    ).toThrowError(ApiError);
    // Nothing was removed: the refusal is before the effect, not after it.
    expect(stores.objects.get(objectId)?.deletedAt).toBeNull();
  });

  it("performs it once the caller states an operator approved", () => {
    const objectId = note();
    const agent = sessionAuthor("sess-1" as SessionId);

    const outcome = performDestruction(
      stores,
      stores.bus,
      "object",
      objectId,
      agent,
      { approved: true },
    );

    expect(outcome.changed).toBe(true);
    expect(stores.objects.get(objectId)?.deletedAt).not.toBeNull();
  });

  it("never gates the operator, who is the authority §6.6 terminates at", () => {
    const objectId = note();

    const outcome = performDestruction(
      stores,
      stores.bus,
      "object",
      objectId,
      humanAuthor,
    );

    expect(outcome.changed).toBe(true);
    expect(stores.objects.get(objectId)?.deletedAt).not.toBeNull();
  });
});
