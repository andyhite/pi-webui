import { describe, expect, it } from "vitest";

import {
  deriveSessionPhase,
  initialObservationState,
  reduceObservation,
  type SessionObservationState,
} from "../../phases.js";
import type {
  RuntimeObservation,
  RuntimeSessionHandle,
  SessionRuntimeAdapter,
  RuntimeStartConfig,
} from "../../runtime.js";
import { makeLaunchChoices } from "../../testing.js";
import {
  createOmpAdapter,
  SessionHostForkUnavailable,
  type SessionHostProcess,
} from "./adapter.js";
import {
  buildSessionHostArgs,
  parseSessionHostCommand,
  parseSessionHostEvent,
  type SessionHostCommand,
  type SessionHostEvent,
} from "./protocol.js";

const START: RuntimeStartConfig = {
  prompt: "do the thing",
  launch: makeLaunchChoices({
    model: "anthropic/claude-haiku-4-5",
    effort: "off",
    toolPermissions: { allowedTools: null },
  }),
  workspacePath: "/workspaces/one",
};

/**
 * One session-host process, replayed. The adapter takes the process as a
 * dependency precisely so its lifecycle is testable without a model, a provider
 * or a native addon.
 */
class FakeSessionHost implements SessionHostProcess {
  readonly commands: SessionHostCommand[] = [];
  readonly closed: ("graceful" | "abort")[] = [];
  autoAck = true;

  #chunks: string[] = [];
  #waiting: {
    resolve: (result: IteratorResult<string>) => void;
    reject: (error: Error) => void;
  } | null = null;
  #done = false;
  #failure: Error | null = null;

  emit(frame: SessionHostEvent): void {
    this.#push(`${JSON.stringify(frame)}\n`);
  }

  raw(line: string): void {
    this.#push(`${line}\n`);
  }

  end(): void {
    this.#done = true;
    this.#wake();
  }

  fail(failure: Error): void {
    this.#failure = failure;
    this.#wake();
  }

  write(line: string): void {
    const command = parseSessionHostCommand(line.trim());
    if (command === null) throw new Error(`unreadable command: ${line}`);
    this.commands.push(command);
    if (this.autoAck) this.emit({ type: "ack", id: command.id });
  }

  chunks(): AsyncIterable<string> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<string>> => {
          if (this.#failure !== null) return Promise.reject(this.#failure);
          const next = this.#chunks.shift();
          if (next !== undefined) {
            return Promise.resolve({ value: next, done: false });
          }
          if (this.#done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve, reject) => {
            this.#waiting = { resolve, reject };
          });
        },
      }),
    };
  }

  async close(mode: "graceful" | "abort"): Promise<void> {
    this.closed.push(mode);
    this.end();
  }

  #push(chunk: string): void {
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = null;
      waiting.resolve({ value: chunk, done: false });
      return;
    }
    this.#chunks.push(chunk);
  }

  #wake(): void {
    const waiting = this.#waiting;
    if (!waiting) return;
    this.#waiting = null;
    if (this.#failure !== null) waiting.reject(this.#failure);
    else waiting.resolve({ value: undefined, done: true });
  }
}

function adapterOver(
  host: FakeSessionHost,
  now: () => number = () => 1_000,
): SessionRuntimeAdapter {
  return createOmpAdapter({
    connect: () => Promise.resolve(host),
    now,
    sessionDir: "/state/runtime/session-host",
  });
}

async function started(
  host: FakeSessionHost,
  ref = "/state/runtime/session-host/a.jsonl",
): Promise<RuntimeSessionHandle> {
  const pending = adapterOver(host).start(START);
  host.emit({ type: "ready", ref });
  return pending;
}

async function collect(
  handle: RuntimeSessionHandle,
): Promise<readonly RuntimeObservation[]> {
  const observed: RuntimeObservation[] = [];
  for await (const observation of handle.observations()) {
    observed.push(observation);
  }
  return observed;
}

describe("buildSessionHostArgs", () => {
  it("carries the launch choices and never the prompt", () => {
    const args = buildSessionHostArgs({
      mode: "start",
      launch: START.launch,
      workspacePath: "/workspaces/one",
      sessionDir: "/state/runtime/session-host",
    });

    expect(args).toEqual([
      "--cwd",
      "/workspaces/one",
      "--session-dir",
      "/state/runtime/session-host",
      "--model",
      "anthropic/claude-haiku-4-5",
      "--effort",
      "off",
    ]);
    expect(args).not.toContain(START.prompt);
  });

  it("narrows the tool set only when the launch narrowed it", () => {
    const narrowed = buildSessionHostArgs({
      mode: "start",
      launch: makeLaunchChoices({
        toolPermissions: { allowedTools: ["read", "grep"] },
      }),
      workspacePath: "/w",
      sessionDir: "/s",
    });

    expect(narrowed).toContain("--tools");
    expect(narrowed).toContain("read,grep");
  });

  it("addresses a resume by the native ref", () => {
    const args = buildSessionHostArgs({
      mode: "resume",
      ref: "/state/runtime/session-host/a.jsonl",
      launch: START.launch,
      workspacePath: "/w",
      sessionDir: "/s",
    });

    expect(args.slice(-2)).toEqual([
      "--resume",
      "/state/runtime/session-host/a.jsonl",
    ]);
  });
});

