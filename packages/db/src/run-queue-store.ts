import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  systemClock,
  type Author,
  type Clock,
  type QueuedRunState,
  type RunScopeKind,
} from "@plotroom/core";
import type { PlotroomDatabase } from "./client.js";
import { EntityNotFound } from "./errors.js";
import {
  runBatches,
  runQueue,
  type RunBatchRow,
  type RunQueueRow,
} from "./schema.js";

/**
 * Scoped runs and the queue of work (§4.1, Epic 5.5).
 *
 * Two records, and the distinction between them is the spec's:
 *
 * - a **batch** is one gesture over a scope — run-one, run-subgraph, run-what's
 *   missing, re-run-all-drifted. "One initiation may cover" all of them, so the
 *   client's initiation key covers the whole scope and a double-click cannot
 *   produce two batches (principle 9);
 * - an **entry** is one command inside it, admitted rather than scheduled: "the
 *   human (or session) gesture already happened; the system is only deciding
 *   *when*, never *whether*".
 *
 * Every entry carries the contract it was admitted under, because **the preview
 * is the contract**: "a queued run executes exactly what it previewed, and if
 * its inputs drifted while it waited, it says so and asks rather than silently
 * running something else". `contractHash` is what makes the comparison a fact
 * rather than a hope; nothing here decides what goes into it.
 */
/** States in which an entry is still going to consume a concurrency slot. */
export const RUN_QUEUE_ACTIVE_STATES: readonly QueuedRunState[] = [
  "starting",
  "running",
];

export interface CreateBatchInput {
  readonly initiationKey: string;
  readonly scope: RunScopeKind;
  readonly scopeId: string | null;
  readonly actor: Author;
  readonly spendCapMicros?: number | null;
}

export interface EnqueueInput {
  readonly batchId: string;
  readonly commandId: string;
  /** Derived from the batch key so each command is its own idempotent run. */
  readonly initiationKey: string;
  readonly position: number;
  readonly contractHash: string;
  /** What the preview said, whole — read back when the entry is admitted. */
  readonly contract: unknown;
  readonly spendCapMicros?: number | null;
  readonly detail?: string | null;
  /** The runtime the caller named; omitted means the configured one. */
  readonly runtime?: unknown;
}

export interface QueuedEntry {
  readonly entry: RunQueueRow;
  /** 1-based among the entries still waiting. Visible state, per §4.1. */
  readonly position: number;
}

export class RunQueueStore {
  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {}

  /* --------------------------------------------------------------- batches */

  /**
   * The same gesture is the same batch (principle 9). Returns the existing batch
   * rather than refusing, because a retry asking again is not an error — it is
   * the same request arriving twice.
   */
  batchByKey(initiationKey: string): RunBatchRow | undefined {
    return this.state.db
      .select()
      .from(runBatches)
      .where(eq(runBatches.initiationKey, initiationKey))
      .get();
  }

  createBatch(input: CreateBatchInput): RunBatchRow {
    const id = `batch_${randomUUID()}`;
    this.state.db
      .insert(runBatches)
      .values({
        id,
        initiationKey: input.initiationKey,
        scopeKind: input.scope,
        scopeId: input.scopeId,
        state: "running",
        pauseReason: null,
        actorKind: input.actor.kind,
        actorSession:
          input.actor.kind === "session" ? input.actor.sessionId : null,
        spendCapMicros: input.spendCapMicros ?? null,
        createdAt: this.now(),
        settledAt: null,
      })
      .run();

    return this.batch(id);
  }

  batch(batchId: string): RunBatchRow {
    const row = this.state.db
      .select()
      .from(runBatches)
      .where(eq(runBatches.id, batchId))
      .get();
    if (!row) throw new EntityNotFound("run batch", batchId);
    return row;
  }

  batches(): readonly RunBatchRow[] {
    return this.state.db.select().from(runBatches).all();
  }

  /**
   * §4.1: a failed or out-of-budget session **pauses** the remainder, and it is
   * resumable "once the human addresses it". The entries stay; they do not
   * silently continue, because a batch that carried on past a failure would be
   * the product deciding to spend after something went wrong.
   */
  pauseBatch(batchId: string, reason: string): RunBatchRow {
    this.state.db
      .update(runBatches)
      .set({ state: "paused", pauseReason: reason })
      .where(eq(runBatches.id, batchId))
      .run();

    this.state.db
      .update(runQueue)
      .set({ state: "paused", detail: reason })
      .where(and(eq(runQueue.batchId, batchId), eq(runQueue.state, "queued")))
      .run();

    return this.batch(batchId);
  }

