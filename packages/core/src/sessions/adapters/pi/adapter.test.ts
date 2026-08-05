import { describe, expect, it } from "vitest";

import {
  EMPTY_INJECTIONS,
  injectionStatus,
  markDelivered,
  queueInjection,
} from "../../injection.js";
import {
  deriveSessionPhase,
  initialObservationState,
  reduceObservation,
} from "../../phases.js";
import type {
  RuntimeObservation,
  RuntimeSessionHandle,
} from "../../runtime.js";
import { makeLaunchChoices } from "../../testing.js";
import {
  buildPiArgs,
  composeSeededPrompt,
  createPiAdapter,
  PI_CAPABILITIES,
  PiForkUnavailable,
  resolvePiForkTarget,
  type PiRpcTransport,
} from "./adapter.js";
import { PI_ASK_TOOL_EXTENSION, PI_ASK_TOOL_NAME } from "./ask-tool.js";
import { diffDeliveredInjections } from "./observations.js";
import {
  parseGateRequest,
  PI_APPROVAL_TITLE_PREFIX,
  PI_QUESTION_TITLE_PREFIX,
} from "./permission-gate.js";
import { splitJsonLines } from "./protocol.js";

const NOW = 1_700_000_000_000;

/**
 * A replayed pi process: no model, no subprocess, the same JSONL. Every command
 * is acknowledged the way pi acknowledges it, so `inject()` resolving means
 * exactly what it means against the real thing — queue acceptance.
 */
class FakeTransport implements PiRpcTransport {
  readonly ref = "pi-session-1";
  readonly written: string[] = [];
  responses: Record<string, unknown> = {};

  #chunks: string[] = [];
  #waiting: ((result: IteratorResult<string>) => void) | null = null;
  #done = false;

  write(line: string): void {
    this.written.push(line);
    const command = JSON.parse(line) as { type: string; id?: string };
    if (command.type === "extension_ui_response") return;
    this.emit({
      type: "response",
      id: command.id,
      command: command.type,
      success: true,
      ...(this.responses[command.type] === undefined
        ? {}
        : { data: this.responses[command.type] }),
    });
  }

  emit(event: unknown): void {
    this.push(`${JSON.stringify(event)}\n`);
  }

  push(chunk: string): void {
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = null;
      waiting({ value: chunk, done: false });
      return;
    }
    this.#chunks.push(chunk);
  }

  chunks(): AsyncIterable<string> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<string>> => {
          const next = this.#chunks.shift();
          if (next !== undefined) {
            return Promise.resolve({ value: next, done: false });
          }
          if (this.#done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            this.#waiting = resolve;
          });
        },
      }),
    };
  }

  closed = false;

  async close(): Promise<void> {
    this.closed = true;
    this.end();
  }

  /** The process going away — a stop, a crash, or a restart. */
  end(): void {
    this.#done = true;
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = null;
      waiting({ value: undefined, done: true });
    }
  }

  commandsOfType(type: string): { type: string; [key: string]: unknown }[] {
    return this.written
      .map((line) => JSON.parse(line) as { type: string })
      .filter((command) => command.type === type) as {
      type: string;
      [key: string]: unknown;
    }[];
  }
}

function adapterWith(transport: FakeTransport) {
  return createPiAdapter({
    connect: async () => transport,
    now: () => NOW,
    extensionPaths: ["/state/pi/plotroom-gate.ts"],
  });
}

async function take(
  handle: RuntimeSessionHandle,
  count: number,
): Promise<RuntimeObservation[]> {
  const observations: RuntimeObservation[] = [];
  for await (const observation of handle.observations()) {
    observations.push(observation);
    if (observations.length === count) break;
  }
  return observations;
}

async function drain(
  handle: RuntimeSessionHandle,
): Promise<RuntimeObservation[]> {
  const observations: RuntimeObservation[] = [];
  for await (const observation of handle.observations()) {
    observations.push(observation);
  }
  return observations;
}

