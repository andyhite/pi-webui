import type {
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

export const OMP_CAPABILITIES: RuntimeCapabilities = {
  // Native branching exists (`session.branch(entryId)`) but its arithmetic is
  // exclusive of the branched entry, which is not what `TranscriptPoint` means.
  // Until that is re-derived (issue #82) PlotRoom seeds from its own transcript,
  // which `planFork` already does for every runtime that cannot fork natively —
  // so a fork works, and its `runtime_mode` says truthfully that it was seeded.
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
  /** Raw stdout chunks; framing is this module's job, not the caller's. */
  chunks(): AsyncIterable<string>;
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
    const handle = new SessionHostHandle(process, options.now);
    // A handle is only returned once the sidecar has reported the native ref:
    // it is what resume is addressed by, and a session recorded without it is
    // one PlotRoom could never pick up again (§3.6).
    await handle.started();
    if (prompt !== null) await handle.prompt(prompt);
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
  #ready: {
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
  #readyResult: Error | "ready" | null = null;
  #commandSeq = 0;
  #fatal: string | null = null;
  #stopRequested: "user" | null = null;
  readonly #pump: Promise<void>;

  constructor(process: SessionHostProcess, now: () => EpochMillis) {
    this.#process = process;
    this.#now = now;
    this.#pump = this.#read();
  }

  /** Resolves when the sidecar has a native session, rejects if it never will. */
  started(): Promise<void> {
    if (this.#readyResult === "ready") return Promise.resolve();
    if (this.#readyResult !== null) return Promise.reject(this.#readyResult);
    return new Promise<void>((resolve, reject) => {
      this.#ready = { resolve, reject };
    });
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
      // The sidecar aborts the turn and disposes the session, which is what
      // flushes the SDK's own session file. A refused or unanswered stop is not
      // an error worth surfacing — the close below is what guarantees the end.
      await this.#send({ type: "stop", id: this.#nextId(), mode }).catch(
        () => undefined,
      );
    }

    await this.#process.close(mode);
    await this.#pump;
  }

  #nextId(): string {
    this.#commandSeq += 1;
    return `plotroom-${this.#commandSeq.toString()}`;
  }

  async #send(command: SessionHostCommand): Promise<void> {
    const settled = new Promise<void>((resolve, reject) => {
      this.#pending.set(command.id, { resolve, reject });
    });
    this.#process.write(encodeSessionHostCommand(command));
    return settled;
  }

  async #read(): Promise<void> {
    let buffer = "";
    try {
      for await (const chunk of this.#process.chunks()) {
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

    const ended = new Error(
      this.#fatal ?? "the session host ended before it answered",
    );
    this.#settleReady(ended);
    for (const waiting of this.#pending.values()) waiting.reject(ended);
    this.#pending.clear();

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
        // A line PlotRoom cannot read is dropped, never thrown: the sidecar's
        // stdout is a stream we share with whatever the SDK decides to print.
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
