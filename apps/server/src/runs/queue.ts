import { createHash } from "node:crypto";
import {
  estimateRunCost,
  isQueuedRunCancellable,
  type Author,
  type CommandId,
  type CostEstimate,
  type DomainEvent,
  type QueuedRun,
  type QueuedRunState,
  type RunBatch,
  type RunId,
  type RunScopeKind,
  type SessionId,
  type WorkstreamId,
} from "@plotroom/core";
import type { RunBatchRow, RunPreview, RunQueueRow } from "@plotroom/db";
import type { EventBus } from "../events/bus.js";
import { refused } from "../http/errors.js";
import type { Logger } from "../logging/logger.js";
import type { ApiStores } from "../routes/api.js";
import type { RunOneInput, RunOneResult, RunService } from "./service.js";
import { resolveScope, type ScopedCommand } from "./scopes.js";

/**
 * Scoped runs and the queue of work (§4.1, Epic 5.5).
 *
 * Three rules from §4.1 are the whole design, and none of them is a scheduler:
 *
 * 1. **Queuing is admission of already-initiated work, not scheduling.** "The
 *    human (or session) gesture already happened; the system is only deciding
 *    *when*, never *whether*." So there is no timer here and nothing polls: the
 *    queue drains when a slot frees, which it learns from the session events it
 *    already publishes. Nothing the product decides on its own ever enters it
 *    (principle 2).
 * 2. **The preview is the contract.** Every entry records the hash of the preview
 *    it was admitted under. At admission the preview is taken again; if it differs
 *    the entry does **not** run — it becomes an attention-shaped `needs_reask`
 *    carrying what changed, and a human (or the session that initiated it)
 *    confirms the new contract before it is queued again.
 * 3. **A batch pauses on failure and aborts on a stop.** "It pauses on a failed or
 *    out-of-budget session — resumable once the human addresses it — and a user
 *    stop aborts the remainder rather than pausing it: stopped means stopped."
 */
export interface RunQueueDeps {
  readonly stores: ApiStores;
  readonly bus: EventBus;
  readonly logger: Logger;
  readonly runs: RunService;
  /** §4.1's configurable global limit on how many sessions run at once. */
  readonly concurrencyLimit: number;
}

export interface ScopedPreviewEntry extends ScopedCommand {
  readonly preview: RunPreview;
  /** The contract hash this command would be admitted under. */
  readonly contractHash: string;
}

export interface ScopedPreview {
  readonly scope: RunScopeKind;
  readonly scopeId: string | null;
  readonly commands: readonly ScopedPreviewEntry[];
  /**
   * The scope's own cost estimate: the per-command estimates aggregated, with the
   * basis and uncertainty each of them stated. Never a bare number — "an
   * authoritative-looking wrong number is worse than an honest one" (§4.1).
   */
  readonly estimate: CostEstimate;
  /** What would refuse each command, so the affordance can say "waiting on: …". */
  readonly blocked: readonly {
    readonly commandId: string;
    readonly waitingOn: readonly string[];
    /** The scope that would unblock it, offered once (§4.1's reveal-and-run). */
    readonly unblockWith: RunScopeKind;
  }[];
  readonly concurrency: {
    readonly limit: number;
    readonly running: number;
    /** How many of this scope would start now, and how many would queue. */
    readonly startsNow: number;
    readonly queues: number;
  };
  readonly spendCap: {
    readonly suggestedMicros: number | null;
    readonly basis: string;
    readonly accepted: number | null;
  };
}

export interface InitiateScopeInput {
  readonly scope: RunScopeKind;
  readonly scopeId: string | null;
  /** One key covers the whole scope (principle 9). */
  readonly initiationKey: string;
  readonly actor: Author;
  readonly spendCapMicros?: number | null;
}

export interface InitiateScopeResult {
  readonly batch: RunBatch;
  readonly queued: readonly QueuedRun[];
  /** True when this key had already initiated this scope. */
  readonly replayed: boolean;
}

export class RunQueueService {
  #draining = false;

  /** A drain requested while one was in flight; see {@link drain}. */
  #drainAgain = false;

  constructor(private readonly deps: RunQueueDeps) {}

  /* --------------------------------------------------------------- previews */