const startConfig = {
  prompt: "fix the drift flags",
  launch: makeLaunchChoices({ effort: "high" }),
  workspacePath: "/work/oxy-2982",
};

describe("pi argv from per-session choices (§3.6)", () => {
  it("carries model, effort, narrowed tools and the gate extension", () => {
    const args = buildPiArgs({
      mode: "start",
      launch: makeLaunchChoices({
        model: "anthropic/claude-sonnet-4",
        effort: "low",
        toolPermissions: { allowedTools: ["read", "bash"] },
      }),
      workspacePath: "/work",
      extensionPaths: ["/state/gate.ts"],
    });

    expect(args).toEqual([
      "--mode",
      "rpc",
      "--model",
      "anthropic/claude-sonnet-4",
      "--thinking",
      "low",
      "--tools",
      "read,bash",
      "-e",
      "/state/gate.ts",
    ]);
  });

  it("resumes and forks by native ref", () => {
    const base = {
      launch: makeLaunchChoices(),
      workspacePath: "/work",
      extensionPaths: [],
    };

    expect(buildPiArgs({ ...base, mode: "resume", ref: "s1" })).toContain(
      "--session",
    );
    expect(buildPiArgs({ ...base, mode: "fork", ref: "s1" })).toContain(
      "--fork",
    );
  });

  it("labels a seeded fork instead of passing it off as native", () => {
    const seeded = composeSeededPrompt({
      ...startConfig,
      seedTranscript: "## turn 1\nearlier work",
    });

    expect(seeded).toContain("Inherited transcript");
    expect(seeded).toContain("earlier work");
    expect(seeded).toContain(startConfig.prompt);
    expect(composeSeededPrompt(startConfig)).toBe(startConfig.prompt);
  });
});

describe("pi events become observations", () => {
  it("maps the stream PlotRoom derives phases from", async () => {
    const transport = new FakeTransport();
    const handle = await adapterWith(transport).start(startConfig);

    transport.emit({ type: "turn_start" });
    transport.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
    });
    transport.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "on it" },
    });
    transport.emit({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "pnpm test" },
    });
    transport.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: [] },
      isError: false,
    });
    transport.emit({ type: "compaction_start", reason: "threshold" });
    transport.emit({ type: "compaction_end", aborted: false });
    transport.emit({
      type: "turn_end",
      message: {
        usage: {
          input: 1_000,
          output: 200,
          cacheRead: 10,
          cost: { total: 0.012 },
        },
      },
    });

    const observations = await take(handle, 8);

    expect(observations.map((observation) => observation.kind)).toEqual([
      "turn-started",
      "reasoning-delta",
      "output-delta",
      "tool-started",
      "tool-finished",
      "compaction-started",
      "compaction-finished",
      "turn-ended",
    ]);
    expect(observations.at(-1)).toMatchObject({
      turn: 1,
      usage: {
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 10,
        costUsd: 0.012,
      },
    });

    // The phase reducer reads this stream and nothing else.
    const state = observations.reduce(
      (accumulator, observation) => reduceObservation(accumulator, observation),
      initialObservationState(NOW),
    );
    expect(deriveSessionPhase(state, { now: NOW })).toEqual({
      kind: "waiting-input",
    });

    transport.end();
  });

  it("sends the assembled content as pi's first prompt", async () => {
    const transport = new FakeTransport();
    await adapterWith(transport).start(startConfig);

    expect(transport.commandsOfType("prompt")).toMatchObject([
      { message: "fix the drift flags" },
    ]);
  });

  it("ignores events it does not understand instead of dying on them", async () => {
    const transport = new FakeTransport();
    const handle = await adapterWith(transport).start(startConfig);

    transport.emit({ type: "some_future_pi_event", payload: 1 });
    transport.push("not json at all\n");
    transport.emit({ type: "turn_start" });

    const observations = await take(handle, 1);
    expect(observations[0]?.kind).toBe("turn-started");

    transport.end();
  });
});

