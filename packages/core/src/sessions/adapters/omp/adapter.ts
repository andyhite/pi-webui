import type {
  Delay,
  EpochMillis,
  InjectedInput,
  InjectionReceipt,
  RequestOutcome,
  RuntimeCapabilities,
  RuntimeObservation,
  RuntimeRequestId,
  RuntimeResumeConfig,
  RuntimeSessionHandle,
  RuntimeSessionRef,
  RuntimeStartConfig,
  SessionEndReason,
  SessionRuntimeAdapter,
  TranscriptPoint,
} from "../../runtime.js";
import { splitJsonLines } from "../jsonl.js";
import { ObservationQueue } from "../observation-queue.js";
import { composeSeededPrompt } from "../seeded-prompt.js";
import {
  encodeSessionHostCommand,
  parseSessionHostEvent,
  type OmpLaunchOptions,
  type SessionHostCommand,
} from "./protocol.js";

/**
 * Adapter v1, embedded: omp inside a PlotRoom-owned session host (issue #73,
 * amending decision 0001).
 *
 * The vendor coupling is not here. `apps/session-host` embeds the agent SDK and
 * writes `RuntimeObservation` values it is typechecked against, so this module
 * owns process lifecycle and the stream and translates nothing — which is the
 * difference from the pi adapter, and the reason a vendor release that renames
 * an event costs one file in the sidecar and no session records.
 *
 * The process itself is injected. `@plotroom/core` has no knowledge of
 * transport (spawning is the server's job), and injecting it is also what makes
 * the adapter testable against a replayed frame stream instead of a live model.
 */
export const OMP_ADAPTER_ID = "omp-session-host";

/**
 * How much of a damaged frame goes into the observation that reports it. Enough
 * to recognise which frame was lost, not enough for one corrupt line to become
 * the largest thing in the log.
 */
const UNREADABLE_FRAME_PREVIEW = 200;

/**
 * How long the sidecar has to report its native session before PlotRoom stops
 * waiting (issue #108).
 *
 * Generous on purpose: the first start on a machine can be the vendor's native
 * addon downloading (296MB, decision 0005) or a credential store answering, and
 * a bound that fired through a legitimate cold start would be worse than the
 * hang it replaced. What it is not is unbounded — a sidecar that never frames
 * `ready` looks healthy from outside, so nothing else can escalate.
 *
 * Exported because the tests select an armed bound by its length, which is the
 * only thing that tells the three apart.
 */
export const READY_TIMEOUT_MS = 180_000;

/**
 * How long a command has to be acknowledged (issue #108).
 *
 * An acknowledgement is queue acceptance and nothing more, so the shipped
 * sidecar sends one synchronously; this is the bound on a runtime that is alive
 * and answering nothing, not on a runtime that is busy.
 */
export const ACK_TIMEOUT_MS = 30_000;

/**
 * How long PlotRoom waits for the frame channel to end after it has asked the
 * sidecar to leave and closed the process (issue #108).
 *
 * The channel outliving the process is possible: anything still holding the
 * write end keeps it open, which is reachable through a foreign executable named
 * by `PLOTROOM_SESSION_HOST` (#92). Short, because by this point the process the
 * frames came from is already gone.
 */
export const STREAM_END_TIMEOUT_MS = 5_000;

/**
 * The sidecar started, stayed alive, and never reported a session.
 *
 * Its own error rather than the stream's "ended before it answered": nothing was
 * observed to go wrong, which is precisely the failure — and a run refused with
 * this sentence tells the operator to look at a live process, not a dead one.
 */
export class SessionHostNotReady extends Error {
  constructor(withinMs: number) {
    super(
      `the session host did not report a session within ${(withinMs / 1000).toString()}s, so PlotRoom stopped waiting and aborted it`,
    );
    this.name = "SessionHostNotReady";
  }
}

/** The sidecar is alive and did not answer a command PlotRoom wrote it. */
export class SessionHostSilent extends Error {
  constructor(command: string, withinMs: number) {
    super(
      `the session host did not acknowledge a ${command} command within ${(withinMs / 1000).toString()}s`,
    );
    this.name = "SessionHostSilent";
  }
}