  /**
   * The scoped preview (§4.1): "every scoped run previews exactly what it will
   * execute and what it may cost before it starts, and accepts a spend cap."
   *
   * Built from the same `RunStore.preview` the single-command path uses, once per
   * command — so a scope cannot claim something the individual previews do not
   * say. A read: it provisions nothing, records nothing, and queues nothing.
   */
  preview(input: {
    readonly scope: RunScopeKind;
    readonly scopeId: string | null;
  }): ScopedPreview {
    const { stores } = this.deps;
    const resolved = resolveScope(stores, input);

    const commands = resolved.commands.map((command) => {
      const preview = stores.runs.preview(command.commandId);
      return { ...command, preview, contractHash: contractHashOf(preview) };
    });

    const blocked = commands
      .filter((entry) => !entry.preview.runnable)
      .map((entry) => ({
        commandId: entry.commandId,
        // The refusals verbatim: "waiting on: …" is the preview's own sentence,
        // not a re-wording of it.
        waitingOn: entry.preview.blockers.map((blocker) => blocker.message),
        // The affordance never disables (§4.1): a blocked command is offered the
        // upstream chain that would unblock it, asked once.
        unblockWith: "missing" as RunScopeKind,
      }));

    const running = this.runningCount();
    const startsNow = Math.max(
      0,
      Math.min(commands.length, this.deps.concurrencyLimit - running),
    );

    return {
      scope: resolved.scope,
      scopeId: resolved.scopeId,
      commands,
      estimate: aggregateEstimate(commands.map((entry) => entry.preview)),
      blocked,
      concurrency: {
        limit: this.deps.concurrencyLimit,
        running,
        startsNow,
        queues: commands.length - startsNow,
      },
      spendCap: {
        // The most expensive prior run of each command in the scope, summed:
        // a cap under that is one this scope has already exceeded once. Null when
        // nothing in it has ever been priced — never zero (§4.1).
        suggestedMicros: suggestedCap(commands.map((entry) => entry.preview)),
        basis: aggregateEstimate(commands.map((entry) => entry.preview))
          .description,
        accepted: null,
      },
    };
  }

  /* -------------------------------------------------------------- initiation */

  /**
   * Admit a scope. One key, one batch, however many commands and however many
   * retries (principle 9) — and the same key answers with the same batch rather
   * than refusing, because a retry is the same request arriving twice.
   */
  async initiate(input: InitiateScopeInput): Promise<InitiateScopeResult> {
    const { stores } = this.deps;

    const existing = stores.queue.batchByKey(input.initiationKey);
    if (existing !== undefined) {
      return {
        batch: toRunBatch(existing),
        queued: stores.queue
          .entriesForBatch(existing.id)
          .map((entry) => this.toQueuedRun(entry)),
        replayed: true,
      };
    }

    const preview = this.preview({
      scope: input.scope,
      scopeId: input.scopeId,
    });

    if (preview.commands.length === 0) {
      // An empty scope is not a refusal and not a batch: "re-run all drifted"
      // with nothing drifted must run nothing at all, and say so.
      throw refused({
        reason: "empty_scope",
        message:
          "nothing in this scope is runnable right now; re-run all drifted runs nothing when nothing has drifted (§4.1)",
      });
    }

    const batch = stores.queue.createBatch({
      initiationKey: input.initiationKey,
      scope: input.scope,
      scopeId: input.scopeId,
      actor: input.actor,
      ...(input.spendCapMicros === undefined
        ? {}
        : { spendCapMicros: input.spendCapMicros }),
    });

    const entries = preview.commands.map((command) =>
      stores.queue.enqueue({
        batchId: batch.id,
        commandId: command.commandId,
        // Derived from the batch key, so each command in the scope is its own
        // idempotent initiation into the run path that already existed.
        initiationKey: `${input.initiationKey}:${command.commandId}`,
        position: command.position,
        contractHash: command.contractHash,
        contract: contractOf(command.preview),
        ...(input.spendCapMicros === undefined
          ? {}
          : { spendCapMicros: input.spendCapMicros }),
        detail: command.reason,
      }),
    );

    this.publishBatch(batch, "created", input.actor);
    for (const entry of entries)
      this.publishEntry(entry, "created", input.actor);

    // Admission, immediately: the gesture already happened, so anything that fits
    // under the limit starts now and the rest waits visibly.
    await this.drain();

    return {
      batch: toRunBatch(stores.queue.batch(batch.id)),
      queued: stores.queue
        .entriesForBatch(batch.id)
        .map((entry) => this.toQueuedRun(entry)),
      replayed: false,
    };
  }

