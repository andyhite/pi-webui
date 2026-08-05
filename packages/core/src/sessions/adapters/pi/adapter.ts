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
  SessionLaunchChoices,
  SessionRuntimeAdapter,
  TranscriptPoint,
} from "../../runtime.js";
import { NativeForkUnavailable } from "../../runtime.js";
import { ObservationQueue } from "../observation-queue.js";
import { composeSeededPrompt } from "../seeded-prompt.js";
import { createPiObservationMapper } from "./observations.js";
import { encodeRequestOutcome } from "./permission-gate.js";
import {
  encodeCommand,
  parsePiEvent,
  splitJsonLines,
  type PiCommand,
} from "./protocol.js";

/**
 * Adapter v1: the pi coding agent (decision 0001, operator amendment at
 * Sync 1).
 *
 * The adapter owns exactly one thing — translating pi's RPC surface into
 * observations and a small command set. Phases, the injection ledger,
 * accounting, budgets, and the session record are on PlotRoom's side of the
 * seam and are not visible from here.
 *
 * The process itself is injected. `@plotroom/core` has no knowledge of
 * transport (spawning pi is the server's job), and injecting it is also what
 * makes the adapter testable against a replayed event stream instead of a live
 * model.
 */
export const PI_ADAPTER_ID = "pi-coding-agent";

export const PI_CAPABILITIES: RuntimeCapabilities = {
  // pi forks from a previous user message, which is where PlotRoom's turns
  // start. An arbitrary mid-turn point still goes through `planFork`.
  fork: "turn-boundary",
  // Steering messages are consumed between turns — the §6.5 shape natively.
  injection: "between-turns",
  // pi reports per-turn cost from its multi-provider pricing tables.
  reportsCost: true,
  // Occupancy is available from `get_session_stats`, not from the event
  // stream, so the meter is estimated until that is wired.
  reportsContextWindow: false,
  // Verified against pi 0.83.0: a `tool_call` handler blocks the call, and the
  // decision is PlotRoom's, per call (see permission-gate.ts).
  enforcesPermissions: true,
};

export type PiLaunchMode = "start" | "resume" | "fork";

export interface PiLaunchOptions {
  readonly mode: PiLaunchMode;
  /** The native session to resume or fork from. */
  readonly ref?: RuntimeSessionRef;
  readonly launch: SessionLaunchChoices;
  readonly workspacePath: string;
  /** Extension files pi must load — the permission gate, at minimum. */
  readonly extensionPaths: readonly string[];
}

/** One live pi process, as the adapter needs it. */
export interface PiRpcTransport {
  /** pi's own session identity, so resume and fork survive a restart. */
  readonly ref: RuntimeSessionRef;
  write(line: string): void;
  /** Raw stdout chunks; framing is this module's job, not the caller's. */
  chunks(): AsyncIterable<string>;
  close(mode: "graceful" | "abort"): Promise<void>;
}

export type PiConnect = (options: PiLaunchOptions) => Promise<PiRpcTransport>;

export interface PiAdapterOptions {
  readonly connect: PiConnect;
  /** Injected clock in milliseconds; observations are stamped at read time. */
  readonly now: () => EpochMillis;
  readonly extensionPaths?: readonly string[];
}

/**
 * The pi argv PlotRoom launches, as a pure function so the mapping from
 * per-session choices (§3.6) to flags is testable without a process.
 */
export function buildPiArgs(options: PiLaunchOptions): readonly string[] {
  const args = ["--mode", "rpc", "--model", options.launch.model];

  args.push("--thinking", options.launch.effort);

  const allowed = options.launch.toolPermissions.allowedTools;
  if (allowed !== null) {
    // A session is launched narrower than the app, never wider (§3.6).
    args.push("--tools", allowed.join(","));
  }

  if (options.mode === "resume" && options.ref) {
    args.push("--session", options.ref);
  }
  if (options.mode === "fork" && options.ref) {
    args.push("--fork", options.ref);
  }

  for (const path of options.extensionPaths) args.push("-e", path);

  return args;
}

/** Seeding a fork is not pi-specific; the composer is shared (§6.3). */
export { composeSeededPrompt };

