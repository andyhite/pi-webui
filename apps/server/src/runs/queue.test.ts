import { afterEach, describe, expect, it } from "bun:test";
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
  /** The consumer, when the fixture wired one; the second command otherwise. */
  readonly entryId: string;
  /** The producer, when the fixture wired one; the first command otherwise. */
  readonly siblingEntryId: string;
  readonly producerCommandId: string;
  /** The producer's output placeholder, for binding it by hand. */
  readonly outputId: string;
  readonly objectId: string;
  /** How many times the queue tried to actually run something. */
  runAttempts(): number;
}

interface FixtureOptions {
  readonly concurrencyLimit?: number;
  /**
   * Wire the second command to the first's output placeholder, so one entry
   * genuinely consumes what the other produces — the shape every in-batch rule is
   * about, and one the unwired fixture cannot express.
   */
  readonly wired?: boolean;
}

function fixture(options: FixtureOptions | number = {}): Fixture {
  const settings: FixtureOptions =
    typeof options === "number" ? { concurrencyLimit: options } : options;
  const concurrencyLimit = settings.concurrencyLimit ?? 4;
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
  // Producing, so the commands have output placeholders: an in-batch dependency is
  // one command consuming another's declared output, and a definition that declares
  // none cannot express the shape at all.
  const definition = api.commands.define({
    name: "Do it",
    instruction: "Do it.",
    model: "fixture-model",
    effort: "medium",
    lifecycle: "producing",
    outcome: { name: "result", kind: "document", conditions: [] },
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

  // Something for the producer to have produced, so a test can bind the
  // placeholder by hand and ask what the queue makes of that.
  const produced = api.objects.write({
    kind: "document",
    title: "The result",
    renderings: {
      card: { text: "produced" },
      summary: "produced",
      agentContent: "the upstream command's result",
    },
  });

  const outputId = first.outputs[0]?.id as string;

  if (settings.wired === true) {
    const placeholder = api.graph.place({
      role: "content",
      refId: outputId,
      workstreamId: workstream.id,
    });
    api.graph.addContextEdge({
      from: placeholder.id,
      to: second.node.id,
      author: humanAuthor,
    });
  }

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
    producerCommandId: first.command.id,
    outputId,
    objectId: produced.objectId,
    runAttempts: () => attempts,
  };
}

describe("the concurrency limit (§11, Epic 8.3)", () => {
  it("applies a live change to the next preview, without a restart", () => {
    const { queue, producerCommandId } = fixture({ concurrencyLimit: 2 });

    const before = queue.preview({
      scope: "subgraph",
      scopeId: producerCommandId,
    });
    expect(before.concurrency.limit).toBe(2);

    queue.setConcurrencyLimit(7);

    const after = queue.preview({
      scope: "subgraph",
      scopeId: producerCommandId,
    });
    expect(after.concurrency.limit).toBe(7);
  });
});

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

describe("a producer that will never produce (§4.1)", () => {
  /**
   * "Not done" and "not finished yet" are different facts, and reading one for the
   * other stranded the downstream command for ever. A producer that failed, was
   * cancelled, or was interrupted is not going to produce, so an entry waiting on
   * one is waiting for something that is not coming.
   *
   * What happens next depends on whether the entry can run *anyway*: if the output
   * it consumes is still unbound it never can, and it is settled with a reason
   * naming the producer; if somebody supplied that input another way it is not
   * doomed at all, and the ordinary contract check re-asks because what it would
   * assemble changed.
   */
  it("settles a downstream whose producer failed, and lets the batch finish", async () => {
    const board = fixture({ wired: true });

    // Repro 1: the producer fails, which pauses the batch and moves the downstream
    // from `queued` to `paused` (§4.1). The operator addresses the failure outside
    // the batch and resumes — the gesture the pause instructs.
    board.stores.queue.settle(board.siblingEntryId, "failed", "failed");
    board.stores.queue.pauseBatch(board.batchId, "a run in this batch failed");
    expect(board.stores.queue.entry(board.entryId).state).toBe("paused");

    await board.queue.resumeBatch(board.batchId, humanAuthor);

    // Before the fix this sat `queued` for ever: the gate asked "is the producer
    // done?", the answer was no and always would be, and nothing ever said so.
    const settled = board.stores.queue.entry(board.entryId);
    expect(settled.state).toBe("cancelled");
    expect(settled.detail).toContain("settled without producing");
    expect(settled.detail).toContain(board.producerCommandId);

    // Nothing was run to discover that. Sending it down the run path would have
    // provisioned a workspace before refusing, and recorded the refusal as this
    // command failing — which is not what happened; it never started.
    expect(board.runAttempts()).toBe(0);

    // And the batch is finished rather than back at "running" with nothing running.
    expect(board.stores.queue.batch(board.batchId).state).toBe("completed");
    expect(board.stores.queue.waiting()).toHaveLength(0);
  });

  it("settles a downstream whose producer was cancelled, with no pause to prompt it", async () => {
    const board = fixture({ wired: true });

    // Repro 2: the operator cancels the upstream while the batch is still running.
    // Nothing pauses and nothing fails, so before the fix there was no signal at
    // all — the downstream simply waited for a command that had been called off.
    await board.queue.cancel(board.siblingEntryId, humanAuthor);

    const settled = board.stores.queue.entry(board.entryId);
    expect(settled.state).toBe("cancelled");
    expect(settled.detail).toContain("settled without producing");
    expect(board.runAttempts()).toBe(0);

    // Cancelling one entry is what made the other unviable, so the consequence
    // lands on the same gesture rather than waiting for an unrelated session to end.
    expect(board.stores.queue.batch(board.batchId).state).toBe("completed");
  });

  it("does not condemn a downstream whose input arrived another way", async () => {
    const board = fixture({ wired: true });

    // The same dead producer — but the operator supplied the output themselves, so
    // this entry is perfectly runnable. Settling it would refuse work that can run.
    // Bound for real, through the store that binds it after a run: the point of the
    // check is that a *bound* output leaves the entry runnable, so faking the bind
    // would fake the thing under test.
    const produced = board.stores.runs.start({
      commandId: board.producerCommandId,
    });
    board.stores.commands.bindOutput(board.outputId, {
      objectId: board.objectId,
      runId: produced.run.id,
    });
    board.stores.queue.settle(board.siblingEntryId, "failed", "failed");

    await board.queue.drain();

    // It is not cancelled: it re-asks, because what it would assemble is no longer
    // what was previewed — which is the honest answer to "this changed while you
    // waited" (§4.1), and the operator can confirm it.
    const entry = board.stores.queue.entry(board.entryId);
    expect(entry.state).toBe("needs_reask");
    expect(entry.settledAt).toBeNull();
    expect(board.runAttempts()).toBe(0);
  });

  it("still waits while a producer is genuinely unfinished", async () => {
    const board = fixture({ wired: true });

    // The rule it must not break: a producer that has not run yet is not a producer
    // that will never run, and the downstream waits rather than being condemned.
    board.stores.queue.markStarting(board.siblingEntryId);

    await board.queue.drain();

    const entry = board.stores.queue.entry(board.entryId);
    expect(entry.state).toBe("queued");
    expect(entry.settledAt).toBeNull();
    expect(board.stores.queue.batch(board.batchId).state).toBe("running");
  });
});

describe("resuming a batch with nothing left to do (§4.1)", () => {
  it("settles it instead of returning it to running-forever", async () => {
    const board = fixture({ wired: true });

    // Every entry already settled — the shape a restart leaves behind when the one
    // run in a batch was interrupted. Resuming is what the pause tells the operator
    // to do, so resuming must not be how the batch gets stuck.
    board.stores.queue.settle(board.siblingEntryId, "interrupted", "restarted");
    board.stores.queue.settle(board.entryId, "cancelled", "nothing to consume");
    board.stores.queue.pauseBatch(board.batchId, "a run was interrupted");

    const resumed = await board.queue.resumeBatch(board.batchId, humanAuthor);

    expect(resumed.state).toBe("completed");
    expect(resumed.settledAt).not.toBeNull();
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