describe("injection is a ledger: queued → delivered (§6.5)", () => {
  it("resolves inject() on queue acceptance and observes delivery later", async () => {
    const transport = new FakeTransport();
    const handle = await adapterWith(transport).start(startConfig);

    const receipt = await handle.inject({ id: "inj-1", text: "use pnpm" });
    expect(receipt).toEqual({ id: "inj-1", queuedAt: NOW });
    // A prompt carrying `streamingBehavior: "steer"`, never the bare `steer`
    // command: pi's standalone steer queues without triggering a turn, so an
    // injection into a live-but-idle session would never be delivered (§6.5).
    expect(transport.commandsOfType("steer")).toEqual([]);
    expect(transport.commandsOfType("prompt")).toMatchObject([
      { message: "fix the drift flags" },
      { message: "use pnpm", streamingBehavior: "steer" },
    ]);

    let ledger = queueInjection(EMPTY_INJECTIONS, {
      id: receipt.id,
      sessionId: "sess-1" as never,
      author: { kind: "human" },
      nodeId: "node-1" as never,
      text: "use pnpm",
      queuedAt: receipt.queuedAt,
    });
    expect(injectionStatus(ledger.get("inj-1") ?? never())).toBe("queued");

    // Still held by pi: queued, and honestly so.
    transport.emit({ type: "queue_update", steering: ["use pnpm"] });
    // Consumed at the turn boundary.
    transport.emit({ type: "queue_update", steering: [] });

    const observations = await take(handle, 1);
    expect(observations[0]).toMatchObject({
      kind: "injection-delivered",
      injectionId: "inj-1",
    });

    ledger = markDelivered(ledger, "inj-1", NOW + 90_000);
    expect(injectionStatus(ledger.get("inj-1") ?? never())).toBe("delivered");

    transport.end();
  });

  it("recognizes delivery by what left pi's queue, once it was seen in it", () => {
    const pending = [
      { id: "a", text: "first" },
      { id: "b", text: "second" },
    ];

    // First sighting: both held, nothing delivered.
    const held = diffDeliveredInjections(pending, ["first", "second"]);
    expect(held).toEqual({
      delivered: [],
      remaining: [
        { id: "a", text: "first", held: true },
        { id: "b", text: "second", held: true },
      ],
    });

    expect(diffDeliveredInjections(held.remaining, ["second"])).toEqual({
      delivered: ["a"],
      remaining: [{ id: "b", text: "second", held: true }],
    });
    expect(diffDeliveredInjections(held.remaining, [])).toEqual({
      delivered: ["a", "b"],
      remaining: [],
    });
  });

  it("does not call an injection delivered that pi was never seen holding", () => {
    // pi consumed it immediately (it was idle), so it is absent from `steering`
    // from the first update onwards. Reporting delivery here would report it
    // before the turn it became had started.
    const pending = [{ id: "a", text: "first" }];
    expect(diffDeliveredInjections(pending, [])).toEqual({
      delivered: [],
      remaining: [{ id: "a", text: "first", held: false }],
    });
  });

  it("delivers an immediately-consumed injection at the turn it became", async () => {
    const transport = new FakeTransport();
    const handle = await adapterWith(transport).start(startConfig);

    await handle.inject({ id: "inj-idle", text: "look at docs/ instead" });
    // pi was idle: no steering queue entry, just a turn.
    transport.emit({ type: "queue_update", steering: [] });
    transport.emit({ type: "turn_start" });

    const observations = await take(handle, 2);
    expect(observations.map((observation) => observation.kind)).toEqual([
      "turn-started",
      "injection-delivered",
    ]);
    expect(observations[1]).toMatchObject({ injectionId: "inj-idle" });

    transport.end();
  });

  it("delivers a queued injection only once, at the boundary it left the queue", async () => {
    const transport = new FakeTransport();
    const handle = await adapterWith(transport).start(startConfig);

    await handle.inject({ id: "inj-held", text: "stop grepping" });
    transport.emit({ type: "queue_update", steering: ["stop grepping"] });
    // A turn starting while pi still holds it is not delivery.
    transport.emit({ type: "turn_start" });
    transport.emit({ type: "queue_update", steering: [] });

    const observations = await take(handle, 2);
    expect(observations.map((observation) => observation.kind)).toEqual([
      "turn-started",
      "injection-delivered",
    ]);

    transport.end();
  });
});

