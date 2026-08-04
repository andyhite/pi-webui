import { createHash } from "node:crypto";
import {
  estimateRunCost,
  isQueuedRunCancellable,
  isQueuedRunSettled,
  type Author,
  type CommandId,
  type CostEstimate,
  type DomainEvent,
  type QueuedRun,
  type QueuedRunState,
  type RunBatch,
  type RunId,
  type RunScopeKind,
  type SessionEnd,
  type SessionId,
  type WorkstreamId,
} from "@plotroom/core";
import type { RunBatchRow, RunPreview, RunQueueRow } from "@plotroom/db";
import type { EventBus } from "../events/bus.js";
import { refused } from "../http/errors.js";
import type { Logger } from "../logging/logger.js";
import type { ApiStores } from "../routes/api.js";
import type { RunOneInput, RunOneResult, RunService } from "./service.js";
import { checkRunGesture } from "./delegation.js";
import {
  consumedOutputsOf,
  dependenciesOf,
  resolveScope,
  type ScopedCommand,
} from "./scopes.js";

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

  /**
   * A mutable copy of `deps.concurrencyLimit`, so a settings write can change
   * it without a restart (§11, Epic 8.3) — `deps` itself stays exactly what
   * every other field on it always was: read once, at construction.
   */
  #concurrencyLimit: number;

  constructor(private readonly deps: RunQueueDeps) {
    this.#concurrencyLimit = deps.concurrencyLimit;
  }

  /** Epic 8.3's live setting: applies to the next admission decision, not retroactively. */
  setConcurrencyLimit(limit: number): void {
    this.#concurrencyLimit = limit;
  }

  /** The limit currently in force — the fleet read's own source (§8, §11). */
  get concurrencyLimit(): number {
    return this.#concurrencyLimit;
  }

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

    // The hash each command *would* be admitted under, with the in-batch rule
    // applied over this very scope — so the preview and the entry it becomes
    // cannot disagree about what was agreed (§4.1).
    const inScope = resolved.commands.map((command) => command.commandId);
    const commands = resolved.commands.map((command) => {
      const preview = stores.runs.preview(command.commandId);
      const scope = this.contractScope(
        command.commandId,
        inScope.filter((other) => other !== command.commandId),
      );
      return {
        ...command,
        preview,
        contractHash: contractHashOf(preview, scope),
        /** True when the batch itself is what makes this command runnable. */
        satisfiedByBatch: scope.dependsOnBatch === true,
      };
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
      Math.min(commands.length, this.#concurrencyLimit - running),
    );

    return {
      scope: resolved.scope,
      scopeId: resolved.scopeId,
      commands,
      estimate: aggregateEstimate(commands.map((entry) => entry.preview)),
      blocked,
      concurrency: {
        limit: this.#concurrencyLimit,
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

    // §4.1's lineage rule over the whole scope, before anything is recorded: "a
    // session cannot run, resume, or re-run itself or anything in its own
    // initiation chain". Checked here rather than only at each admission, so a
    // scope a session may not run is refused as one gesture instead of becoming a
    // batch whose entries fail one at a time.
    checkRunGesture(this.deps.stores, {
      actor: input.actor,
      tool: "run_scope",
      commandIds: preview.commands.map((command) => command.commandId),
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

    const inScope = preview.commands.map((command) => command.commandId);
    const entries = preview.commands.map((command) =>
      stores.queue.enqueue({
        batchId: batch.id,
        commandId: command.commandId,
        // Derived from the batch key, so each command in the scope is its own
        // idempotent initiation into the run path that already existed.
        initiationKey: `${input.initiationKey}:${command.commandId}`,
        position: command.position,
        contractHash: command.contractHash,
        contract: contractOf(
          command.preview,
          this.contractScope(
            command.commandId,
            inScope.filter((other) => other !== command.commandId),
          ),
        ),
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
      this.runningCount() < this.#concurrencyLimit
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
      // A batch of one produces nothing for itself, so the in-batch rule excludes
      // nothing here and every input binds — which is what a single command being
      // queued should mean.
      contractHash: contractHashOf(preview),
      contract: contractOf(preview),
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
      ...(input.spendCapMicros === undefined
        ? {}
        : { spendCapMicros: input.spendCapMicros }),
      detail: `waiting for a session slot: ${this.#concurrencyLimit} of ${this.#concurrencyLimit} are in use`,
    });

    this.publishBatch(batch, "created", input.actor);
    this.publishEntry(entry, "created", input.actor);

    // Positioned like everything else in the queue, not hard-coded: "a queued run
    // is visible as queued, shows its position" (§4.1), and a caller told it is at
    // position zero has been told something that is not true of any queue.
    return { admitted: false, queued: this.toQueuedRun(entry) };
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

  /**
   * "Can be cancelled before it starts" (§4.1) — and only before.
   *
   * Draining afterwards is not tidiness: cancelling an entry can be what makes
   * another one unviable (a downstream whose producer has just been called off) or
   * admissible, and the consequence belongs to the gesture that caused it rather
   * than to whatever unrelated session happens to end next.
   */
  async cancel(entryId: string, actor: Author): Promise<QueuedRun> {
    const entry = this.deps.stores.queue.entry(entryId);
    checkRunGesture(this.deps.stores, {
      actor,
      tool: "run_queue_cancel",
      commandIds: [entry.commandId],
    });

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
    await this.drain();
    return this.toQueuedRun(this.deps.stores.queue.entry(entryId));
  }

  /**
   * The re-ask, answered (§4.1): the operator has seen what changed and accepts
   * the new contract. This is the only path out of `needs_reask` other than
   * cancelling — the entry is never quietly re-queued under a contract nobody
   * agreed to, which is the whole point of recording one.
   */
  async confirm(entryId: string, actor: Author): Promise<QueuedRun> {
    const entry = this.deps.stores.queue.entry(entryId);
    // Confirming is agreeing to run it, so it is checked like running it.
    checkRunGesture(this.deps.stores, {
      actor,
      tool: "run_queue_confirm",
      commandIds: [entry.commandId],
    });

    if (entry.state !== "needs_reask") {
      throw refused({
        reason: "not_reasking",
        message: `this run is ${entry.state}; only a run whose inputs drifted while it waited is asking to be confirmed`,
      });
    }

    // What the batch is doing outranks the entry's own state. Confirming into a
    // batch that may not run would queue a row nothing is allowed to admit — and
    // the drain that follows would then keep reading it as "the next thing to
    // admit" forever.
    const batch = this.deps.stores.queue.batch(entry.batchId);
    if (batch.state === "aborted" || batch.state === "completed") {
      throw refused({
        reason: "batch_not_running",
        message: `this run belongs to a batch that is ${batch.state}; there is nothing left for a confirmation to start${batch.state === "aborted" ? " — stopped means stopped (§4.1)" : ""}`,
      });
    }

    const preview = this.deps.stores.runs.preview(entry.commandId);
    const contract = this.contractFor(entry, preview);

    // A paused batch keeps the answer and does not act on it: the operator has
    // agreed to this contract, and resuming the batch is the separate gesture that
    // starts the remainder (§4.1 — the product never decides to resume).
    const paused = batch.state === "paused";
    const reconfirmed = this.deps.stores.queue.reconfirm(entryId, {
      hash: contract.hash,
      contract: contract.contract,
      ...(paused
        ? {
            state: "paused" as const,
            detail:
              "confirmed; it runs when the batch this belongs to is resumed (§4.1)",
          }
        : {}),
    });

    this.publishEntry(reconfirmed, "updated", actor);
    if (!paused) await this.drain();
    return this.toQueuedRun(this.deps.stores.queue.entry(entryId));
  }

  /** The human gesture that starts a paused batch's remainder (§4.1). */
  async resumeBatch(batchId: string, actor: Author): Promise<RunBatch> {
    const batch = this.deps.stores.queue.batch(batchId);
    // Resuming is initiating the remainder, so every command still in it is
    // checked as if it were being run now.
    checkRunGesture(this.deps.stores, {
      actor,
      tool: "run_batch_resume",
      commandIds: this.deps.stores.queue
        .entriesForBatch(batchId)
        .filter((entry) => entry.settledAt === null)
        .map((entry) => entry.commandId),
    });

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

    // A resume can find nothing to do: everything left in the batch may already be
    // settled — the single-entry batch a restart interrupted is exactly that, and
    // resuming it is the gesture the pause instructs. Without this the batch goes
    // back to "running" and stays there with nothing running, which is the same
    // symptom, reached through the remedy.
    this.settleBatch(batchId, actor);

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

    this.settleEntryFor(entry, event.session.end);

    // The slot is free either way, and what is waiting behind this was initiated
    // by somebody's gesture: pausing or aborting *this* batch is not a reason to
    // hold up another one. Admission is per entry; the batch verbs decide only
    // about their own entries.
    await this.drain();
  }

  /**
   * One session end becomes one entry outcome.
   *
   * The switch is **exhaustive on purpose** — no `default`. A `default` here is how
   * a new end kind gets silently recorded as `done`, which is exactly the bug an
   * interrupted session used to hit: nobody stopped it, it did not fail, and it did
   * not finish, and the queue reported success. A seventh end kind must fail to
   * compile rather than be quietly called done (principle 11).
   */
  private settleEntryFor(entry: RunQueueRow, end: SessionEnd): void {
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
        return;

      case "interrupted":
        // Its own outcome, and a pause rather than a failure: a restart caught this
        // in flight, so the remainder waits for the human who decides whether to
        // resume it (principle 11, and §4.1's pause is the same shape — somebody
        // has to address it).
        this.deps.stores.queue.settle(entry.id, "interrupted", end.message);
        this.pauseBatch(
          entry.batchId,
          "a run in this batch was interrupted rather than finishing; address it and resume (§4.1, principle 11)",
        );
        return;

      case "stopped":
        // "A user stop aborts the remainder rather than pausing it: stopped means
        // stopped." A budget stop arrives as out-of-budget above, so what reaches
        // here is the operator's own stop.
        this.deps.stores.queue.settle(entry.id, "cancelled", "stopped by user");
        this.abortBatch(
          entry.batchId,
          "a run in this batch was stopped; stopped means stopped (§4.1)",
        );
        return;

      case "completed":
      case "ended-by-user":
        this.deps.stores.queue.settle(entry.id, "done", end.kind);
        this.settleBatch(entry.batchId, { kind: "human" });
        return;

      default:
        // The assertion that makes the exhaustiveness real rather than intended.
        // A `switch` of bare `return`s over a union compiles perfectly well with a
        // case missing — the function just returns `undefined` for it, which is how
        // an interrupted session was silently reported as `done` in the first place.
        // This line is what fails to compile when a seventh end kind is added.
        end satisfies never;
        return;
    }
  }

  /* -------------------------------------------------------- the contract */

  /**
   * This entry's contract, with the in-batch rule applied (see {@link RunContract}).
   *
   * Derived rather than stored, from the batch's own command list — which is stable
   * for the life of the batch — so the exclusion set computed at enqueue time and
   * the one computed at admission time cannot disagree. Storing it would be a
   * second copy of a fact the rows already carry.
   */
  private contractFor(
    entry: RunQueueRow,
    preview: RunPreview,
  ): { readonly hash: string; readonly contract: RunContract } {
    const siblings = this.deps.stores.queue
      .entriesForBatch(entry.batchId)
      .map((sibling) => sibling.commandId)
      .filter((commandId) => commandId !== entry.commandId);

    const scope = this.contractScope(entry.commandId, siblings);
    return {
      hash: contractHashOf(preview, scope),
      contract: contractOf(preview, scope),
    };
  }

  /**
   * How this entry stands with respect to the commands in its own batch that it
   * consumes from.
   *
   * Three answers, and the middle one used to be missing — which stranded a
   * downstream command for ever whenever its producer failed, was cancelled, or was
   * interrupted. "Not done" is not the same fact as "not finished yet": a settled
   * producer will never produce, and an entry waiting on one is waiting for
   * something that is not coming.
   *
   * - `waiting` — a producer is still going to run. The entry stays queued.
   * - `abandoned` — a producer has settled without producing, **and** the output
   *   this entry consumes is still unbound, so this entry can never run. It is
   *   settled with a reason naming the producer.
   * - `ready` — every producer is done, or an unfinished one's output arrived by
   *   some other route. The ordinary contract check decides from here: if somebody
   *   bound or rewired that input outside the batch, the hash no longer matches and
   *   it re-asks, which is the right answer to "this changed while you waited".
   *
   * The distinction is what stops a producer's failure from either wedging the
   * downstream or condemning it: a downstream whose input the operator supplied
   * another way is not doomed, and one whose input nobody supplied is not viable.
   */
  private inBatchStanding(
    entry: RunQueueRow,
  ):
    | { readonly kind: "ready" }
    | { readonly kind: "waiting"; readonly producers: readonly string[] }
    | { readonly kind: "abandoned"; readonly producers: readonly string[] } {
    const siblings = this.deps.stores.queue
      .entriesForBatch(entry.batchId)
      .filter((sibling) => sibling.commandId !== entry.commandId);
    if (siblings.length === 0) return { kind: "ready" };

    const stateOf = new Map(
      siblings.map((sibling) => [sibling.commandId, sibling.state]),
    );
    const consumed = consumedOutputsOf(
      this.deps.stores,
      entry.commandId,
    ).filter((input) => stateOf.has(input.producerCommandId));

    const waiting = new Set<string>();
    const abandoned = new Set<string>();

    for (const input of consumed) {
      const state = stateOf.get(input.producerCommandId);
      if (state === "done") continue;

      // A settled producer is not going to produce. It only *strands* this entry if
      // what it was going to produce is still missing; an output that arrived by
      // another route leaves this entry perfectly runnable.
      const settled = isQueuedRunSettled(state as QueuedRunState);
      if (settled) {
        if (!input.bound) abandoned.add(input.producerCommandId);
        continue;
      }

      waiting.add(input.producerCommandId);
    }

    // Abandonment is decided first: an entry with one dead producer and one live
    // one is not viable however long it waits for the live one, and saying so now
    // is better than saying it later.
    if (abandoned.size > 0) {
      return { kind: "abandoned", producers: [...abandoned].sort() };
    }
    if (waiting.size > 0) return { kind: "waiting", producers: [...waiting] };
    return { kind: "ready" };
  }

  /**
   * The exclusion set for one command against the others in its scope.
   *
   * What "produced by a sibling" means concretely: the sibling's output
   * placeholders, and whatever object each has bound to. A downstream input node
   * points at the placeholder before the upstream runs and at the bound object
   * after it, so both spellings have to be in the set for the rule to hold across
   * exactly the moment it exists for.
   */
  private contractScope(
    commandId: string,
    siblingCommandIds: readonly string[],
  ): ContractScope {
    if (siblingCommandIds.length === 0) return {};

    const produced = new Set<string>();
    for (const sibling of siblingCommandIds) {
      for (const output of this.deps.stores.commands.outputs(sibling)) {
        produced.add(output.id);
        if (output.boundObjectId !== null) produced.add(output.boundObjectId);
      }
    }

    // Whether *this* command consumes any of it — which is what decides whether
    // `runnable` is part of what was agreed.
    const dependsOnBatch = dependenciesOf(this.deps.stores, commandId).some(
      (dependency) => siblingCommandIds.includes(dependency),
    );

    return { producedInBatch: produced, dependsOnBatch };
  }

  /* -------------------------------------------------------------- recovery */

  /**
   * Reconcile the queue with what actually happened, then admit what is waiting.
   *
   * Called once at boot, after `RunService.recoverFromRestart` has recorded every
   * in-flight session as **interrupted**. Two things are true here and nowhere
   * else:
   *
   * - an entry the queue believes is `running` has a session that ended while
   *   nothing was subscribed to hear it, so its outcome was never applied. Left
   *   alone, its batch stays `running` forever and the operator is shown work in
   *   flight that no process is doing (principle 11's whole point);
   * - nothing is running, so every queued entry is admissible.
   *
   * **The drain is not a timer** (§4.1): every entry it admits was already
   * initiated by a human or a session gesture, and a restart does not un-initiate
   * one. The system is deciding *when* the work it was told to do happens — never
   * *whether* — which is what queuing is, and refusing to admit at boot would mean
   * a restart silently dropped work somebody asked for.
   */
  async recoverAfterRestart(): Promise<{
    readonly reconciled: readonly string[];
    readonly admitted: number;
  }> {
    const { stores } = this.deps;
    const reconciled: string[] = [];

    for (const entry of stores.queue.inFlightEntries()) {
      if (entry.sessionId === null) {
        // Admitted, never bound to a session: the process died between the two.
        // It goes back to `queued`, where its contract is re-checked like any
        // other admission rather than assumed still true.
        const requeued = stores.queue.reconfirmNothing(entry.id);
        this.publishEntry(requeued, "updated", { kind: "human" });
        reconciled.push(entry.id);
        continue;
      }

      const session = stores.sessions.get(entry.sessionId);
      const end = session.session.end;
      if (end === null) continue;

      this.settleEntryFor(entry, end);
      reconciled.push(entry.id);
    }

    if (reconciled.length > 0) {
      this.deps.logger.warn("reconciled queued runs a restart left in flight", {
        entryIds: reconciled,
      });
    }

    const waitingBefore = stores.queue.waiting().length;
    await this.drain();
    const waitingAfter = stores.queue.waiting().length;

    return { reconciled, admitted: waitingBefore - waitingAfter };
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

        // Every entry this pass has already looked at. The loop advances because
        // `admit` always moves the row it declines — but relying on that would make
        // a hung server one forgotten branch away, so the loop is *also* unable to
        // consider an entry twice. Both belts: the row moves, and a row that
        // somehow did not move is still never read again.
        const attempted = new Set<string>();

        for (;;) {
          const running = this.runningCount();
          if (running >= this.#concurrencyLimit) break;

          const next = this.deps.stores.queue
            .waiting()
            .find((candidate) => !attempted.has(candidate.entry.id));
          if (next === undefined) break;
          attempted.add(next.entry.id);

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
      // The batch changed underneath this row. Whatever the reason, the row must
      // leave `queued`: an admission path that declines without moving the entry
      // leaves the drain loop reading the same "next" entry forever, which is a
      // hung server rather than a refusal. So this branch decides the row's fate
      // rather than deferring it to a verb that may never be called.
      const declined =
        batch.state === "paused"
          ? stores.queue.park(
              entry.id,
              batch.pauseReason ??
                "the batch this belongs to is paused; resume it to run the remainder (§4.1)",
            )
          : stores.queue.settle(
              entry.id,
              "cancelled",
              `the batch this belongs to is ${batch.state}`,
            );
      this.publishEntry(declined, "updated", actorOfBatch(batch));
      return false;
    }

    // Where this entry stands with its own batch. This is the other half of the
    // in-batch rule — excluding those inputs from the contract stops it *re-asking*,
    // and this stops it *running* before what it consumes exists. Without it a
    // subgraph under a limit of two would admit the downstream command immediately
    // and the run path would refuse it for an input nothing had produced yet.
    const standing = this.inBatchStanding(entry);

    if (standing.kind === "waiting") {
      // Its turn has not come. It stays `queued` on purpose: nothing is wrong with
      // it, and the drain moves on because it never considers an entry twice in one
      // pass.
      return false;
    }

    if (standing.kind === "abandoned") {
      // Its producer settled without producing, so this will never run. Settled here
      // rather than sent down the run path: that path would provision a workspace
      // before refusing, and it would record the refusal as this command *failing*,
      // which is not what happened — it never started.
      const named = standing.producers.join(", ");
      const settled = stores.queue.settle(
        entry.id,
        "cancelled",
        `it consumes an output of ${named}, which settled without producing it; this run cannot happen`,
      );
      this.publishEntry(settled, "updated", actorOfBatch(batch));
      this.deps.logger.warn("a queued run's producer will never produce", {
        entryId: entry.id,
        commandId: entry.commandId,
        producers: standing.producers,
      });
      // The batch may now have nothing left to do, and a batch that sat at
      // "running" with nothing running is the symptom this whole family of defects
      // shares.
      this.settleBatch(entry.batchId, actorOfBatch(batch));
      return false;
    }

    const preview = stores.runs.preview(entry.commandId);
    const { hash } = this.contractFor(entry, preview);

    if (hash !== entry.contractHash) {
      const reasked = stores.queue.markNeedsReask(
        entry.id,
        describeContractChange(
          JSON.parse(entry.contractJson) as RunContract,
          this.contractFor(entry, preview).contract,
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

      // A session can end *before* the row that names it is written: the runtime's
      // stream is already draining while `runOne` is still returning, and a
      // scripted or instantly-failing session gets all the way to its end state
      // first. The end event then finds no entry for that session and the row sits
      // in `running` forever — an entry nothing will ever settle, and a batch that
      // never finishes.
      //
      // So the binding is followed by a look at what already happened. Settling
      // twice is not possible: the event path skips an entry that has a
      // `settled_at`, and this path only ever runs once per admission.
      const ended = stores.sessions.get(started.session.session.id).session.end;
      if (ended !== null) {
        this.settleEntryFor(stores.queue.entry(entry.id), ended);
      }

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
 * The configuration, plus every input with the exact version and content that went
 * in, in assembly order. The content hashes alone would miss a model change; the
 * configuration alone would miss an edited input; the ordinals are what make
 * "assembly order is edge order" (§3.5) part of what was agreed rather than an
 * accident of it.
 *
 * Per-input hashes rather than one hash over the assembled body, deliberately: the
 * body is a function of the ordered parts, so it covers nothing extra — and one
 * opaque hash cannot express **the in-batch rule** below, which needs to leave
 * some inputs out and keep the rest binding.
 *
 * ## The in-batch rule (§4.1)
 *
 * A subgraph or what's-missing scope is one gesture over a chain the operator
 * previewed *as a chain*: they were shown that the downstream command consumes the
 * upstream command's output. So when the upstream runs and binds that output, the
 * downstream's input appearing is **the contract executing, not the contract
 * drifting** — re-asking there would ask the operator to confirm the thing they
 * just confirmed, and a batch of two could never run unattended.
 *
 * Inputs produced by another command *in the same batch* are therefore excluded
 * from this entry's hash, and so is `runnable`, whose flip from false to true is
 * caused by exactly that binding. Everything else still binds: an input from
 * **outside** the batch that changes while this entry waits re-asks exactly as
 * before, and so does a configuration change.
 */
export interface RunContract {
  readonly configuration: unknown;
  readonly inputs: readonly {
    readonly ordinal: number;
    readonly objectId: string;
    readonly versionId: string;
    readonly contentHash: string;
  }[];
  /**
   * Null when this entry depends on a command in its own batch: whether it is
   * runnable *now* is not what was agreed, because the batch itself is what makes
   * it runnable. Boolean otherwise.
   */
  readonly runnable: boolean | null;
  /**
   * The object ids left out because the batch produces them, listed so the record
   * says which exclusions were applied rather than leaving them to be re-derived.
   */
  readonly producedInBatch: readonly string[];
}

export interface ContractScope {
  /**
   * Object and output ids this entry's own batch produces. An input matching one
   * of these is the chain executing, not drifting.
   */
  readonly producedInBatch?: ReadonlySet<string>;
  /** True when this entry consumes something its own batch produces. */
  readonly dependsOnBatch?: boolean;
}

export function contractOf(
  preview: RunPreview,
  scope: ContractScope = {},
): RunContract {
  const produced = scope.producedInBatch ?? new Set<string>();
  const excluded: string[] = [];

  const inputs = preview.inputs.filter((input) => {
    if (!produced.has(input.objectId)) return true;
    excluded.push(input.objectId);
    return false;
  });

  return {
    configuration: preview.configuration,
    inputs: inputs.map((input) => ({
      ordinal: input.ordinal,
      objectId: input.objectId,
      versionId: input.versionId,
      contentHash: input.contentHash,
    })),
    runnable: scope.dependsOnBatch === true ? null : preview.runnable,
    producedInBatch: [...excluded].sort(),
  };
}

export function contractHashOf(
  preview: RunPreview,
  scope: ContractScope = {},
): string {
  return createHash("sha256")
    .update(JSON.stringify(agreedPartOf(contractOf(preview, scope))))
    .digest("hex");
}

/**
 * The part of a contract that *is* the agreement, which is what gets hashed.
 *
 * `producedInBatch` is deliberately outside it. It is a record of which exclusions
 * were applied, and it necessarily changes at exactly the moment the in-batch rule
 * fires — an input the batch produces is absent from the preview before the
 * upstream runs and present after. Hashing it would make the rule cancel itself
 * out: every chain would re-ask on the hop the rule exists to allow.
 */
function agreedPartOf(contract: RunContract): {
  readonly configuration: unknown;
  readonly inputs: RunContract["inputs"];
  readonly runnable: boolean | null;
} {
  return {
    configuration: contract.configuration,
    inputs: contract.inputs,
    runnable: contract.runnable,
  };
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

  const contentBefore = new Map(
    agreed.inputs.map((input) => [input.objectId, input.contentHash]),
  );

  for (const input of now.inputs) {
    const previous = before.get(input.objectId);
    if (previous === undefined) {
      changed.push(`${input.objectId} was added`);
    } else if (previous !== input.versionId) {
      changed.push(`${input.objectId} moved to a new version`);
    } else if (contentBefore.get(input.objectId) !== input.contentHash) {
      // Same version id, different bytes. It should not happen, and saying so
      // plainly is better than a re-ask with no reason attached.
      changed.push(`${input.objectId} changed without a new version`);
    }
    before.delete(input.objectId);
  }
  for (const [objectId] of before) changed.push(`${objectId} was removed`);

  if (changed.length === 0 && orderOf(agreed) !== orderOf(now)) {
    changed.push("its inputs were reordered, which changes what it assembles");
  }
  if (agreed.runnable !== now.runnable) {
    changed.push(
      now.runnable === true
        ? "it is runnable now, where it was not when you asked"
        : "it is no longer runnable",
    );
  }
  if (changed.length === 0) changed.push("its configuration changed");

  return `this run was previewed before it waited, and its inputs changed since: ${changed.join("; ")}. Confirm to run what it would assemble now (§4.1).`;
}

/** Assembly order, as one comparable string (§3.5: edge order is assembly order). */
function orderOf(contract: RunContract): string {
  return contract.inputs
    .map((input) => `${input.ordinal}:${input.objectId}`)
    .join(",");
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