export const OMP_CAPABILITIES: RuntimeCapabilities = {
  // Native branching exists (`session.branch(entryId)`) but its arithmetic is
  // exclusive of the branched entry, which is not what `TranscriptPoint` means.
  // Until that is re-derived (issue #82) PlotRoom seeds from its own transcript,
  // which `planFork` already does for every runtime that cannot fork natively —
  // so a fork stays expressible here, and its `runtime_mode` will say truthfully
  // that it was seeded. Expressible, not yet reachable: nothing at all runs on
  // this adapter until the gate below is wired, seeded forks included.
  fork: "none",
  // A steering message is consumed at the next turn boundary without a new
  // explicit turn — the §6.5 shape natively.
  injection: "between-turns",
  // Per-turn `usage.cost.total` comes from the SDK's own pricing tables.
  reportsCost: true,
  // Occupancy is available from `getSessionStats()`, which nothing polls yet
  // (issue #82). Estimated from cumulative usage until it does.
  reportsContextWindow: false,
  // The gate is issue #81: an inline tool-call extension calling back into
  // PlotRoom's decision path, with liveness asserted at boot rather than
  // configured. Until that lands and is proven, this adapter says it cannot
  // enforce a decision — and `checkPermissionEnforcement` is what refuses to
  // run work on it, so no session can be started ungated by accident.
  enforcesPermissions: false,
};

/** One live session-host process, as the adapter needs it. */
export interface SessionHostProcess {
  write(line: string): void;
  /**
   * Raw chunks of the sidecar's **private frame channel** — not its stdout
   * (issue #109). The embedded SDK and its native addon print to stdout, and a
   * vendor write interleaving inside a frame corrupted it silently: the
   * observation vanished from the one record the product has. A channel nothing
   * else can reach removes the failure rather than tolerating it, which is why
   * an unreadable line on it is now reported instead of dropped.
   *
   * Framing is this module's job, not the caller's.
   */
  frameChunks(): AsyncIterable<string>;
  /**
   * "graceful" waits for the sidecar to wind down after its `stop` command and
   * escalates if it will not; "abort" terminates the process tree at once.
   */
  close(mode: "graceful" | "abort"): Promise<void>;
}

export type OmpConnect = (
  options: OmpLaunchOptions,
) => Promise<SessionHostProcess>;

export interface OmpAdapterOptions {
  readonly connect: OmpConnect;
  /** Injected clock in milliseconds; observations are stamped at read time. */
  readonly now: () => EpochMillis;
  /**
   * Where the sidecar keeps the SDK's own session files — derived state, not the
   * record (decision 0001).
   */
  readonly sessionDir: string;
  /**
   * Bounded waits, supplied by the host like the clock and the process itself.
   * Required rather than defaulted: the default would have to name a timer this
   * package deliberately cannot see, and a caller that silently got real time
   * would make the two bounds below untestable (issue #108).
   */
  readonly delay: Delay;
}

/**
 * A fork the session host cannot perform natively.
 *
 * Unreachable while `OMP_CAPABILITIES.fork` is `"none"`, because `planFork`
 * reads that and seeds instead. It exists so that flipping the capability
 * without implementing the call is a failure that names itself rather than a
 * session that silently inherited nothing (principle 7).
 */
export class SessionHostForkUnavailable extends Error {
  readonly reason: string;

  constructor(point: TranscriptPoint, reason: string) {
    super(
      `the session host cannot fork at turn ${point.turn.toString()}: ${reason}`,
    );
    this.name = "SessionHostForkUnavailable";
    this.reason = reason;
  }
}