export function createPiAdapter(
  options: PiAdapterOptions,
): SessionRuntimeAdapter {
  const extensionPaths = options.extensionPaths ?? [];

  async function open(
    launchOptions: PiLaunchOptions,
    prompt: string | null,
  ): Promise<PiSessionHandle> {
    const transport = await options.connect(launchOptions);
    const handle = new PiSessionHandle(transport, options.now);
    if (prompt !== null) await handle.prompt(prompt);
    return handle;
  }

  return {
    id: PI_ADAPTER_ID,
    capabilities: PI_CAPABILITIES,

    async start(config) {
      return open(
        {
          mode: "start",
          launch: config.launch,
          workspacePath: config.workspacePath,
          extensionPaths,
        },
        composeSeededPrompt(config),
      );
    },

    async resume(ref, config: RuntimeResumeConfig) {
      return open(
        {
          mode: "resume",
          ref,
          launch: config.launch,
          workspacePath: config.workspacePath,
          extensionPaths,
        },
        null,
      );
    },

    /**
     * Fork natively, or refuse — never quietly do something else (§6.3, decision
     * 0001).
     *
     * `pi --fork <ref>` produces a new native session holding the source's
     * conversation; `forkAt` then rewinds it to the requested point.
     *
     * This used to fall back to a seeded session when pi could not reach the
     * point, which sounds generous and is not: the caller decided `native` from
     * `planFork` and records `runtime.mode` from that decision, so an adapter that
     * seeded instead handed back a session whose stored mode was false — and a
     * seeded fork is not bit-identical to a native one, which is the whole reason
     * the two are distinguished. Reporting the substitution would have been a
     * second-best fix; not making it is better, because a false mode stops being
     * *representable* rather than being something a caller must remember to read.
     *
     * So the only outcomes here are the fork the caller asked for, or
     * `PiForkUnavailable`. Seeding is the caller's own branch — `start()` with
     * `seedTranscript`, which it already calls for `planFork`'s `seeded` verdict —
     * so whichever route it took is the mode it records. The half-forked native
     * session is aborted on the way out: leaving it running would leave a pi
     * process nothing is driving.
     */
    async fork(ref, point: TranscriptPoint, config: RuntimeStartConfig) {
      const handle = await open(
        {
          mode: "fork",
          ref,
          launch: config.launch,
          workspacePath: config.workspacePath,
          extensionPaths,
        },
        null,
      );

      try {
        await handle.forkAt(point);
      } catch (error) {
        await handle.stop("abort");
        throw error;
      }

      await handle.prompt(composeSeededPrompt(config));
      return handle;
    },
  };
}

interface PiResponse {
  readonly success: boolean;
  readonly error?: string;
  readonly data?: unknown;
}

interface ForkMessage {
  readonly entryId: string;
  readonly text: string;
}

/**
 * How pi reached a fork point. `"inherited"` means the launch already did it:
 * `pi --fork <ref>` copies the whole source session into a new one, which *is* a
 * fork from the tip. `"rewound"` means a `fork` command moved the new session's
 * branch back to an earlier point.
 */
export type PiForkMode = "inherited" | "rewound";

export type PiForkTarget =
  | { readonly kind: "rewound"; readonly entryId: string }
  | { readonly kind: "inherited" }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Map a PlotRoom transcript point onto pi's fork surface (§6.3).
 *
 * Two facts have to meet here, and getting the arithmetic wrong silently loses a
 * turn of inherited context:
 *
 * - **PlotRoom** forks *inclusively*: "a fork from any point inherits the
 *   conversation up to that point" (§6.3), so a fork at turn `n` keeps turns
 *   1..n — `transcriptPrefix` in `fork.ts` is the same rule.
 * - **pi** forks *from* a user message: the new branch begins at that message,
 *   so forking from the message that opened turn `n` would drop turn `n` itself.
 *
 * So the entry to fork from is the one that opens turn `n + 1`, and when `n` is
 * the last turn there is no such message — nothing needs sending at all, because
 * `pi --fork <ref>` has already produced a new session holding the whole
 * conversation. That is why the tip case is `inherited` rather than a command.
 *
 * The assumption this rests on, stated because it is an assumption: pi's k-th
 * forkable user message opens PlotRoom's k-th turn. That holds while every turn
 * begins with one user message, which is how PlotRoom drives pi (one prompt per
 * turn, injections included — each delivered injection is a user message that
 * starts a turn). A point past the end of that list is `unavailable` rather than
 * clamped, because a fork that silently inherits a different prefix than the one
 * the operator picked is worse than a seeded fallback (principle 7).
 */
