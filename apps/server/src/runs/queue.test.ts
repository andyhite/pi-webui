import { afterEach, describe, expect, it } from "vitest";
import { humanAuthor } from "@plotroom/core";
import { openDatabase, type PlotroomDatabase } from "@plotroom/db";
import { createEventBus } from "../events/bus.js";
import { Logger } from "../logging/logger.js";
import { createStores, type ApiStores } from "../routes/api.js";
import { RunQueueService } from "./queue.js";
import type { RunService } from "./service.js";

/**
 * The queue's own decisions, over real rows.
 *
 * These are the states the queue can be *in* rather than the paths that lead to
 * them, and they are constructed rather than driven end to end on purpose. The
 * defect this file exists for — a confirmation into a batch that may not run —
 * needs an entry re-asking at the same moment a sibling's failure pauses its
 * batch. Reaching that through HTTP means winning a race between one session's
 * failure and another entry's admission, and a regression guard that has to win a
 * race is a flaky guard. `run-queue.integration.test.ts` covers the paths; this
 * covers the states.
 *
 * The `RunService` here is a stub that throws. That is the assertion: if the queue
 * tries to *run* anything from a batch that is paused or aborted, the test fails
 * with the reason rather than passing quietly.
 */
const stores: { current: ApiStores | null } = { current: null };
const databases: PlotroomDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  stores.current = null;
});

interface Fixture {
  readonly queue: RunQueueService;
  readonly stores: ApiStores;
  readonly batchId: string;
  readonly entryId: string;
  readonly siblingEntryId: string;
  /** How many times the queue tried to actually run something. */
  runAttempts(): number;
}

function fixture(concurrencyLimit = 4): Fixture {
  const database = openDatabase({ stateDir: ":memory:" });
  databases.push(database);

  const bus = createEventBus();
  const api = createStores(database, bus);
  stores.current = api;

  let attempts = 0;
  const runs = {
    runOne: () => {
      attempts += 1;
      throw new Error(
        "the queue started a run it should not have: nothing in a batch that is not running may be admitted",
      );
    },
  } as unknown as RunService;

  const queue = new RunQueueService({
    stores: api,
    bus,
    // Silent: these tests assert on rows, and a refusal the queue logs is not a
    // failure of the test that provoked it.
    logger: new Logger("error", () => {}),
    runs,
    concurrencyLimit,
  });

  // One workstream, two commands, one batch of two — the smallest shape that has a
  // sibling to fail and an entry to confirm.
  const workstream = api.workstreams.create({ author: humanAuthor });
  const definition = api.commands.define({
    name: "Do it",
    instruction: "Do it.",
    model: "fixture-model",
    effort: "medium",
    lifecycle: "open",
  });

  const first = api.commands.instantiate({
    definitionId: definition.id,
    workstreamId: workstream.id,
    author: humanAuthor,
  });
  const second = api.commands.instantiate({
    definitionId: definition.id,
    workstreamId: workstream.id,
    author: humanAuthor,
  });

  const batch = api.queue.createBatch({
    initiationKey: "one-gesture",
    scope: "subgraph",
    scopeId: first.command.id,
    actor: humanAuthor,
  });

  const contract = (commandId: string) => ({
    batchId: batch.id,
    commandId,
    initiationKey: `one-gesture:${commandId}`,
    position: 1,
    // A hash nothing will match, so admission would re-ask if it got that far.
    contractHash: "a-contract-nothing-matches",
    contract: { configuration: null, inputs: [], runnable: true },
  });

  const sibling = api.queue.enqueue(contract(first.command.id));
  const entry = api.queue.enqueue({
    ...contract(second.command.id),
    position: 2,
  });

  return {
    queue,
    stores: api,
    batchId: batch.id,
    entryId: entry.id,
    siblingEntryId: sibling.id,
    runAttempts: () => attempts,
  };
}