export function createOmpAdapter(
  options: OmpAdapterOptions,
): SessionRuntimeAdapter {
  async function open(
    launch: OmpLaunchOptions,
    prompt: string | null,
  ): Promise<SessionHostHandle> {
    const process = await options.connect(launch);
    const handle = new SessionHostHandle(process, options.now, options.delay);

    try {
      // A handle is only returned once the sidecar has reported the native ref:
      // it is what resume is addressed by, and a session recorded without it is
      // one PlotRoom could never pick up again (§3.6).
      await handle.started();
      // Bounded too, and for the same reason (issue #108): the acknowledgement
      // settles only on a frame or on the stream's end, so a sidecar that framed
      // `ready` and then answered nothing hung this line — with the process
      // looking healthy from outside, exactly like the wait above it.
      if (prompt !== null) await handle.prompt(prompt);
    } catch (error) {
      // No session is being returned, so nothing above will ever stop this
      // process: it holds a workspace and a provider connection, and leaving it
      // running is the leak that made the hang expensive as well as wrong.
      await process.close("abort");
      throw error;
    }

    return handle;
  }

  return {
    id: OMP_ADAPTER_ID,
    capabilities: OMP_CAPABILITIES,

    async start(config: RuntimeStartConfig) {
      return open(
        {
          mode: "start",
          launch: config.launch,
          workspacePath: config.workspacePath,
          sessionDir: options.sessionDir,
        },
        composeSeededPrompt(config),
      );
    },

    async resume(ref: RuntimeSessionRef, config: RuntimeResumeConfig) {
      // Resuming sends no prompt: the session continues from the transcript the
      // sidecar reopened, and a prompt here would be a new turn nobody asked
      // for (§5.4).
      return open(
        {
          mode: "resume",
          ref,
          launch: config.launch,
          workspacePath: config.workspacePath,
          sessionDir: options.sessionDir,
        },
        null,
      );
    },

    async fork(_ref: RuntimeSessionRef, point: TranscriptPoint) {
      throw new SessionHostForkUnavailable(
        point,
        "native branching is not wired yet (issue #82); PlotRoom seeds from its own transcript instead",
      );
    },
  };
}

class SessionHostHandle implements RuntimeSessionHandle {
  get ref(): RuntimeSessionRef {
    if (this.#ref === null) {
      throw new Error("the session host has not reported its session yet");
    }
    return this.#ref;
  }

  readonly #process: SessionHostProcess;
  readonly #now: () => EpochMillis;
  readonly #queue = new ObservationQueue();
  readonly #pending = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();

  #ref: RuntimeSessionRef | null = null;
  /**
   * How many frames arrived damaged. Counted rather than reported one by one,
   * because every observation advances the silence clock `deriveSessionHealth`
   * reads: a sidecar spraying unreadable lines would look busy and healthy for
   * as long as it kept spraying, which is the exact stall §7.2 exists to catch.
   * The first one is reported when it happens and the total when the stream
   * ends, so the count is in the record and the clock is not held open by it.
   */
  #damagedFrames = 0;
  #ready: {
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
  #readyResult: Error | "ready" | null = null;
  #commandSeq = 0;
  #fatal: string | null = null;
  #stopRequested: "user" | null = null;
  /** Set once the frame stream has ended; what a later command rejects with. */
  #ended: Error | null = null;
  /** The one in-flight `started()` wait, so a second call joins it. */
  #startedWait: Promise<void> | null = null;
  readonly #pump: Promise<void>;

  readonly #delay: Delay;

  constructor(
    process: SessionHostProcess,
    now: () => EpochMillis,
    delay: Delay,
  ) {
    this.#process = process;
    this.#now = now;
    this.#delay = delay;
    this.#pump = this.#read();
  }

  /**
   * Resolves when the sidecar has a native session, rejects if it never will —
   * including because it never said so in time (issue #108).
   *
   * The bound is here rather than at each caller because the need for it is this
   * adapter's own property: `ready` is a frame, and a sidecar that starts, stays
   * alive and never sends one looks healthy from outside, so nothing above can
   * tell the difference or escalate. The pi adapter derives its ref synchronously
   * from the transport and has nothing to wait for.
   *
   * The wait is memoized. A second call used to overwrite `#ready` and orphan the
   * first caller's resolver, which was a lost wakeup before this bound existed
   * and is worse with it: the orphan's own bound would still come due and refuse
   * a session the second caller had already been handed.
   */
  started(): Promise<void> {
    if (this.#readyResult === "ready") return Promise.resolve();
    if (this.#readyResult !== null) return Promise.reject(this.#readyResult);
    this.#startedWait ??= this.#awaitReady();
    return this.#startedWait;
  }

  async #awaitReady(): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => {
      this.#ready = { resolve, reject };
    });

