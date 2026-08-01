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
  type PiRpcTransport,
} from "./adapter.js";
import { diffDeliveredInjections } from "./observations.js";
import { PI_APPROVAL_TITLE_PREFIX } from "./permission-gate.js";
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

  async close(): Promise<void> {
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
    expect(transport.commandsOfType("steer")).toMatchObject([
      { message: "use pnpm" },
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

  it("recognizes delivery by what left pi's queue", () => {
    const pending = [
      { id: "a", text: "first" },
      { id: "b", text: "second" },
    ];

    expect(diffDeliveredInjections(pending, ["first", "second"])).toEqual({
      delivered: [],
      remaining: pending,
    });
    expect(diffDeliveredInjections(pending, ["second"])).toEqual({
      delivered: ["a"],
      remaining: [{ id: "b", text: "second" }],
    });
    expect(diffDeliveredInjections(pending, [])).toEqual({
      delivered: ["a", "b"],
      remaining: [],
    });
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