describe("confirming a re-ask (§4.1)", () => {
  it("parks it when the batch is paused, keeping the answer without acting on it", async () => {
    const board = fixture();

    // The sibling failed, which pauses the batch (§4.1). The re-asking entry is
    // untouched by that: a pause moves what is *queued*, and this one is asking.
    board.stores.queue.settle(board.siblingEntryId, "failed", "failed");
    board.stores.queue.pauseBatch(board.batchId, "a run in this batch failed");
    board.stores.queue.markNeedsReask(board.entryId, "its input moved");

    // The gesture that used to hang the server: confirm, into a batch nothing may
    // admit. Before the fix the entry went back to `queued` and the drain that
    // followed read it as "the next thing to admit" for ever.
    const confirmed = await board.queue.confirm(board.entryId, humanAuthor);

    expect(confirmed.state).toBe("paused");
    expect(confirmed.detail).toContain("resumed");
    // Nothing ran. The operator's answer is recorded and the batch still needs the
    // separate gesture that resumes it — the product never decides to (principle 2).
    expect(board.runAttempts()).toBe(0);
    expect(board.stores.queue.batch(board.batchId).state).toBe("paused");

    // And it is not sitting in the queue of admissible work.
    expect(board.stores.queue.waiting()).toHaveLength(0);
  });

  it("refuses when the batch is aborted, because stopped means stopped", async () => {
    const board = fixture();
    board.stores.queue.markNeedsReask(board.entryId, "its input moved");
    board.stores.queue.abortBatch(board.batchId, "stopped by user");

    // `abortBatch` reaches a re-asking entry and cancels it, so the refusal comes
    // from the entry's own state — which is the honest one: there is no longer a
    // run here to confirm at all.
    expect(board.stores.queue.entry(board.entryId).state).toBe("cancelled");
    await expect(
      board.queue.confirm(board.entryId, humanAuthor),
    ).rejects.toThrow(/asking to be confirmed/u);
    expect(board.runAttempts()).toBe(0);

    // And the batch-level refusal is reachable too, for an entry an abort could not
    // reach — a row already re-asking when the abort raced past it.
    board.stores.queue.markNeedsReask(board.entryId, "its input moved");
    await expect(
      board.queue.confirm(board.entryId, humanAuthor),
    ).rejects.toThrow(/stopped means stopped/u);
  });

  it("refuses a confirmation into a batch that already completed", async () => {
    const board = fixture();
    board.stores.queue.settle(board.siblingEntryId, "done", "ended-by-user");
    board.stores.queue.markNeedsReask(board.entryId, "its input moved");
    // Nothing outstanding but the re-ask, so the batch is *not* completed yet —
    // force the state the way a settled batch would read.
    board.stores.queue.settle(board.entryId, "done", "ended-by-user");
    board.stores.queue.settleBatchIfFinished(board.batchId);
    board.stores.queue.markNeedsReask(board.entryId, "its input moved");

    await expect(
      board.queue.confirm(board.entryId, humanAuthor),
    ).rejects.toThrow(/nothing left for a confirmation to start/u);
    expect(board.runAttempts()).toBe(0);
  });
});

describe("the drain loop terminates (§4.1)", () => {
  it("moves a queued entry out of a paused batch rather than reading it forever", async () => {
    const board = fixture();

    // The state the wedge needed: a `queued` row in a batch nothing may admit.
    // Reached here directly, because the point is that the *loop* copes with it
    // however it arose — a hung server one forgotten branch away is not a design.
    board.stores.queue.pauseBatch(board.batchId, "a run in this batch failed");
    board.stores.queue.reconfirm(board.entryId, {
      hash: "a-contract-nothing-matches",
      contract: {},
    });
    expect(board.stores.queue.entry(board.entryId).state).toBe("queued");

    // If the loop could spin, this never returns.
    await board.queue.drain();

    const parked = board.stores.queue.entry(board.entryId);
    expect(parked.state).toBe("paused");
    expect(board.runAttempts()).toBe(0);
    expect(board.stores.queue.waiting()).toHaveLength(0);
  });

  it("cancels a queued entry whose batch was aborted", async () => {
    const board = fixture();
    board.stores.queue.abortBatch(board.batchId, "stopped by user");
    board.stores.queue.reconfirm(board.entryId, {
      hash: "a-contract-nothing-matches",
      contract: {},
    });

    await board.queue.drain();

    const settled = board.stores.queue.entry(board.entryId);
    expect(settled.state).toBe("cancelled");
    expect(settled.detail).toContain("aborted");
    expect(board.runAttempts()).toBe(0);
  });

  it("never considers one entry twice in a pass, whatever a branch forgets", async () => {
    const board = fixture();
    board.stores.queue.pauseBatch(board.batchId, "paused");
    board.stores.queue.reconfirm(board.entryId, {
      hash: "a-contract-nothing-matches",
      contract: {},
    });
    board.stores.queue.reconfirm(board.siblingEntryId, {
      hash: "a-contract-nothing-matches",
      contract: {},
    });
    expect(board.stores.queue.waiting()).toHaveLength(2);

    // Two rows, one pass, and it returns. The attempted-set is the belt that makes
    // this true even if the row-moving brace above were removed.
    await board.queue.drain();
    expect(board.stores.queue.waiting()).toHaveLength(0);
    expect(board.runAttempts()).toBe(0);
  });
});