  /**
   * Run one command, bounded by the same limit (§4.1).
   *
   * The limit "bounds how many sessions run at once" — it is a property of
   * initiation, not of one endpoint, so the single-command gesture goes through
   * admission too rather than being a second door that ignores it (cross-cutting
   * rule 3: enforced, not documented).
   *
   * Under the limit this is exactly the run path, unchanged. At the limit it
   * admits instead: one batch of one, visible in the queue with its position and
   * cancellable before it starts. The caller is told which happened rather than
   * being given a run that does not exist yet.
   */
  async runOne(input: {
    readonly commandId: string;
    readonly initiationKey: string;
    readonly actor: Author;
    readonly runtime?: NonNullable<RunOneInput["runtime"]>;
    readonly spendCapMicros?: number | null;
  }): Promise<
    | { readonly admitted: true; readonly result: RunOneResult }
    | { readonly admitted: false; readonly queued: QueuedRun }
  > {
    const { stores } = this.deps;

    // The same gesture twice is the same gesture, whichever side of the limit it
    // landed on the first time (principle 9). A key that already produced a run
    // replays through the run path; a key that already queued answers with that
    // entry, including once it has since started.
    const existing = stores.queue.batchByKey(input.initiationKey);
    if (existing !== undefined) {
      const entry = stores.queue.entriesForBatch(existing.id)[0];
      if (entry !== undefined) {
        if (entry.runId !== null && entry.sessionId !== null) {
          return {
            admitted: true,
            result: await this.deps.runs.runOne({
              commandId: input.commandId,
              initiationKey: entry.initiationKey,
              actor: input.actor,
              ...(input.runtime === undefined
                ? {}
                : { runtime: input.runtime }),
            }),
          };
        }
        return { admitted: false, queued: this.toQueuedRun(entry) };
      }
    }

    if (
      stores.runs.initiation(input.initiationKey) !== undefined ||
      this.runningCount() < this.deps.concurrencyLimit
    ) {
      return {
        admitted: true,
        result: await this.deps.runs.runOne({
          commandId: input.commandId,
          initiationKey: input.initiationKey,
          actor: input.actor,
          ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
          ...(input.spendCapMicros === undefined
            ? {}
            : { spendCapMicros: input.spendCapMicros }),
        }),
      };
    }

    const preview = stores.runs.preview(input.commandId);
    const batch = stores.queue.createBatch({
      initiationKey: input.initiationKey,
      scope: "one",
      scopeId: input.commandId,
      actor: input.actor,
      ...(input.spendCapMicros === undefined
        ? {}
        : { spendCapMicros: input.spendCapMicros }),
    });
    const entry = stores.queue.enqueue({
      batchId: batch.id,
      commandId: input.commandId,
      // The client's own key, unchanged: when this is admitted it enters the run
      // path under the same key the caller used, so the gesture stays one gesture.
      initiationKey: input.initiationKey,
      position: 1,
      contractHash: contractHashOf(preview),
      contract: contractOf(preview),
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
      ...(input.spendCapMicros === undefined
        ? {}
        : { spendCapMicros: input.spendCapMicros }),
      detail: `waiting for a session slot: ${this.deps.concurrencyLimit} of ${this.deps.concurrencyLimit} are in use`,
    });

    this.publishBatch(batch, "created", input.actor);
    this.publishEntry(entry, "created", input.actor);

    return { admitted: false, queued: this.toQueuedRun(entry, 0) };
  }

  /* ------------------------------------------------------------- the queue */

  /** What a queue surface shows: everything open, positioned (§4.1). */
  open(): readonly QueuedRun[] {
    const waiting = new Map(
      this.deps.stores.queue
        .waiting()
        .map((entry) => [entry.entry.id, entry.position]),
    );
    return this.deps.stores.queue
      .open()
      .map((entry) => this.toQueuedRun(entry, waiting.get(entry.id) ?? null));
  }

  batches(): readonly RunBatch[] {
    return this.deps.stores.queue.batches().map((row) => toRunBatch(row));
  }