export function resolvePiForkTarget(
  messages: readonly ForkMessage[],
  point: TranscriptPoint,
): PiForkTarget {
  if (point.turn < 1) {
    return {
      kind: "unavailable",
      reason: `turn ${point.turn} is not a turn`,
    };
  }
  if (point.turn > messages.length) {
    return {
      kind: "unavailable",
      reason: `pi lists ${messages.length} forkable message${
        messages.length === 1 ? "" : "s"
      }, so it cannot fork at turn ${point.turn}`,
    };
  }
  if (point.turn === messages.length) return { kind: "inherited" };

  const next = messages[point.turn] as ForkMessage;
  return { kind: "rewound", entryId: next.entryId };
}

/**
 * A native fork pi could not perform — the pi-specific instance of
 * `NativeForkUnavailable` (§6.3, principle 7).
 *
 * Thrown rather than papered over, and specifically **not** substituted for: the
 * caller seeds a fresh session from PlotRoom's own transcript instead
 * (`start({ seedTranscript })`, the emulation decision 0001 describes) and records
 * `seeded`, because it is the caller that holds the plan and writes the record.
 * The adapter doing that silently is what would let `runtime.mode` say `native`
 * about a session that was seeded.
 */
export class PiForkUnavailable extends NativeForkUnavailable {
  constructor(point: TranscriptPoint, reason: string) {
    super(PI_ADAPTER_ID, point, reason);
    this.name = "PiForkUnavailable";
  }
}

/** pi reports an extension-cancelled fork as `success: true, data.cancelled`. */
function wasCancelled(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  return (data as { cancelled?: unknown }).cancelled === true;
}

class PiSessionHandle implements RuntimeSessionHandle {
  readonly ref: RuntimeSessionRef;

  readonly #transport: PiRpcTransport;
  readonly #now: () => EpochMillis;
  readonly #mapper = createPiObservationMapper();
  readonly #queue = new ObservationQueue();
  readonly #pending = new Map<
    string,
    {
      resolve: (response: PiResponse) => void;
      reject: (error: Error) => void;
    }
  >();

  #commandSeq = 0;
  #fatal: string | null = null;
  #stopRequested: "user" | null = null;
  /**
   * Set once the stream has ended. Without this, `#send` after the stream
   * ended registers a pending entry that nothing will ever settle — `#read`'s
   * rejection loop below runs once, at the tail, and a command sent after that
   * point misses it entirely. `stop("graceful")` awaits one such send, so the
   * gap hung a graceful stop, and the request behind it, forever (issue #110).
   */
  #ended: Error | null = null;
  #pump: Promise<void>;

  constructor(transport: PiRpcTransport, now: () => EpochMillis) {
    this.#transport = transport;
    this.#now = now;
    this.ref = transport.ref;
    this.#pump = this.#read();
  }

  observations(): AsyncIterable<RuntimeObservation> {
    return this.#queue;
  }