    const outcome = await Promise.race([
      ready.then(() => "ready" as const),
      this.#delay(READY_TIMEOUT_MS).then(() => "timed-out" as const),
    ]);
    if (outcome === "ready") return;

    // Said before throwing, so the stream's own end reports this rather than
    // "ended before it answered" — which would describe a dead process and send
    // whoever reads it looking in the wrong place. Aborting the process is
    // `open()`'s job: it aborts on any start failure, and doing it in both places
    // would signal twice.
    this.#fatal = `the session host did not report a session within ${(READY_TIMEOUT_MS / 1000).toString()}s`;
    throw new SessionHostNotReady(READY_TIMEOUT_MS);
  }

  observations(): AsyncIterable<RuntimeObservation> {
    return this.#queue;
  }

  async prompt(text: string): Promise<void> {
    await this.#send({ type: "prompt", id: this.#nextId(), text });
  }

  /**
   * Inject between turns (§6.5). The acknowledgement is queue acceptance and
   * nothing more — consumption is a separate observed fact, which is what the
   * ledger's queued → delivered transition is made of.
   */
  async inject(input: InjectedInput): Promise<InjectionReceipt> {
    await this.#send({
      type: "inject",
      id: this.#nextId(),
      injectionId: input.id,
      text: input.text,
    });
    return { id: input.id, queuedAt: this.#now() };
  }

  /**
   * Answer a runtime-raised request (§6.4, §6.6). The settlement is observed
   * rather than assumed here: the sidecar holds the blocked call, so it is the
   * only side that knows the answer reached it, and it emits `request-settled`
   * when it does.
   */
  async respond(
    requestId: RuntimeRequestId,
    outcome: RequestOutcome,
  ): Promise<void> {
    await this.#send({
      type: "respond",
      id: this.#nextId(),
      requestId,
      outcome,
    });
  }

  async stop(mode: "graceful" | "abort"): Promise<void> {
    this.#stopRequested = "user";

    if (mode === "graceful") {
      // Sent, not awaited. The sidecar aborts the turn and disposes the session,
      // which is what flushes the runtime's own session file — so it is worth
      // asking, and `close` below then gives it a bounded window to leave.
      //
      // Awaiting the acknowledgement would undo that bound: it settles only on a
      // frame or on the stream's end, so a sidecar that is alive but silent — a
      // foreign executable named by `PLOTROOM_SESSION_HOST`, or one wedged before
      // it reads stdin — would hang this stop, and the request behind it, for
      // ever. Nothing reads the answer anyway; the end is what the stream says.
      void this.#send({ type: "stop", id: this.#nextId(), mode }).catch(
        () => undefined,
      );
    }

    await this.#process.close(mode);

    // The pump ends when the frame channel does, and the channel can outlive the
    // process: anything still holding its write end keeps it open, which a
    // foreign executable named by `PLOTROOM_SESSION_HOST` can arrange (#92). An
    // unbounded wait here hangs the stop gesture and the request behind it, so
    // the wait is bounded, escalated once, and then PlotRoom stops waiting.
    if (await this.#pumpEnded()) return;

    if (mode === "graceful") {
      // A graceful close returns as soon as the process has gone, which leaves
      // whatever else holds the channel alive. The abort signals the group, which
      // reaps the holder — so this is the escalation, not a second guess.
      await this.#process.close("abort");
      if (await this.#pumpEnded()) return;
    }

    // Nothing left to wait for that PlotRoom can influence. The stream is over
    // from here whatever the fd says, and saying so is what ends the observation
    // stream — a caller still iterating it would otherwise wait for ever for a
    // session that has already stopped (principle 11's distinction is about which
    // end state, never about whether there is one).
    //
    // Reported as an observation and **not** as `#fatal`: the operator asked for
    // this stop, and `#endReason` reads `#fatal` before `#stopRequested`, so
    // setting it would record a stop the operator chose as a *failed* run
    // (`RunService` folds `failed` straight into `runs.fail`). What failed was
    // PlotRoom's cleanup, not the session.
    this.#queue.push({
      kind: "runtime-error",
      message:
        "the session host's frame channel stayed open after the process left, so PlotRoom stopped reading it",
      fatal: false,
      at: this.#now(),
    });
    this.#settleEnded();
  }

  /** True if the frame stream ended within the bound. */
  async #pumpEnded(): Promise<boolean> {
    const outcome = await Promise.race([
      this.#pump.then(() => "ended" as const),
      this.#delay(STREAM_END_TIMEOUT_MS).then(() => "waiting" as const),
    ]);
    return outcome === "ended";
  }

  #nextId(): string {
    this.#commandSeq += 1;
    return `plotroom-${this.#commandSeq.toString()}`;
  }

  /**
   * Write a command and wait for the sidecar to take it — bounded, because this
   * is the same shape as the `ready` wait (issue #108) and the same threat model:
   * an acknowledgement settles only on a frame or on the stream ending, so a
   * sidecar that is alive and silent — a foreign executable named by
   * `PLOTROOM_SESSION_HOST`, or one wedged before it reads stdin — would hang
   * whoever is awaiting this for ever. `open()` awaits one on the start path, so
   * unbounded here means `POST /api/runs` never answers even with `ready` in hand.
   *
   * The command is rejected rather than the process killed: an injection nobody
   * acknowledged is a refused injection, which the ledger has a state for (§6.5),
   * and killing a working session because one command went unanswered would be a
   * worse answer than reporting it. The start path aborts, because a session that
   * never received its instruction is not a session — that decision is `open()`'s.
   */
  async #send(command: SessionHostCommand): Promise<void> {
    // A command written after the frame stream ended can never be answered: the
    // drain below has already run, so nothing would ever settle this promise —
    // and `stop("graceful")` awaits one, which would hang the request behind it
    // for ever. The window is real: a stop gesture can land between the sidecar
    // dying and the driver detaching its handle.
    if (this.#ended !== null) return Promise.reject(this.#ended);

    const settled = new Promise<void>((resolve, reject) => {
      this.#pending.set(command.id, { resolve, reject });
    });
    this.#process.write(encodeSessionHostCommand(command));

    const outcome = await Promise.race([
      settled.then(() => "acknowledged" as const),
      this.#delay(ACK_TIMEOUT_MS).then(() => "timed-out" as const),
    ]);
    if (outcome === "acknowledged") return;

    // Dropped from `#pending` so a late acknowledgement settles nothing twice,
    // and so the stream's end does not reject a promise nobody holds.
    this.#pending.delete(command.id);
    throw new SessionHostSilent(command.type, ACK_TIMEOUT_MS);
  }

  async #read(): Promise<void> {
    let buffer = "";
    try {
      for await (const chunk of this.#process.frameChunks()) {
        buffer += chunk;
        const { lines, rest } = splitJsonLines(buffer);
        buffer = rest;

        for (const line of lines) this.#consume(line);
      }
    } catch (error) {
      // A crashed adapter never crashes the host: transport failure is an
      // observation, not an exception thrown at whoever is iterating.
      this.#fatal = error instanceof Error ? error.message : String(error);
      this.#queue.push({
        kind: "runtime-error",
        message: this.#fatal,
        fatal: true,
        at: this.#now(),
      });
    }

    this.#settleEnded();
  }

  /**
   * Everything that has to be true once PlotRoom is no longer reading frames:
   * waiters settled, the end recorded, the observation stream closed.
   *
   * Idempotent, because it has two callers — the pump finishing, and `stop`
   * deciding not to wait for it any longer (issue #108) — and either can be
   * second. The queue already ignores a push after `end()`, so the guard is
   * about not settling `#ready` or the pending commands twice with a different
   * reason than the first one won with.
   */
  #settleEnded(): void {
    if (this.#ended !== null) return;

    const ended = new Error(
      this.#fatal ?? "the session host ended before it answered",
    );
    this.#ended = ended;
    this.#settleReady(ended);
    for (const waiting of this.#pending.values()) waiting.reject(ended);
    this.#pending.clear();

    // The total, once, where it cannot hold the silence clock open: the first
    // damaged frame was reported as it happened, and this says how many followed
    // it, so the record states the size of the loss rather than only its start.
    if (this.#damagedFrames > 1) {
      this.#queue.push({
        kind: "runtime-error",
        message: `${this.#damagedFrames.toString()} session-host frames were unreadable, so that many observations were lost`,
        fatal: false,
        at: this.#now(),
      });
    }

    this.#queue.push({
      kind: "session-ended",
      reason: this.#endReason(),
      at: this.#now(),
    });
    this.#queue.end();
  }

  #consume(line: string): void {
    const event = parseSessionHostEvent(line);
    const at = this.#now();

    switch (event.type) {
      case "ready":
        this.#ref = event.ref;
        this.#settleReady("ready");
        return;

      case "observation":
        this.#queue.push(event.observation);
        return;

      case "ack": {
        this.#pending.get(event.id)?.resolve();
        this.#pending.delete(event.id);
        return;
      }

      case "nack": {
        this.#pending.get(event.id)?.reject(new Error(event.error));
        this.#pending.delete(event.id);
        return;
      }

      case "fatal":
        // Before `ready` there is no session for this to have happened to, so
        // it is the reason `start()` refuses. After it, the session existed and
        // ended badly, which is a record (§3.6) — and the stream is about to
        // end, so `#endReason` reports it as a failure.
        this.#fatal = event.message;
        this.#queue.push({
          kind: "runtime-error",
          message: event.message,
          fatal: true,
          at,
        });
        return;

      case "unknown":
        // Nothing but PlotRoom writes this channel (issue #109), so an
        // unreadable line is not the vendor logging where it should have framed —
        // it is a frame that arrived damaged, and an observation is gone. Still
        // not thrown, because the session is alive and the rest of the stream is
        // worth having; recorded rather than dropped, because the log **is** the
        // record and a loss nobody wrote down is the quiet degradation principle
        // 12 forbids. Non-fatal, for the same reason: the session did not end.
        this.#damagedFrames += 1;
        // Only the first, here. The total arrives when the stream ends, so a
        // sidecar spraying garbage cannot hold the silence clock open (§7.2) or
        // write a row per line into the observation log.
        if (this.#damagedFrames > 1) return;

        // The damaged bytes go in bounded, and the message states the full
        // length beside the prefix — an unbounded one could be a whole
        // interleaved output delta, and a bare prefix would hide how much.
        this.#queue.push({
          kind: "runtime-error",
          message: `unreadable session-host frame (${line.length.toString()} chars), so one observation was lost: ${line.slice(0, UNREADABLE_FRAME_PREVIEW)}`,
          fatal: false,
          at,
        });
        return;
    }
  }

  #settleReady(outcome: Error | "ready"): void {
    if (this.#readyResult !== null) return;
    this.#readyResult = outcome;
    const waiting = this.#ready;
    this.#ready = null;
    if (!waiting) return;
    if (outcome === "ready") waiting.resolve();
    else waiting.reject(outcome);
  }

  /**
   * The sidecar's stream ends when its process does. What that means is
   * PlotRoom's call: a stop it asked for is a stop; a stream that ends on its
   * own with nothing asked is an interruption — not a failure, and not
   * something anybody chose (§3.6, principle 11). Out-of-budget is never
   * decided here: PlotRoom initiates budget stops and records them itself.
   */
  #endReason(): SessionEndReason {
    if (this.#fatal !== null) {
      return { kind: "failed", message: this.#fatal };
    }
    if (this.#stopRequested) {
      return { kind: "stopped", by: this.#stopRequested };
    }
    return {
      kind: "interrupted",
      message: "the session host ended without a stop",
    };
  }
}
