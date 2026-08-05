import { describe, expect, it } from "vitest";

import {
  deriveSessionPhase,
  initialObservationState,
  reduceObservation,
  type SessionObservationState,
} from "../../phases.js";
import type {
  Delay,
  RuntimeObservation,
  RuntimeSessionHandle,
  SessionRuntimeAdapter,
  RuntimeStartConfig,
} from "../../runtime.js";
import { makeLaunchChoices } from "../../testing.js";
import {
  createOmpAdapter,
  ACK_TIMEOUT_MS,
  READY_TIMEOUT_MS,
  SessionHostForkUnavailable,
  SessionHostNotReady,
  SessionHostSilent,
  STREAM_END_TIMEOUT_MS,
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
  /**
   * The frame channel stays open after the process goes — what anything else
   * holding its write end looks like from here (issue #108, #92). An `abort`
   * still ends it, because that signals the whole group.
   */
  holdsChannelOpen = false;
  /** Not even the group signal reaps the holder: the worst case (issue #108). */
  ignoresAbort = false;

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

  frameChunks(): AsyncIterable<string> {
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
    // A graceful close returns once the process has gone; only the group signal
    // reaches whatever else is holding the channel.
    if (this.holdsChannelOpen && (mode === "graceful" || this.ignoresAbort)) {
      return;
    }
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

/**
 * The adapter's two bounds, under the test's control (issue #108).
 *
 * A wait that never settles is what "no bound fired" means, which is the right
 * default for every test that is about something else: a real timer here would
 * make those tests depend on how long they took to run.
 */
class ManualDelay {
  readonly armed: { readonly ms: number; readonly fire: () => void }[] = [];

  // The executor form because this package's `lib` predates
  // `Promise.withResolvers`, which is also why the adapter itself uses it.
  readonly delay: Delay = (ms) =>
    new Promise<void>((resolve) => {
      this.armed.push({ ms, fire: resolve });
    });
}

function adapterOver(
  host: FakeSessionHost,
  now: () => number = () => 1_000,
  delay: Delay = () => new Promise<void>(() => undefined),
): SessionRuntimeAdapter {
  return createOmpAdapter({
    connect: () => Promise.resolve(host),
    now,
    sessionDir: "/state/runtime/session-host",
    delay,
  });
}

async function started(
  host: FakeSessionHost,
  ref = "/state/runtime/session-host/a.jsonl",
  delay?: Delay,
): Promise<RuntimeSessionHandle> {
  const pending = adapterOver(host, undefined, delay).start(START);
  host.emit({ type: "ready", ref });
  return pending;
}

/**
 * Yield until the adapter has armed a bound of exactly this length, then take it.
 *
 * By length, because the two bounds are told apart by nothing else and a handle
 * that has already started still holds its unfired `ready` bound. Microtasks
 * only — no timer and no sleep: `start()` and `stop()` are several awaits deep
 * before they reach the wait being bounded, and a fixed sleep would be a guess
 * that races on a loaded machine.
 */
async function nextBound(
  bounds: ManualDelay,
  ms: number,
): Promise<{ readonly ms: number; readonly fire: () => void }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    // The **newest** match, because a wait the adapter armed and then stopped
    // caring about stays in this list: a handle that has started still holds the
    // unfired bound from its `ready` wait and from the prompt it acknowledged, and
    // firing one of those would do nothing to the wait under test.
    const index = bounds.armed.findLastIndex((armed) => armed.ms === ms);
    const found = bounds.armed[index];
    if (found) {
      bounds.armed.splice(index, 1);
      return found;
    }
    await Promise.resolve();
  }
  throw new Error(`the adapter armed no ${ms.toString()}ms bound`);
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
  it("keeps its three bounds distinguishable, which is how the tests below pick one", () => {
    // `nextBound` finds an armed wait by its length, because that is the only
    // thing that tells them apart. Two of them converging would make every test
    // below silently select the wrong one, so the coupling is asserted rather
    // than left to be discovered.
    expect(READY_TIMEOUT_MS).not.toBe(ACK_TIMEOUT_MS);
    expect(ACK_TIMEOUT_MS).not.toBe(STREAM_END_TIMEOUT_MS);
    expect(READY_TIMEOUT_MS).not.toBe(STREAM_END_TIMEOUT_MS);
  });

  it("stops waiting for a command the session host never acknowledges (issue #108)", async () => {
    const host = new FakeSessionHost();
    const bounds = new ManualDelay();
    // Reports a session, then answers nothing — the half of the hang the ready
    // bound alone does not reach, because `open()` awaits the prompt's ack next.
    host.autoAck = false;
    const pending = adapterOver(host, () => 1_000, bounds.delay).start(START);
    host.emit({ type: "ready", ref: "/sessions/a.jsonl" });

    (await nextBound(bounds, ACK_TIMEOUT_MS)).fire();

    await expect(pending).rejects.toThrow(SessionHostSilent);
    // Aborted for the same reason the ready bound aborts: no session is being
    // returned, so nothing above would ever stop this process.
    expect(host.closed).toEqual(["abort"]);
  });

  it("refuses an unacknowledged injection without killing the session", async () => {
    const host = new FakeSessionHost();
    const bounds = new ManualDelay();
    const handle = await started(host, "/sessions/a.jsonl", bounds.delay);
    host.autoAck = false;

    const injected = handle.inject({ id: "inj-1", text: "look at this" });
    (await nextBound(bounds, ACK_TIMEOUT_MS)).fire();

    // A refused injection is a state the ledger has (§6.5); killing a working
    // session because one command went unanswered would be the worse answer.
    await expect(injected).rejects.toThrow(SessionHostSilent);
    expect(host.closed).toEqual([]);
  });

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

  it("stops waiting for a session host that never reports one (issue #108)", async () => {
    const host = new FakeSessionHost();
    const bounds = new ManualDelay();
    // Alive, framing nothing. From outside it looks healthy, which is why
    // nothing above the adapter can tell the difference or escalate.
    const pending = adapterOver(host, () => 1_000, bounds.delay).start(START);

    // Named by the lookup: a bound of another length is a different bound.
    (await nextBound(bounds, READY_TIMEOUT_MS)).fire();

    await expect(pending).rejects.toThrow(SessionHostNotReady);
    // Aborted rather than left running: it holds a workspace and a provider
    // connection, and PlotRoom has just decided it is not going to be a session.
    expect(host.closed).toEqual(["abort"]);
  });

  it("names the bound rather than reporting a process that died", async () => {
    const host = new FakeSessionHost();
    const bounds = new ManualDelay();
    const pending = adapterOver(host, () => 1_000, bounds.delay).start(START);
    (await nextBound(bounds, READY_TIMEOUT_MS)).fire();

    await expect(pending).rejects.toThrow(
      /did not report a session within 180s/,
    );
  });

  it("stops waiting for a frame channel that outlived the process (issue #108)", async () => {
    const host = new FakeSessionHost();
    const bounds = new ManualDelay();
    const handle = await started(host, "/sessions/a.jsonl", bounds.delay);
    const observed = collect(handle);
    // Something else holds the channel's write end, so a graceful close returns
    // and the frame stream stays open — reachable through a foreign executable
    // named by `PLOTROOM_SESSION_HOST` (#92).
    host.holdsChannelOpen = true;

    const stopped = handle.stop("graceful");
    // The bound on the frame stream ending, which the holder keeps open.
    (await nextBound(bounds, STREAM_END_TIMEOUT_MS)).fire();

    await expect(stopped).resolves.toBeUndefined();
    // Escalated once: the abort signals the group, which reaps the holder.
    expect(host.closed).toEqual(["graceful", "abort"]);
    // And the observation stream ended, so a caller iterating it is not left
    // waiting for a session that has already stopped.
    expect((await observed).at(-1)).toMatchObject({
      kind: "session-ended",
      reason: { kind: "stopped", by: "user" },
    });
  });

  it("ends the observation stream even when nothing ever closes the channel", async () => {
    const host = new FakeSessionHost();
    const bounds = new ManualDelay();
    const handle = await started(host, "/sessions/a.jsonl", bounds.delay);
    const observed = collect(handle);
    // Not even the group signal reaps it: the worst case, and the one where an
    // unbounded wait hung the stop gesture and the request behind it for ever.
    host.holdsChannelOpen = true;
    host.ignoresAbort = true;

    const stopped = handle.stop("abort");
    (await nextBound(bounds, STREAM_END_TIMEOUT_MS)).fire();

    await expect(stopped).resolves.toBeUndefined();

    const stream = await observed;
    // Still a **stop**, not a failure. The operator asked for this, and
    // `RunService` folds a `failed` end straight into `runs.fail` — so recording
    // PlotRoom's own cleanup trouble as the session's outcome would report a run
    // the operator stopped as one that broke.
    expect(stream.at(-1)).toEqual({
      kind: "session-ended",
      reason: { kind: "stopped", by: "user" },
      at: 1_000,
    });
    // The trouble is still in the record, as its own non-fatal observation.
    expect(stream.at(-2)).toMatchObject({
      kind: "runtime-error",
      fatal: false,
      message: expect.stringContaining("stayed open after the process left"),
    });
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

  it("reports a line it cannot read rather than dropping it, and keeps the session (§109)", async () => {
    const host = new FakeSessionHost();
    const handle = await started(host);
    const observed = collect(handle);

    // Nothing but PlotRoom writes the frame channel, so a damaged line means a
    // frame arrived corrupt and an observation is gone. Silence about that was
    // the bug: the observation log is the record.
    host.raw('{"type":"observation","observation":{"kind":"outpDownloading n');
    host.emit({
      type: "observation",
      observation: { kind: "turn-started", turn: 1, at: 1_000 },
    });
    host.end();

    const stream = await observed;
    expect(stream.map((observation) => observation.kind)).toEqual([
      "runtime-error",
      "turn-started",
      "session-ended",
    ]);
    // Non-fatal: the session is alive and the rest of the stream is worth
    // having, so this must not read as the session having failed.
    expect(stream[0]).toMatchObject({ kind: "runtime-error", fatal: false });
    expect(stream[0]).toHaveProperty(
      "message",
      expect.stringContaining("one observation was lost"),
    );
    expect(stream.at(-1)).toMatchObject({
      kind: "session-ended",
      reason: { kind: "interrupted" },
    });
  });

  it("bounds a damaged frame in the observation that reports it", async () => {
    const host = new FakeSessionHost();
    const handle = await started(host);
    const observed = collect(handle);

    // An interleaved vendor write can carry a whole output delta with it; one
    // corrupt line must not become the largest thing in the log.
    const damaged = `{"type":"observation",${"x".repeat(5_000)}`;
    host.raw(damaged);
    host.end();

    const error = (await observed)[0];
    expect(error?.kind).toBe("runtime-error");
    const message = error?.kind === "runtime-error" ? error.message : "";
    // The whole length is stated, so nothing about the loss is hidden, and only
    // a prefix of the bytes is carried.
    expect(message).toContain(`${damaged.length.toString()} chars`);
    expect(message.length).toBeLessThan(400);
  });

  it("reports a flood of damaged frames twice, not once per line", async () => {
    const host = new FakeSessionHost();
    const handle = await started(host);
    const observed = collect(handle);

    // A sidecar logging plain text to the frame channel produces this
    // continuously. One observation per line would write a row per line and,
    // worse, keep advancing the silence clock `deriveSessionHealth` reads — so a
    // session whose channel is broken would read as busy and healthy for as long
    // as it stayed broken.
    for (let i = 0; i < 50; i += 1) host.raw(`not a frame ${i.toString()}`);
    host.end();

    const errors = (await observed).filter(
      (observation) => observation.kind === "runtime-error",
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toHaveProperty(
      "message",
      expect.stringContaining("one observation was lost"),
    );
    // The total is in the record, so the size of the loss is not lost with it.
    expect(errors[1]).toHaveProperty(
      "message",
      "50 session-host frames were unreadable, so that many observations were lost",
    );
  });

  it("reports a single damaged frame once, with no summary after it", async () => {
    const host = new FakeSessionHost();
    const handle = await started(host);
    const observed = collect(handle);

    host.raw("not a frame");
    host.end();

    const errors = (await observed).filter(
      (observation) => observation.kind === "runtime-error",
    );
    expect(errors).toHaveLength(1);
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