  async prompt(message: string): Promise<void> {
    const response = await this.#send({
      type: "prompt",
      id: this.#nextId(),
      message,
    });
    if (!response.success) {
      throw new Error(response.error ?? "pi refused the prompt");
    }
  }

  /**
   * Inject between turns (§6.5) — which, for pi, is one command and not two.
   *
   * pi offers three ways to hand a live session input, and exactly one of them
   * arrives in both states the session can be in:
   *
   * - a bare `prompt` **fails** while pi is streaming ("Agent is already
   *   processing. Specify streamingBehavior...");
   * - the standalone `steer` command queues the message and triggers nothing, so
   *   an injection into a live-but-idle session sits in the queue indefinitely —
   *   "queued" forever, which is the exact failure §6.5 exists to prevent;
   * - `prompt` carrying `streamingBehavior: "steer"` queues mid-turn and prompts
   *   when idle (pi 0.83.0 consults the field only while streaming).
   *
   * So PlotRoom always sends the third. Resolving still means queue acceptance
   * and nothing more: consumption arrives later as an observation, and which of
   * the two paths it took is visible there — a queued injection is seen in pi's
   * steering queue first, an immediate one is delivered at the turn it became.
   */
  async inject(input: InjectedInput): Promise<InjectionReceipt> {
    const response = await this.#send({
      type: "prompt",
      id: this.#nextId(),
      message: input.text,
      streamingBehavior: "steer",
    });
    if (!response.success) {
      throw new Error(response.error ?? "pi refused the injection");
    }

    this.#mapper.trackInjection({ id: input.id, text: input.text });
    return { id: input.id, queuedAt: this.#now() };
  }

  async respond(
    requestId: RuntimeRequestId,
    outcome: RequestOutcome,
  ): Promise<void> {
    this.#transport.write(
      encodeCommand(encodeRequestOutcome(requestId, outcome)),
    );
    // pi's UI sub-protocol has no acknowledgement, so PlotRoom records the
    // settlement itself — the request is answered whether or not the tool then
    // runs.
    this.#queue.push({
      kind: "request-settled",
      requestId,
      outcome,
      at: this.#now(),
    });
  }

  async stop(mode: "graceful" | "abort"): Promise<void> {
    this.#stopRequested = "user";
    if (mode === "graceful") {
      await this.#send({ type: "abort", id: this.#nextId() }).catch(() => ({
        success: false,
      }));
    }
    await this.#transport.close(mode);
    await this.#pump;
  }

  /** Move pi's active branch to the fork point before continuing (§6.3). */
  async forkAt(point: TranscriptPoint): Promise<PiForkMode> {
    const listed = await this.#send({
      type: "get_fork_messages",
      id: this.#nextId(),
    });
    const target = resolvePiForkTarget(readForkMessages(listed.data), point);

    if (target.kind === "unavailable") {
      throw new PiForkUnavailable(point, target.reason);
    }
    // The launch already inherited everything; sending a command here would fork
    // a fork.
    if (target.kind === "inherited") return "inherited";

    const response = await this.#send({
      type: "fork",
      id: this.#nextId(),
      entryId: target.entryId,
    });

    if (!response.success) {
      throw new PiForkUnavailable(
        point,
        response.error ?? "pi refused the fork",
      );
    }
    // pi answers `success: true` for a fork an extension cancelled, saying so
    // only in `data.cancelled`. Reading `success` alone would produce a session
    // that inherited nothing while reporting a native fork — the one failure a
    // seeded fallback exists to avoid (principle 7).
    if (wasCancelled(response.data)) {
      throw new PiForkUnavailable(point, "a pi extension cancelled the fork");
    }

    return "rewound";
  }

  #nextId(): string {
    this.#commandSeq += 1;
    return `plotroom-${this.#commandSeq}`;
  }

  async #send(command: PiCommand): Promise<PiResponse> {
    // A command sent after the stream ended can never be answered — see the
    // field comment on `#ended` (issue #110).
    if (this.#ended !== null) return Promise.reject(this.#ended);

    const id = "id" in command ? command.id : this.#nextId();
    const response = new Promise<PiResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#transport.write(encodeCommand(command));
    return response;
  }

  async #read(): Promise<void> {
    let buffer = "";
    try {
      for await (const chunk of this.#transport.chunks()) {
        buffer += chunk;
        const { lines, rest } = splitJsonLines(buffer);
        buffer = rest;

        for (const line of lines) {
          const event = parsePiEvent(line);
          const at = this.#now();

          if (event.type === "response") {
            const waiting = event.id ? this.#pending.get(event.id) : undefined;
            if (waiting && event.id) {
              this.#pending.delete(event.id);
              waiting.resolve({
                success: event.success,
                ...(event.error === undefined ? {} : { error: event.error }),
                ...(event.data === undefined ? {} : { data: event.data }),
              });
            }
            continue;
          }

          for (const observation of this.#mapper.map(event, at)) {
            this.#queue.push(observation);
          }
        }
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

    const ended = new Error("the pi session ended before it answered");
    this.#ended = ended;
    for (const waiting of this.#pending.values()) {
      waiting.reject(ended);
    }
    this.#pending.clear();

    this.#queue.push({
      kind: "session-ended",
      reason: this.#endReason(),
      at: this.#now(),
    });
    this.#queue.end();
  }

  /**
   * pi's stream ends when its process does. What that means is PlotRoom's call:
   * a stop it asked for is a stop; a stream that ends on its own with nothing
   * asked is an interruption — not a failure, and not something anybody chose
   * (§3.6, principle 11). Out-of-budget is never decided here: PlotRoom
   * initiates budget stops and records them itself.
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
      message: "the pi session ended without a stop",
    };
  }
}

function readForkMessages(data: unknown): readonly ForkMessage[] {
  if (typeof data !== "object" || data === null) return [];
  const messages = (data as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    (message): message is ForkMessage =>
      typeof message === "object" &&
      message !== null &&
      typeof (message as ForkMessage).entryId === "string",
  );
}