  /**
   * One batch and **every** entry in it, settled ones included.
   *
   * The open queue deliberately shows only what can still happen; a paused batch
   * is the case where what already happened is the point — "address it and resume"
   * is not actionable if the run that failed has vanished from the read (§4.1,
   * principle 11: a thing that gave up says why).
   */
  batch(batchId: string): {
    readonly batch: RunBatch;
    readonly entries: readonly QueuedRun[];
  } {
    const row = this.deps.stores.queue.batch(batchId);
    return {
      batch: toRunBatch(row),
      entries: this.deps.stores.queue
        .entriesForBatch(batchId)
        .map((entry) => this.toQueuedRun(entry)),
    };
  }

  /** "Can be cancelled before it starts" (§4.1) — and only before. */
  cancel(entryId: string, actor: Author): QueuedRun {
    const entry = this.deps.stores.queue.entry(entryId);
    if (!isQueuedRunCancellable(entry.state as QueuedRunState)) {
      throw refused({
        reason: "already_started",
        message: `this run is ${entry.state}; a queued run is cancellable before it starts, and stopping a started one is a stop (§6.7)`,
      });
    }

    const cancelled = this.deps.stores.queue.settle(
      entryId,
      "cancelled",
      "cancelled before it started",
    );
    this.publishEntry(cancelled, "updated", actor);
    this.settleBatch(cancelled.batchId, actor);
    return this.toQueuedRun(cancelled);
  }

  /**
   * The re-ask, answered (§4.1): the operator has seen what changed and accepts
   * the new contract. This is the only path out of `needs_reask` other than
   * cancelling — the entry is never quietly re-queued under a contract nobody
   * agreed to, which is the whole point of recording one.
   */
  async confirm(entryId: string, actor: Author): Promise<QueuedRun> {
    const entry = this.deps.stores.queue.entry(entryId);
    if (entry.state !== "needs_reask") {
      throw refused({
        reason: "not_reasking",
        message: `this run is ${entry.state}; only a run whose inputs drifted while it waited is asking to be confirmed`,
      });
    }

    const preview = this.deps.stores.runs.preview(entry.commandId);
    const reconfirmed = this.deps.stores.queue.reconfirm(entryId, {
      hash: contractHashOf(preview),
      contract: contractOf(preview),
    });

    this.publishEntry(reconfirmed, "updated", actor);
    await this.drain();
    return this.toQueuedRun(this.deps.stores.queue.entry(entryId));
  }

  /** The human gesture that starts a paused batch's remainder (§4.1). */
  async resumeBatch(batchId: string, actor: Author): Promise<RunBatch> {
    const batch = this.deps.stores.queue.batch(batchId);
    if (batch.state !== "paused") {
      throw refused({
        reason: "not_paused",
        message: `this batch is ${batch.state}; only a paused batch resumes, and an aborted one never does (§4.1)`,
      });
    }

    const resumed = this.deps.stores.queue.resumeBatch(batchId);
    this.publishBatch(resumed, "updated", actor);
    for (const entry of this.deps.stores.queue.entriesForBatch(batchId)) {
      if (entry.state === "queued") this.publishEntry(entry, "updated", actor);
    }

    await this.drain();
    return toRunBatch(this.deps.stores.queue.batch(batchId));
  }

  /* ----------------------------------------------------------------- events */