describe("frame parsing", () => {
  it("reads a framed observation", () => {
    const event = parseSessionHostEvent(
      JSON.stringify({
        type: "observation",
        observation: { kind: "turn-started", turn: 1, at: 5 },
      }),
    );

    expect(event.type).toBe("observation");
  });

  it("refuses a truncated observation rather than passing it on", () => {
    // A `kind`-less observation reaching the reducer would be an event about
    // nothing; a line PlotRoom cannot read is dropped instead.
    expect(
      parseSessionHostEvent(
        JSON.stringify({ type: "observation", observation: { at: 5 } }),
      ).type,
    ).toBe("unknown");
    expect(parseSessionHostEvent("not json at all").type).toBe("unknown");
    expect(parseSessionHostEvent(JSON.stringify({ type: "hello" })).type).toBe(
      "unknown",
    );
  });

  it("requires a command to be addressable", () => {
    expect(parseSessionHostCommand(JSON.stringify({ type: "prompt" }))).toBe(
      null,
    );
    expect(
      parseSessionHostCommand(
        JSON.stringify({ type: "prompt", id: "c1", text: "hi" }),
      ),
    ).toEqual({ type: "prompt", id: "c1", text: "hi" });
  });
});

describe("the session-host adapter", () => {
  it("returns a handle only once the sidecar reported its native ref", async () => {
    const host = new FakeSessionHost();
    const handle = await started(host, "/sessions/native.jsonl");

    expect(handle.ref).toBe("/sessions/native.jsonl");
    // The assembled content is a command, not an argv: it goes down the pipe
    // once the process exists.
    expect(host.commands).toEqual([
      { type: "prompt", id: "plotroom-1", text: START.prompt },
    ]);
  });

  it("seeds a fork from PlotRoom's own transcript", async () => {
    const host = new FakeSessionHost();
    const pending = adapterOver(host).start({
      ...START,
      seedTranscript: "turn 1: hello",
    });
    host.emit({ type: "ready", ref: "/sessions/seeded.jsonl" });
    await pending;

    const [command] = host.commands;
    expect(command?.type).toBe("prompt");
    expect(command?.type === "prompt" && command.text).toContain(
      "# Inherited transcript",
    );
    expect(command?.type === "prompt" && command.text).toContain(
      "turn 1: hello",
    );
  });

  it("refuses to start when the sidecar reports it cannot run", async () => {
    const host = new FakeSessionHost();
    const pending = adapterOver(host).start(START);
    host.emit({
      type: "fatal",
      message:
        'no authenticated model available for "anthropic/claude-haiku-4-5"',
    });
    host.end();

    await expect(pending).rejects.toThrow("no authenticated model available");
  });

  it("refuses a native fork rather than quietly seeding one", async () => {
    const host = new FakeSessionHost();
    await expect(
      adapterOver(host).fork("/sessions/a.jsonl", { turn: 2 }, START),
    ).rejects.toThrow(SessionHostForkUnavailable);
  });

  it("reports a nacked command to the caller", async () => {
    const host = new FakeSessionHost();
    const handle = await started(host);
    host.autoAck = false;

    const pending = handle.respond("req-1", { kind: "allow" });
    host.emit({
      type: "nack",
      id: "plotroom-2",
      error: "no request req-1 is pending in this session",
    });

    await expect(pending).rejects.toThrow("no request req-1 is pending");
  });

  it("refuses a command after the stream ended rather than waiting for ever", async () => {
    const host = new FakeSessionHost();
    const handle = await started(host);
    const drained = collect(handle);
    host.end();
    await drained;

    // The sidecar is gone. Nothing will ack anything, so a command that waited
    // for one would hang the request behind it — a stop gesture can land in
    // exactly this window, between the process dying and the driver detaching.
    await expect(
      handle.inject({ id: "inj-1", text: "too late" }),
    ).rejects.toThrow("the session host ended before it answered");

    // And a graceful stop still finishes, because that is the one a request waits on.
    await expect(handle.stop("graceful")).resolves.toBeUndefined();
  });

  it("receipts an injection on queue acceptance, not on delivery", async () => {
    const host = new FakeSessionHost();
    let clock = 1_000;
    const pending = adapterOver(host, () => clock).start(START);
    host.emit({ type: "ready", ref: "/sessions/a.jsonl" });
    const handle = await pending;

    clock = 2_500;
    const receipt = await handle.inject({ id: "inj-1", text: "also this" });

    expect(receipt).toEqual({ id: "inj-1", queuedAt: 2_500 });
    expect(host.commands.at(-1)).toEqual({
      type: "inject",
      id: "plotroom-2",
      injectionId: "inj-1",
      text: "also this",
    });
  });

  it("ends as stopped when PlotRoom asked, after telling the sidecar", async () => {
    const host = new FakeSessionHost();
    const handle = await started(host);
    const observed = collect(handle);

    await handle.stop("graceful");

    expect(host.commands.at(-1)).toEqual({
      type: "stop",
      id: "plotroom-2",
      mode: "graceful",
    });
    expect(host.closed).toEqual(["graceful"]);
    expect((await observed).at(-1)).toEqual({
      kind: "session-ended",
      reason: { kind: "stopped", by: "user" },
      at: 1_000,
    });
  });

  it("aborts without asking the sidecar to wind down", async () => {
    const host = new FakeSessionHost();
    const handle = await started(host);

    await handle.stop("abort");

    expect(host.commands.map((command) => command.type)).toEqual(["prompt"]);
    expect(host.closed).toEqual(["abort"]);
  });

  it("reports a sidecar that died unasked as interrupted, never failed", async () => {
    const host = new FakeSessionHost();
    const handle = await started(host);
    const observed = collect(handle);

    // What a killed sidecar looks like from here: the stream simply stops.
    host.end();

    expect((await observed).at(-1)).toEqual({
      kind: "session-ended",
      reason: {
        kind: "interrupted",
        message: "the session host ended without a stop",
      },
      at: 1_000,
    });
  });

  it("turns a broken pipe into observations instead of throwing at the reader", async () => {
    const host = new FakeSessionHost();
    const handle = await started(host);
    const observed = collect(handle);

    host.fail(new Error("EPIPE"));

    const stream = await observed;
    expect(stream.at(-2)).toEqual({
      kind: "runtime-error",
      message: "EPIPE",
      fatal: true,
      at: 1_000,
    });
    expect(stream.at(-1)).toEqual({
      kind: "session-ended",
      reason: { kind: "failed", message: "EPIPE" },
      at: 1_000,
    });
  });

  it("drops a line it cannot read rather than ending the session", async () => {
    const host = new FakeSessionHost();
    const handle = await started(host);
    const observed = collect(handle);

    // The SDK prints to stdout as well; a stray line is not a session ending.
    host.raw("Downloading native addon...");
    host.emit({
      type: "observation",
      observation: { kind: "turn-started", turn: 1, at: 1_000 },
    });
    host.end();

    expect((await observed).map((observation) => observation.kind)).toEqual([
      "turn-started",
      "session-ended",
    ]);
  });

  it("streams observations the phase reducer accepts unchanged", async () => {
    const host = new FakeSessionHost();
    const handle = await started(host);
    const observed = collect(handle);

    for (const observation of [
      { kind: "turn-started", turn: 1, at: 1_000 },
      { kind: "reasoning-delta", text: "considering", at: 1_100 },
      { kind: "output-delta", text: "on it", at: 1_200 },
      {
        kind: "tool-started",
        toolName: "bash",
        callId: "call-1",
        input: { command: "ls" },
        at: 1_300,
      },
      {
        kind: "tool-finished",
        callId: "call-1",
        output: "a\nb",
        isError: false,
        at: 1_400,
      },
      {
        kind: "turn-ended",
        turn: 1,
        usage: {
          inputTokens: 120,
          outputTokens: 34,
          cacheReadTokens: 4,
          cacheWriteTokens: 0,
          costUsd: 0.0031,
        },
        at: 1_500,
      },
    ] satisfies RuntimeObservation[]) {
      host.emit({ type: "observation", observation });
    }
    await handle.stop("graceful");

    const phases: string[] = [];
    let state: SessionObservationState = initialObservationState(1_000);
    for (const observation of await observed) {
      state = reduceObservation(state, observation);
      phases.push(deriveSessionPhase(state, { now: observation.at }).kind);
    }

    expect(phases).toEqual([
      "thinking",
      "thinking",
      "responding",
      "tool-running",
      "responding",
      "waiting-input",
      "stopped",
    ]);
    expect(state.turnsCompleted).toBe(1);
    expect(state.accounting.costUsd).toBeCloseTo(0.0031);
  });
});