  /**
   * The human gesture that starts the remainder again (principle 2: never the
   * product's own decision). Only paused entries move; a cancelled one stays
   * cancelled.
   */
  resumeBatch(batchId: string): RunBatchRow {
    this.state.db
      .update(runBatches)
      .set({ state: "running", pauseReason: null })
      .where(eq(runBatches.id, batchId))
      .run();

    this.state.db
      .update(runQueue)
      .set({ state: "queued", detail: null })
      .where(and(eq(runQueue.batchId, batchId), eq(runQueue.state, "paused")))
      .run();

    return this.batch(batchId);
  }

  /**
   * §4.1: "a user **stop aborts** the remainder rather than pausing it: stopped
   * means stopped." Everything not yet started is cancelled, and the batch can
   * never be resumed.
   */
  abortBatch(batchId: string, reason: string): RunBatchRow {
    const at = this.now();
    this.state.db
      .update(runBatches)
      .set({ state: "aborted", pauseReason: reason, settledAt: at })
      .where(eq(runBatches.id, batchId))
      .run();

    this.state.db
      .update(runQueue)
      .set({ state: "cancelled", detail: reason, settledAt: at })
      .where(
        and(
          eq(runQueue.batchId, batchId),
          inArray(runQueue.state, ["queued", "paused", "needs_reask"]),
        ),
      )
      .run();

    return this.batch(batchId);
  }

  /** A batch is complete when nothing in it can still run. */
  settleBatchIfFinished(batchId: string): RunBatchRow {
    const batch = this.batch(batchId);
    if (batch.state !== "running") return batch;

    const outstanding = this.entriesForBatch(batchId).filter((entry) =>
      ["queued", "starting", "running", "needs_reask"].includes(entry.state),
    );
    if (outstanding.length > 0) return batch;

    this.state.db
      .update(runBatches)
      .set({ state: "completed", settledAt: this.now() })
      .where(eq(runBatches.id, batchId))
      .run();

    return this.batch(batchId);
  }

  /* --------------------------------------------------------------- entries */

  enqueue(input: EnqueueInput): RunQueueRow {
    const id = `rq_${randomUUID()}`;
    this.state.db
      .insert(runQueue)
      .values({
        id,
        batchId: input.batchId,
        commandId: input.commandId,
        initiationKey: input.initiationKey,
        position: input.position,
        state: "queued",
        contractHash: input.contractHash,
        contractJson: JSON.stringify(input.contract),
        spendCapMicros: input.spendCapMicros ?? null,
        runtimeJson:
          input.runtime === undefined ? null : JSON.stringify(input.runtime),
        runId: null,
        sessionId: null,
        detail: input.detail ?? null,
        enqueuedAt: this.now(),
        startedAt: null,
        settledAt: null,
      })
      .run();

    return this.entry(id);
  }

  entry(id: string): RunQueueRow {
    const row = this.state.db
      .select()
      .from(runQueue)
      .where(eq(runQueue.id, id))
      .get();
    if (!row) throw new EntityNotFound("run queue entry", id);
    return row;
  }

  entriesForBatch(batchId: string): readonly RunQueueRow[] {
    return this.state.db
      .select()
      .from(runQueue)
      .where(eq(runQueue.batchId, batchId))
      .orderBy(asc(runQueue.position), asc(runQueue.enqueuedAt))
      .all();
  }

  /**
   * What is waiting, in the order it will be admitted, with positions. A queued
   * run "is visible as queued, shows its position, and can be cancelled before
   * it starts" (§4.1), so the position is computed here rather than left to a
   * surface to count.
   */
  waiting(): readonly QueuedEntry[] {
    const rows = this.state.db
      .select()
      .from(runQueue)
      .where(eq(runQueue.state, "queued"))
      .orderBy(asc(runQueue.position), asc(runQueue.enqueuedAt))
      .all();
    return rows.map((entry, index) => ({ entry, position: index + 1 }));
  }