describe("approvals gate the runtime (§6.6, C6)", () => {
  it("raises the gate's request and answers it", async () => {
    const transport = new FakeTransport();
    const handle = await adapterWith(transport).start(startConfig);

    transport.emit({
      type: "extension_ui_request",
      id: "req-1",
      method: "confirm",
      title: `${PI_APPROVAL_TITLE_PREFIX}bash`,
      message: JSON.stringify({ command: "rm -rf /" }),
    });

    const [raised] = await take(handle, 1);
    expect(raised).toMatchObject({
      kind: "request-raised",
      requestId: "req-1",
      request: {
        kind: "tool-permission",
        toolName: "bash",
        input: { command: "rm -rf /" },
      },
    });

    await handle.respond("req-1", { kind: "deny", reason: "not approved" });

    expect(transport.commandsOfType("extension_ui_response")).toMatchObject([
      { id: "req-1", confirmed: false },
    ]);
    const [settled] = await take(handle, 1);
    expect(settled).toMatchObject({
      kind: "request-settled",
      requestId: "req-1",
    });

    transport.end();
  });

  it("ignores extension dialogs that are not PlotRoom's to answer", async () => {
    const transport = new FakeTransport();
    const handle = await adapterWith(transport).start(startConfig);

    transport.emit({
      type: "extension_ui_request",
      id: "req-9",
      method: "confirm",
      title: "some other extension",
      message: "{}",
    });
    transport.emit({ type: "turn_start" });

    const [first] = await take(handle, 1);
    expect(first?.kind).toBe("turn-started");

    transport.end();
  });
});

describe("how a pi session ends", () => {
  it("calls a stream that ended on its own an interruption, not a failure", async () => {
    const transport = new FakeTransport();
    const handle = await adapterWith(transport).start(startConfig);

    transport.end();

    const observations = await drain(handle);
    expect(observations.at(-1)).toMatchObject({
      kind: "session-ended",
      reason: { kind: "interrupted" },
    });
  });

  it("calls a stop a stop", async () => {
    const transport = new FakeTransport();
    const handle = await adapterWith(transport).start(startConfig);

    const observations = drain(handle);
    await handle.stop("graceful");

    expect(transport.commandsOfType("abort")).toHaveLength(1);
    expect((await observations).at(-1)).toMatchObject({
      kind: "session-ended",
      reason: { kind: "stopped", by: "user" },
    });
  });

  it("does not hang a graceful stop after the stream already ended (issue #110)", async () => {
    const transport = new FakeTransport();
    const handle = await adapterWith(transport).start(startConfig);

    // The stream ended on its own — a crash, or a stop that landed between the
    // process dying and the driver detaching its handle — before this stop
    // gesture arrived. Drained fully first, so `#read`'s loop has actually
    // exited (not merely told to) by the time `stop` sends a command nothing
    // will ever answer; without the `#ended` latch this hangs forever.
    transport.end();
    await drain(handle);

    await expect(handle.stop("graceful")).resolves.toBeUndefined();
  });

  it("never reports out-of-budget itself", () => {
    expect(PI_CAPABILITIES.enforcesPermissions).toBe(true);
    expect(PI_CAPABILITIES.injection).toBe("between-turns");
    expect(PI_CAPABILITIES.fork).toBe("turn-boundary");
  });
});

describe("JSONL framing", () => {
  it("splits on LF only, and keeps a partial record", () => {
    const { lines, rest } = splitJsonLines('{"a":1}\n{"b":2}\n{"c":');

    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('{"c":');
  });

  it("does not split on the separators a generic line reader would", () => {
    const record = `{"text":"a\u2028b\u2029c"}`;
    const { lines } = splitJsonLines(`${record}\n`);

    expect(lines).toEqual([record]);
    expect(JSON.parse(lines[0] ?? "null")).toEqual({ text: "a\u2028b\u2029c" });
  });

  it("tolerates CRLF input", () => {
    const { lines } = splitJsonLines('{"a":1}\r\n');

    expect(lines).toEqual(['{"a":1}']);
  });
});

