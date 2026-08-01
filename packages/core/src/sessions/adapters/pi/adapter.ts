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

/**
 * A fork seeded from PlotRoom's own transcript (§6.3). The inheritance is
 * labelled: a seeded fork is not a native one, and pretending otherwise is the
 * fidelity risk decision 0001 names.
 */
export function composeSeededPrompt(config: RuntimeStartConfig): string {
  if (!config.seedTranscript) return config.prompt;
  return [
    "# Inherited transcript",
    "",
    "This session was forked from an earlier one. What follows is the",
    "conversation up to the fork point, as PlotRoom recorded it.",
    "",
    config.seedTranscript,
    "",
    "# Continue from here",
    "",
    config.prompt,
  ].join("\n");
}

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

      await handle.forkAt(point);
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

  async inject(input: InjectedInput): Promise<InjectionReceipt> {
    // Resolves on queue acceptance, not on consumption: pi answers `steer`
    // once the message is in its queue, and delivery arrives later as an
    // observation (§6.5).
    const response = await this.#send({
      type: "steer",
      id: this.#nextId(),
      message: input.text,
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
  async forkAt(point: TranscriptPoint): Promise<void> {
    const listed = await this.#send({
      type: "get_fork_messages",
      id: this.#nextId(),
    });
    const messages = readForkMessages(listed.data);
    // pi forks from a user message, which is where a PlotRoom turn begins.
    const entry = messages[point.turn - 1];
    if (!entry) {
      throw new Error(
        `pi cannot fork at turn ${point.turn}; seed a new session from the transcript instead`,
      );
    }

    const forked = await this.#send({
      type: "fork",
      id: this.#nextId(),
      entryId: entry.entryId,
    });
    if (!forked.success) {
      throw new Error(forked.error ?? "pi refused the fork");
    }
  }

  #nextId(): string {
    this.#commandSeq += 1;
    return `plotroom-${this.#commandSeq}`;
  }

  async #send(command: PiCommand): Promise<PiResponse> {
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

    for (const waiting of this.#pending.values()) {
      waiting.reject(new Error("the pi session ended before it answered"));
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

/** A minimal push queue, so observations stream without a dependency. */
class ObservationQueue implements AsyncIterable<RuntimeObservation> {
  #buffer: RuntimeObservation[] = [];
  #waiting: ((value: IteratorResult<RuntimeObservation>) => void) | null = null;
  #done = false;

  push(observation: RuntimeObservation): void {
    if (this.#done) return;
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = null;
      waiting({ value: observation, done: false });
      return;
    }
    this.#buffer.push(observation);
  }

  end(): void {
    this.#done = true;
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = null;
      waiting({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeObservation> {
    return {
      next: (): Promise<IteratorResult<RuntimeObservation>> => {
        const next = this.#buffer.shift();
        if (next) return Promise.resolve({ value: next, done: false });
        if (this.#done) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
    };
  }
}