  /** Everything a queue surface shows: waiting, in flight, and re-asking. */
  open(): readonly RunQueueRow[] {
    return this.state.db
      .select()
      .from(runQueue)
      .where(
        inArray(runQueue.state, [
          "queued",
          "starting",
          "running",
          "needs_reask",
          "paused",
        ]),
      )
      .orderBy(asc(runQueue.position), asc(runQueue.enqueuedAt))
      .all();
  }

  /** How many admitted entries are consuming a slot right now. */
  activeCount(): number {
    return this.state.db
      .select()
      .from(runQueue)
      .where(inArray(runQueue.state, [...RUN_QUEUE_ACTIVE_STATES]))
      .all().length;
  }

  entryForSession(sessionId: string): RunQueueRow | undefined {
    return this.state.db
      .select()
      .from(runQueue)
      .where(eq(runQueue.sessionId, sessionId))
      .get();
  }

  entryForRun(runId: string): RunQueueRow | undefined {
    return this.state.db
      .select()
      .from(runQueue)
      .where(eq(runQueue.runId, runId))
      .get();
  }

  /** An unsettled entry for this command, if the queue is already holding one. */
  openEntryForCommand(commandId: string): RunQueueRow | undefined {
    return this.state.db
      .select()
      .from(runQueue)
      .where(
        and(
          eq(runQueue.commandId, commandId),
          isNull(runQueue.settledAt),
          inArray(runQueue.state, ["queued", "starting", "needs_reask"]),
        ),
      )
      .get();
  }

  markStarting(id: string): RunQueueRow {
    this.state.db
      .update(runQueue)
      .set({ state: "starting", startedAt: this.now(), detail: null })
      .where(eq(runQueue.id, id))
      .run();
    return this.entry(id);
  }

  markRunning(
    id: string,
    started: { readonly runId: string; readonly sessionId: string },
  ): RunQueueRow {
    this.state.db
      .update(runQueue)
      .set({
        state: "running",
        runId: started.runId,
        sessionId: started.sessionId,
      })
      .where(eq(runQueue.id, id))
      .run();
    return this.entry(id);
  }

  /**
   * The re-ask (§4.1). The entry is not cancelled and not run: it becomes an
   * attention-shaped state carrying what changed, and the confirm gesture is
   * what may admit it again. Recording the fresh contract here would defeat the
   * point — the *new* one is what a human is being asked about.
   */
  markNeedsReask(id: string, detail: string): RunQueueRow {
    this.state.db
      .update(runQueue)
      .set({ state: "needs_reask", detail })
      .where(eq(runQueue.id, id))
      .run();
    return this.entry(id);
  }

  /** Accept the drifted inputs: the contract is replaced and the entry re-queued. */
  reconfirm(
    id: string,
    contract: { readonly hash: string; readonly contract: unknown },
  ): RunQueueRow {
    this.state.db
      .update(runQueue)
      .set({
        state: "queued",
        contractHash: contract.hash,
        contractJson: JSON.stringify(contract.contract),
        detail: null,
      })
      .where(eq(runQueue.id, id))
      .run();
    return this.entry(id);
  }

  settle(
    id: string,
    state: Extract<QueuedRunState, "done" | "failed" | "cancelled">,
    detail: string | null = null,
  ): RunQueueRow {
    this.state.db
      .update(runQueue)
      .set({ state, detail, settledAt: this.now() })
      .where(eq(runQueue.id, id))
      .run();
    return this.entry(id);
  }

  /**
   * Every entry the last process left mid-flight. At the moment this runs, no
   * entry can still be starting: the process that was starting it is gone
   * (principle 11's shape, applied to the queue).
   */
  reclaimUnstarted(): readonly RunQueueRow[] {
    const stranded = this.state.db
      .select()
      .from(runQueue)
      .where(eq(runQueue.state, "starting"))
      .all();

    for (const entry of stranded) {
      this.state.db
        .update(runQueue)
        .set({
          state: "queued",
          startedAt: null,
          detail: "re-queued after a restart interrupted its start",
        })
        .where(eq(runQueue.id, entry.id))
        .run();
    }

    return stranded;
  }

  /** Contract as stored, parsed. */
  contractOf(entry: RunQueueRow): unknown {
    return JSON.parse(entry.contractJson);
  }

  /** The runtime selection as stored, parsed. Null means the configured runtime. */
  runtimeOf(entry: RunQueueRow): unknown {
    return entry.runtimeJson === null ? null : JSON.parse(entry.runtimeJson);
  }
}