function never(): never {
  throw new Error("expected a ledger entry");
}

describe("fork from a point maps onto pi's own surface (§6.3)", () => {
  const messages = [
    { entryId: "e1", text: "turn one prompt" },
    { entryId: "e2", text: "turn two prompt" },
    { entryId: "e3", text: "turn three prompt" },
  ];

  it("forks from the message that opens the NEXT turn, because PlotRoom forks inclusively", () => {
    // A fork at turn 2 keeps turns 1 and 2, so pi's branch begins at the user
    // message that opened turn 3.
    expect(resolvePiForkTarget(messages, { turn: 2 })).toEqual({
      kind: "rewound",
      entryId: "e3",
    });
    expect(resolvePiForkTarget(messages, { turn: 1 })).toEqual({
      kind: "rewound",
      entryId: "e2",
    });
  });

  it("needs no command at the tip: `pi --fork` already inherited everything", () => {
    expect(resolvePiForkTarget(messages, { turn: 3 })).toEqual({
      kind: "inherited",
    });
  });

  it("refuses a point past what pi lists rather than clamping to the nearest", () => {
    expect(resolvePiForkTarget(messages, { turn: 4 })).toMatchObject({
      kind: "unavailable",
    });
    expect(resolvePiForkTarget(messages, { turn: 0 })).toMatchObject({
      kind: "unavailable",
    });
    expect(resolvePiForkTarget([], { turn: 1 })).toMatchObject({
      kind: "unavailable",
    });
  });

  it("sends the fork command for an interior point", async () => {
    const transport = new FakeTransport();
    transport.responses = { get_fork_messages: { messages } };

    const handle = await adapterWith(transport).fork(
      "pi-session-1",
      { turn: 1 },
      { ...startConfig, prompt: "carry on from there" },
    );

    expect(transport.commandsOfType("fork")).toMatchObject([{ entryId: "e2" }]);
    expect(transport.commandsOfType("prompt")).toMatchObject([
      { message: "carry on from there" },
    ]);
    expect(handle.ref).toBe("pi-session-1");

    transport.end();
  });

  it("sends no fork command at the tip", async () => {
    const transport = new FakeTransport();
    transport.responses = { get_fork_messages: { messages } };

    await adapterWith(transport).fork("pi-session-1", { turn: 3 }, startConfig);

    expect(transport.commandsOfType("fork")).toEqual([]);
    expect(transport.commandsOfType("prompt")).toHaveLength(1);

    transport.end();
  });

  it("treats a cancelled fork as a fork that did not happen", async () => {
    const transport = new FakeTransport();
    transport.responses = {
      get_fork_messages: { messages },
      // pi answers success: true and says so only in `data.cancelled`.
      fork: { text: "turn two prompt", cancelled: true },
    };

    // With no seed to fall back to, the refusal surfaces rather than producing a
    // session that inherited nothing while claiming a native fork.
    await expect(
      adapterWith(transport).fork("pi-session-1", { turn: 1 }, startConfig),
    ).rejects.toThrow(PiForkUnavailable);

    transport.end();
  });

  it("refuses rather than seeding a session the caller would record as native", async () => {
    // The adapter used to substitute a seeded session here. That produced a
    // handle the caller — which decided `native` from `planFork` and records
    // `runtime.mode` from that decision — would have stored as a native fork. It
    // does only what it was asked now, so a false mode is unrepresentable rather
    // than something the caller has to remember to re-read.
    const transports: FakeTransport[] = [];
    const adapter = createPiAdapter({
      connect: async () => {
        const transport = new FakeTransport();
        transport.responses = { get_fork_messages: { messages } };
        transports.push(transport);
        return transport;
      },
      now: () => NOW,
    });

    await expect(
      adapter.fork(
        "pi-session-1",
        // Past what pi lists: the native route is gone.
        { turn: 9 },
        {
          ...startConfig,
          prompt: "keep going",
          // Supplied, and deliberately not used: seeding is the caller's own
          // branch (`start({ seedTranscript })`), which is what records `seeded`.
          seedTranscript: "user: turn one prompt",
        },
      ),
    ).rejects.toThrow(PiForkUnavailable);

    // One process, aborted — not a second, quietly seeded one.
    expect(transports).toHaveLength(1);
    expect((transports[0] as FakeTransport).commandsOfType("prompt")).toEqual(
      [],
    );
  });

  it("leaves no pi process running behind a refused fork", async () => {
    const transport = new FakeTransport();
    transport.responses = { get_fork_messages: { messages: [] } };

    await expect(
      adapterWith(transport).fork("pi-session-1", { turn: 1 }, startConfig),
    ).rejects.toThrow(PiForkUnavailable);

    // The half-forked native session is closed on the way out: a session nothing
    // is driving is a leak the operator cannot see.
    expect(transport.closed).toBe(true);
  });

  it("seeds through start(), which is the caller's own branch", async () => {
    // The seeded route the caller takes after catching `PiForkUnavailable`. It is
    // an ordinary start with the labelled prefix, and it sends no fork command —
    // so whichever branch the caller took is the mode it records.
    const transport = new FakeTransport();
    const handle = await adapterWith(transport).start({
      ...startConfig,
      prompt: "keep going",
      seedTranscript: "user: turn one prompt",
    });

    const prompts = transport.commandsOfType("prompt");
    expect(prompts).toHaveLength(1);
    expect(String(prompts[0]?.message)).toContain("# Inherited transcript");
    expect(String(prompts[0]?.message)).toContain("keep going");
    expect(transport.commandsOfType("fork")).toEqual([]);

    await handle.stop("abort");
  });
});