  /**
   * React to a session ending: settle its entry, and let the next one in.
   *
   * Subscribing to the event stream rather than being called from the run path is
   * deliberate — it is the one vocabulary (principle 8), and it means a session
   * that ended by any route frees its slot. It is not the product originating
   * work: everything it admits was already initiated by a gesture, and nothing
   * here can enqueue.
   */
  subscribe(): () => void {
    return this.deps.bus.subscribe((event) => {
      void this.onEvent(event).catch((error: unknown) => {
        this.deps.logger.error("the run queue could not react to an event", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  private async onEvent(event: DomainEvent): Promise<void> {
    if (event.entity !== "session" || event.verb !== "updated") return;
    if (event.session.end === null) return;

    const entry = this.deps.stores.queue.entryForSession(event.session.id);
    if (entry === undefined || entry.settledAt !== null) {
      // A session that was never queued still held a slot, and its ending still
      // frees one. Not every session comes through the queue — an ordinary run
      // under the limit does not — so the drain cannot be conditional on finding
      // an entry, or the queue would only ever be unblocked by its own runs.
      await this.drain();
      return;
    }

    const end = event.session.end;

    switch (end.kind) {
      case "failed":
      case "out-of-budget":
        // §4.1: a failed or out-of-budget session **pauses** the remainder, and it
        // is resumable "once the human addresses it". Never skipped, never
        // continued past — a batch that spent on after something broke would be
        // the product deciding to.
        this.deps.stores.queue.settle(entry.id, "failed", end.kind);
        this.pauseBatch(
          entry.batchId,
          `a run in this batch ended as ${end.kind}; address it and resume (§4.1)`,
        );
        break;

      case "stopped":
        // "A user stop aborts the remainder rather than pausing it: stopped means
        // stopped." A budget stop arrives as out-of-budget above, so what reaches
        // here is the operator's own stop.
        this.deps.stores.queue.settle(entry.id, "cancelled", "stopped by user");
        this.abortBatch(
          entry.batchId,
          "a run in this batch was stopped; stopped means stopped (§4.1)",
        );
        break;

      default:
        this.deps.stores.queue.settle(entry.id, "done", end.kind);
        this.settleBatch(entry.batchId, { kind: "human" });
        break;
    }

    // The slot is free either way, and what is waiting behind this was initiated
    // by somebody's gesture: pausing or aborting *this* batch is not a reason to
    // hold up another one. Admission is per entry; the batch verbs decide only
    // about their own entries.
    await this.drain();
  }

  /* ---------------------------------------------------------------- draining */

  /**
   * Admit as much as the limit allows.
   *
   * Serialized by a flag rather than a lock: this is called from an event handler
   * and from the initiation path, and two overlapping drains would each see the
   * same free slot and start two runs for it — which is the concurrency limit
   * failing in exactly the way it exists to prevent.
   */
  async drain(): Promise<void> {
    // A drain that arrives while one is running is *recorded*, not dropped. The
    // window is small and real: the last running session can end just after the
    // in-flight drain has taken its final look at the queue, and swallowing that
    // call would leave the queue wedged with a free slot and nobody to notice.
    if (this.#draining) {
      this.#drainAgain = true;
      return;
    }
    this.#draining = true;

    try {
      do {
        this.#drainAgain = false;

        for (;;) {
          const running = this.runningCount();
          if (running >= this.deps.concurrencyLimit) break;

          const next = this.deps.stores.queue.waiting()[0];
          if (next === undefined) break;

          // A re-ask does not free the loop to retry the same entry: it moved out
          // of `queued`, so the next iteration sees whatever is behind it.
          await this.admit(next.entry);
        }
      } while (this.#drainAgain);
    } finally {
      this.#draining = false;
    }
  }

  /**
   * Admit one entry. **The preview is the contract**: the preview is taken again
   * here and compared with the one the entry was admitted under. A difference is
   * not a reason to run something else — it is a reason to ask.
   */
  private async admit(entry: RunQueueRow): Promise<boolean> {
    const { stores } = this.deps;
    const batch = stores.queue.batch(entry.batchId);
    if (batch.state !== "running") {
      // Paused or aborted underneath it; the batch's own verbs own those rows.
      return false;
    }

    const preview = stores.runs.preview(entry.commandId);
    const hash = contractHashOf(preview);

    if (hash !== entry.contractHash) {
      const reasked = stores.queue.markNeedsReask(
        entry.id,
        describeContractChange(
          JSON.parse(entry.contractJson) as RunContract,
          contractOf(preview),
        ),
      );
      this.publishEntry(reasked, "updated", actorOfBatch(batch));
      this.deps.logger.info("a queued run's inputs drifted while it waited", {
        entryId: entry.id,
        commandId: entry.commandId,
      });
      return false;
    }

    const starting = stores.queue.markStarting(entry.id);
    this.publishEntry(starting, "updated", actorOfBatch(batch));

    const runtime = stores.queue.runtimeOf(entry) as NonNullable<
      RunOneInput["runtime"]
    > | null;

    try {
      const started = await this.deps.runs.runOne({
        commandId: entry.commandId,
        initiationKey: entry.initiationKey,
        actor: actorOfBatch(batch),
        // Exactly the runtime the caller named, or the configured one when it
        // named none: a queued run must not quietly change runtimes (§4.1).
        ...(runtime === null ? {} : { runtime }),
        ...(entry.spendCapMicros === null
          ? {}
          : { spendCapMicros: entry.spendCapMicros }),
      });

      const running = stores.queue.markRunning(entry.id, {
        runId: started.run.id,
        sessionId: started.session.session.id,
      });
      this.publishEntry(running, "updated", actorOfBatch(batch));
      return true;
    } catch (error) {
      // A refusal is the run path's, verbatim: the entry records why rather than
      // being retried, and the batch pauses like any other failure so the operator
      // decides what to do about it (principle 11).
      const message = error instanceof Error ? error.message : String(error);
      const failed = stores.queue.settle(entry.id, "failed", message);
      this.publishEntry(failed, "updated", actorOfBatch(batch));
      this.pauseBatch(
        entry.batchId,
        `a run in this batch was refused: ${message}`,
      );
      return false;
    }
  }

  /**
   * How many sessions are running right now — the thing §4.1's limit bounds.
   *
   * Counted from live sessions rather than from queue rows, because the limit is
   * "how many sessions run at once" and a session started outside a batch (the
   * ordinary one-command run) is just as much a session.
   */
  private runningCount(): number {
    return this.deps.stores.sessions.inFlight().length;
  }

  private pauseBatch(batchId: string, reason: string): void {
    const paused = this.deps.stores.queue.pauseBatch(batchId, reason);
    this.publishBatch(paused, "updated", { kind: "human" });
    for (const entry of this.deps.stores.queue.entriesForBatch(batchId)) {
      if (entry.state === "paused") {
        this.publishEntry(entry, "updated", { kind: "human" });
      }
    }
  }

  private abortBatch(batchId: string, reason: string): void {
    const aborted = this.deps.stores.queue.abortBatch(batchId, reason);
    this.publishBatch(aborted, "updated", { kind: "human" });
    for (const entry of this.deps.stores.queue.entriesForBatch(batchId)) {
      if (entry.state === "cancelled") {
        this.publishEntry(entry, "updated", { kind: "human" });
      }
    }
  }

  private settleBatch(batchId: string, actor: Author): void {
    const settled = this.deps.stores.queue.settleBatchIfFinished(batchId);
    if (settled.state === "completed") {
      this.publishBatch(settled, "updated", actor);
    }
  }

  /* --------------------------------------------------------------- publishing */

  private publishBatch(
    batch: RunBatchRow,
    verb: "created" | "updated",
    author: Author,
  ): void {
    this.deps.bus.publish({
      entity: "run_batch",
      verb,
      batch: toRunBatch(batch),
      author,
    });
  }

  private publishEntry(
    entry: RunQueueRow,
    verb: "created" | "updated",
    author: Author,
  ): void {
    this.deps.bus.publish({
      entity: "run_queue_entry",
      verb,
      queued: this.toQueuedRun(entry),
      author,
    });
  }

  private toQueuedRun(
    entry: RunQueueRow,
    position: number | null = null,
  ): QueuedRun {
    const resolved =
      position ??
      this.deps.stores.queue
        .waiting()
        .find((waiting) => waiting.entry.id === entry.id)?.position ??
      null;

    let workstreamId: WorkstreamId | null = null;
    try {
      workstreamId = this.deps.stores.commands.command(entry.commandId)
        .workstreamId as WorkstreamId;
    } catch {
      // A command removed underneath a settled entry is not a reason the queue
      // cannot be read; the entry still says what it did.
      workstreamId = null;
    }

    return {
      id: entry.id,
      batchId: entry.batchId,
      commandId: entry.commandId as CommandId,
      workstreamId,
      position: resolved,
      state: entry.state as QueuedRunState,
      contractHash: entry.contractHash,
      spendCapMicros: entry.spendCapMicros,
      runId: entry.runId === null ? null : (entry.runId as RunId),
      sessionId:
        entry.sessionId === null ? null : (entry.sessionId as SessionId),
      detail: entry.detail,
      enqueuedAt: entry.enqueuedAt,
      startedAt: entry.startedAt,
      settledAt: entry.settledAt,
    };
  }
}

/* ------------------------------------------------------------ the contract */

/**
 * What "the preview is the contract" means, concretely.
 *
 * The assembled body and the configuration, plus the exact versions that went in.
 * The body alone would miss a model change; the versions alone would miss an
 * edit that produced identical bytes. Both, hashed, is the smallest statement of
 * "this is what you agreed to run".
 */
export interface RunContract {
  readonly bodyHash: string;
  readonly configuration: unknown;
  readonly inputs: readonly {
    readonly objectId: string;
    readonly versionId: string;
  }[];
  readonly runnable: boolean;
}

export function contractOf(preview: RunPreview): RunContract {
  return {
    bodyHash: createHash("sha256").update(preview.body).digest("hex"),
    configuration: preview.configuration,
    inputs: preview.inputs.map((input) => ({
      objectId: input.objectId,
      versionId: input.versionId,
    })),
    runnable: preview.runnable,
  };
}

export function contractHashOf(preview: RunPreview): string {
  return createHash("sha256")
    .update(JSON.stringify(contractOf(preview)))
    .digest("hex");
}

/**
 * What changed, in words, for the re-ask. Naming the drifted inputs is the whole
 * value of asking: "it says so and asks rather than silently running something
 * else" is only useful if what it says is specific.
 */
function describeContractChange(agreed: RunContract, now: RunContract): string {
  const before = new Map(
    agreed.inputs.map((input) => [input.objectId, input.versionId]),
  );
  const changed: string[] = [];

  for (const input of now.inputs) {
    const previous = before.get(input.objectId);
    if (previous === undefined) {
      changed.push(`${input.objectId} was added`);
    } else if (previous !== input.versionId) {
      changed.push(`${input.objectId} moved to a new version`);
    }
    before.delete(input.objectId);
  }
  for (const [objectId] of before) changed.push(`${objectId} was removed`);

  if (changed.length === 0 && agreed.bodyHash !== now.bodyHash) {
    changed.push("the assembled content changed");
  }
  if (agreed.runnable !== now.runnable) {
    changed.push(
      now.runnable
        ? "it is runnable now, where it was not when you asked"
        : "it is no longer runnable",
    );
  }
  if (changed.length === 0) changed.push("its configuration changed");

  return `this run was previewed before it waited, and its inputs changed since: ${changed.join("; ")}. Confirm to run what it would assemble now (§4.1).`;
}

/* -------------------------------------------------------------- aggregation */

/**
 * A scope's estimate from its commands'. The basis is the honest sum of theirs,
 * and the range is null — not zero — when nothing in the scope has ever been
 * priced: "a run whose runtime reported no cost is no evidence about money".
 */
function aggregateEstimate(previews: readonly RunPreview[]): CostEstimate {
  const priced = previews.filter((preview) => preview.estimate.range !== null);

  if (priced.length === 0) {
    return estimateRunCost({
      inputTokens: previews.reduce(
        (total, preview) => total + preview.estimatedTokens,
        0,
      ),
      priorRuns: [],
    });
  }

  const low = priced.reduce(
    (total, preview) => total + (preview.estimate.range?.lowMicros ?? 0),
    0,
  );
  const high = priced.reduce(
    (total, preview) => total + (preview.estimate.range?.highMicros ?? 0),
    0,
  );
  const median = priced.reduce(
    (total, preview) => total + (preview.estimate.range?.medianMicros ?? 0),
    0,
  );

  return {
    basis: "prior-runs",
    range: { lowMicros: low, medianMicros: median, highMicros: high },
    inputTokens: previews.reduce(
      (total, preview) => total + preview.estimatedTokens,
      0,
    ),
    // The sentence states its own limits: a scope where only some commands have
    // history is not a scope with a complete range, and saying so is the point
    // (§4.1, principle 7).
    description: `based on ${priced.length} of ${previews.length} command${previews.length === 1 ? "" : "s"} in this scope having priced history; the rest have none, so this range covers only the ones that do`,
    priorRuns: priced.reduce(
      (total, preview) => total + preview.estimate.priorRuns,
      0,
    ),
  };
}

function suggestedCap(previews: readonly RunPreview[]): number | null {
  const priced = previews.filter((preview) => preview.estimate.range !== null);
  if (priced.length === 0) return null;
  return priced.reduce(
    (total, preview) => total + (preview.estimate.range?.highMicros ?? 0),
    0,
  );
}

function actorOfBatch(batch: RunBatchRow): Author {
  return batch.actorKind === "session"
    ? { kind: "session", sessionId: batch.actorSession as SessionId }
    : { kind: "human" };
}

export function toRunBatch(row: RunBatchRow): RunBatch {
  return {
    id: row.id,
    initiationKey: row.initiationKey,
    scope: row.scopeKind,
    scopeId: row.scopeId,
    state: row.state,
    pauseReason: row.pauseReason,
    initiatedBy: actorOfBatch(row),
    spendCapMicros: row.spendCapMicros,
    createdAt: row.createdAt,
    settledAt: row.settledAt,
  };
}