describe("plotroom_ask carries no timer (§6.4, §14, principle 2)", () => {
  it("asks through PlotRoom's question channel", () => {
    expect(PI_ASK_TOOL_EXTENSION).toContain(`name: "${PI_ASK_TOOL_NAME}"`);
    expect(PI_ASK_TOOL_EXTENSION).toContain("ctx.ui.select(");
    expect(PI_ASK_TOOL_EXTENSION).toContain(PI_QUESTION_TITLE_PREFIX);
    // The answer goes back structurally, with what was declined named too (§6.4).
    expect(PI_ASK_TOOL_EXTENSION).toContain("pathsNotTaken");
  });

  it("contains no timeout of any kind", () => {
    // pi's dialogs accept `{ timeout }` and auto-resolve when it expires. Using
    // it would be a timed default, which §14 forbids outright. This assertion is
    // the enforcement: the generated source cannot acquire one quietly.
    for (const timer of [
      "timeout",
      "setTimeout",
      "AbortSignal",
      "setInterval",
    ]) {
      expect(PI_ASK_TOOL_EXTENSION).not.toContain(timer);
    }
  });

  it("returns an error, never a choice, when the question is dismissed", () => {
    expect(PI_ASK_TOOL_EXTENSION).toContain("Nothing was chosen for you.");
    expect(PI_ASK_TOOL_EXTENSION).toContain("answer: null");
  });

  it("refuses to ask when there is nobody to answer", () => {
    expect(PI_ASK_TOOL_EXTENSION).toContain("!ctx.hasUI");
  });

  it("is recognised as a question when it reaches PlotRoom", () => {
    const parsed = parseGateRequest({
      type: "extension_ui_request",
      id: "req-1",
      method: "select",
      title: `${PI_QUESTION_TITLE_PREFIX}rebuild or add a column?`,
      options: ["rebuild the table", "add a column"],
    });

    expect(parsed).toEqual({
      requestId: "req-1",
      request: {
        kind: "question",
        text: "rebuild or add a column?",
        options: ["rebuild the table", "add a column"],
      },
    });
  });
});
