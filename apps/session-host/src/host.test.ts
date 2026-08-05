import { describe, expect, it } from "bun:test";
import {
  encodeSessionHostCommand,
  type SessionHostCommand,
  type SessionHostEvent,
} from "@plotroom/core";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";

import { runSessionHost, type HostedSession } from "./host.js";
import { createRequestBridge, type RequestBridge } from "./request-bridge.js";

/** The SDK session, replayed: what the loop did to it is what is under test. */
class FakeSession implements HostedSession {
  readonly sessionFile = "/sessions/a.jsonl";
  readonly prompts: { text: string; steering: boolean }[] = [];
  aborts = 0;
  /** Set to reject the next `prompt()`, the way a failed turn does. */
  promptFailure: Error | null = null;
  /** What `getQueuedMessages()` reports until a test changes it. */
  queuedSteering: string[] = [];
  /** What `getSessionStats().contextUsage` reports until a test sets it. */
  contextUsage: { tokens: number; contextWindow: number } | undefined =
    undefined;

  #listener: ((event: AgentSessionEvent) => void) | null = null;
  #turn: (() => void) | null = null;

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listener = listener;
    return () => {
      this.#listener = null;
    };
  }

  emit(event: unknown): void {
    this.#listener?.(event as AgentSessionEvent);
  }

  get subscribed(): boolean {
    return this.#listener !== null;
  }

  prompt(
    text: string,
    options?: { streamingBehavior?: "steer" },
  ): Promise<boolean> {
    this.prompts.push({
      text,
      steering: options?.streamingBehavior === "steer",
    });
    if (this.promptFailure !== null) return Promise.reject(this.promptFailure);
    // A real turn resolves when it completes. Nothing here resolves it unless a
    // test asks, which is how "the loop did not wait for the turn" is testable.
    return new Promise<boolean>((resolve) => {
      this.#turn = () => {
        resolve(true);
      };
    });
  }

  getQueuedMessages(): {
    readonly steering: readonly string[];
    readonly followUp: readonly string[];
  } {
    return { steering: this.queuedSteering, followUp: [] };
  }

  getSessionStats(): {
    readonly contextUsage?: {
      readonly tokens: number;
      readonly contextWindow: number;
    };
  } {
    return this.contextUsage === undefined
      ? {}
      : { contextUsage: this.contextUsage };
  }

  finishTurn(): void {
    this.#turn?.();
    this.#turn = null;
  }

  abort(): Promise<void> {
    this.aborts += 1;
    return Promise.resolve();
  }
}

/** Stdin, as PlotRoom writes it: commands pushed one line at a time. */
class FakeInput implements AsyncIterable<string> {
  #chunks: string[] = [];
  #waiting: ((result: IteratorResult<string>) => void) | null = null;
  #done = false;

  send(command: SessionHostCommand): void {
    this.#push(encodeSessionHostCommand(command));
  }

  raw(line: string): void {
    this.#push(`${line}\n`);
  }

  end(): void {
    this.#done = true;
    const waiting = this.#waiting;
    this.#waiting = null;
    waiting?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
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
    };
  }

  #push(chunk: string): void {
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = null;
      waiting({ value: chunk, done: false });
      return;
    }
    this.#chunks.push(chunk);
  }
}

interface Harness {
  readonly session: FakeSession;
  readonly input: FakeInput;
  readonly frames: SessionHostEvent[];
  readonly run: Promise<void>;
  readonly requestBridge: RequestBridge;
}

function host(): Harness {
  const session = new FakeSession();
  const input = new FakeInput();
  const frames: SessionHostEvent[] = [];
  const requestBridge = createRequestBridge(
    (frame) => frames.push(frame),
    () => 1_000,
  );
  const run = runSessionHost({
    session,
    ref: session.sessionFile,
    writeFrame: (frame) => frames.push(frame),
    input,
    now: () => 1_000,
    requestBridge,
  });
  return { session, input, frames, run, requestBridge };
}

/** Let the loop drain what has been pushed. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
}

describe("the session host loop", () => {
  it("reports the native ref before anything else", async () => {
    const harness = host();
    await settle();

    expect(harness.frames[0]).toEqual({
      type: "ready",
      ref: "/sessions/a.jsonl",
    });

    harness.input.end();
    await harness.run;
  });

  it("acknowledges a prompt without waiting for the turn it starts", async () => {
    const harness = host();
    harness.input.send({ type: "prompt", id: "c1", text: "do the thing" });
    await settle();

    expect(harness.session.prompts).toEqual([
      { text: "do the thing", steering: false },
    ]);
    expect(harness.frames).toContainEqual({ type: "ack", id: "c1" });

    // The turn is still running, and the loop is still reading commands.
    harness.input.send({ type: "prompt", id: "c2", text: "and this" });
    await settle();
    expect(harness.frames).toContainEqual({ type: "ack", id: "c2" });

    harness.session.finishTurn();
    harness.input.end();
    await harness.run;
  });

  it("injects as a steering message, so it lands in either state", async () => {
    const harness = host();
    harness.input.send({
      type: "inject",
      id: "c1",
      injectionId: "inj-1",
      text: "also this",
    });
    await settle();

    expect(harness.session.prompts).toEqual([
      { text: "also this", steering: true },
    ]);
    expect(harness.frames).toContainEqual({ type: "ack", id: "c1" });

    harness.input.end();
    await harness.run;
  });

  it("reports an injection delivered once the queue no longer holds it (issue #82)", async () => {
    const harness = host();
    harness.input.send({
      type: "inject",
      id: "c1",
      injectionId: "inj-1",
      text: "also this",
    });
    await settle();

    // Idle when it arrived: nothing ever held it queued, so the next turn
    // boundary is the first moment its delivery is observable.
    harness.session.emit({ type: "turn_start" });
    await settle();

    expect(harness.frames).toContainEqual({
      type: "observation",
      observation: {
        kind: "injection-delivered",
        injectionId: "inj-1",
        at: 1_000,
      },
    });

    harness.input.end();
    await harness.run;
  });

  it("keeps an injection pending while the runtime still holds it queued", async () => {
    const harness = host();
    harness.input.send({
      type: "inject",
      id: "c1",
      injectionId: "inj-1",
      text: "also this",
    });
    await settle();

    // Streaming when it arrived: the runtime is still holding it at this
    // boundary, so it must not be reported delivered yet.
    harness.session.queuedSteering = ["also this"];
    harness.session.emit({ type: "turn_start" });
    await settle();

    expect(harness.frames).not.toContainEqual(
      expect.objectContaining({
        type: "observation",
        observation: expect.objectContaining({ kind: "injection-delivered" }),
      }),
    );

    // Consumed by the next boundary.
    harness.session.queuedSteering = [];
    harness.session.emit({ type: "turn_start" });
    await settle();

    expect(harness.frames).toContainEqual({
      type: "observation",
      observation: {
        kind: "injection-delivered",
        injectionId: "inj-1",
        at: 1_000,
      },
    });

    harness.input.end();
    await harness.run;
  });

  it("reports a rejected injection against its own id, not as an anonymous error (issue #107)", async () => {
    const harness = host();
    harness.session.promptFailure = new Error("the session was disposed");
    harness.input.send({
      type: "inject",
      id: "c1",
      injectionId: "inj-1",
      text: "also this",
    });
    await settle();

    expect(harness.frames).toContainEqual({ type: "ack", id: "c1" });
    expect(harness.frames).toContainEqual({
      type: "observation",
      observation: {
        kind: "injection-refused",
        injectionId: "inj-1",
        reason: "the session was disposed",
        at: 1_000,
      },
    });
    // Never as the anonymous shape a bare prompt's rejection uses — that would
    // make the ledger's `refused` state unreachable (issue #107).
    expect(harness.frames).not.toContainEqual(
      expect.objectContaining({
        type: "observation",
        observation: expect.objectContaining({ kind: "runtime-error" }),
      }),
    );

    harness.input.end();
    await harness.run;
  });

  it("never reports a refused injection delivered at a later turn boundary (issue #107)", async () => {
    // The review that caught this: a refused injection's text was never in
    // the queue either, so the next turn_start's diff found it "gone" and
    // fabricated a delivery for an id the ledger had already closed refused.
    const harness = host();
    harness.session.promptFailure = new Error("the session was disposed");
    harness.input.send({
      type: "inject",
      id: "c1",
      injectionId: "inj-1",
      text: "also this",
    });
    await settle();

    expect(harness.frames).toContainEqual({
      type: "observation",
      observation: {
        kind: "injection-refused",
        injectionId: "inj-1",
        reason: "the session was disposed",
        at: 1_000,
      },
    });

    harness.session.promptFailure = null;
    harness.session.emit({ type: "turn_start" });
    await settle();

    expect(harness.frames).not.toContainEqual(
      expect.objectContaining({
        type: "observation",
        observation: expect.objectContaining({ kind: "injection-delivered" }),
      }),
    );

    harness.input.end();
    await harness.run;
  });

  it("streams the session's events as PlotRoom's observations", async () => {
    const harness = host();
    await settle();

    harness.session.emit({ type: "turn_start" });
    harness.session.emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "on it",
      },
    });
    await settle();

    expect(harness.frames.slice(1)).toEqual([
      {
        type: "observation",
        observation: { kind: "turn-started", turn: 1, at: 1_000 },
      },
      {
        type: "observation",
        observation: { kind: "output-delta", text: "on it", at: 1_000 },
      },
    ]);

    harness.input.end();
    await harness.run;
  });

  it("refuses an answer to a request nothing raised", async () => {
    // A silent success here would tell PlotRoom a blocked call had been
    // released when nothing was blocked — or blocked twice, for a second
    // `respond` naming an id the bridge already settled.
    const harness = host();
    harness.input.send({
      type: "respond",
      id: "c1",
      requestId: "req-1",
      outcome: { kind: "allow" },
    });
    await settle();

    expect(harness.frames).toContainEqual({
      type: "nack",
      id: "c1",
      error: "no request req-1 is pending in this session",
    });

    harness.input.end();
    await harness.run;
  });

  it("settles a request the gate or the ask tool raised, and acks (issue #81)", async () => {
    const harness = host();

    // Stands in for the permission gate's `bridge.raise` — the request-raised
    // frame it emits is the same fact whichever caller raised it.
    const answered = harness.requestBridge.raise({
      kind: "tool-permission",
      toolName: "bash",
      input: { command: "ls" },
    });

    const raisedFrame = harness.frames.find(
      (frame) =>
        frame.type === "observation" &&
        frame.observation.kind === "request-raised",
    );
    const rawRequestId =
      raisedFrame?.type === "observation" &&
      raisedFrame.observation.kind === "request-raised"
        ? raisedFrame.observation.requestId
        : undefined;
    expect(rawRequestId).toBeDefined();
    const requestId = rawRequestId as string;

    harness.input.send({
      type: "respond",
      id: "c1",
      requestId,
      outcome: { kind: "allow" },
    });
    await settle();

    expect(harness.frames).toContainEqual({ type: "ack", id: "c1" });
    expect(await answered).toEqual({ kind: "allow" });
    expect(harness.frames).toContainEqual({
      type: "observation",
      observation: {
        kind: "request-settled",
        requestId,
        outcome: { kind: "allow" },
        at: 1_000,
      },
    });

    // A second `respond` for the same id is now "nothing pending", not a
    // second success.
    harness.input.send({
      type: "respond",
      id: "c2",
      requestId,
      outcome: { kind: "allow" },
    });
    await settle();
    expect(harness.frames).toContainEqual({
      type: "nack",
      id: "c2",
      error: `no request ${requestId} is pending in this session`,
    });

    harness.input.end();
    await harness.run;
  });

  it("stops by winding the turn down, and leaves the session to its owner", async () => {
    const harness = host();
    harness.input.send({ type: "stop", id: "c1", mode: "graceful" });

    await harness.run;

    expect(harness.frames).toContainEqual({ type: "ack", id: "c1" });
    expect(harness.session.aborts).toBe(1);
    // Disposal is the process entry's, so the loop cannot dispose twice.
    expect(harness.session.subscribed).toBe(false);
  });

  it("ends when stdin does, because that is a PlotRoom that has gone", async () => {
    const harness = host();
    await settle();
    harness.input.end();

    await harness.run;

    expect(harness.session.aborts).toBe(0);
    expect(harness.session.subscribed).toBe(false);
  });

  it("reports an unreadable command instead of dropping it", async () => {
    const harness = host();
    harness.input.raw("{not json");
    await settle();

    expect(harness.frames.at(-1)).toEqual({
      type: "observation",
      observation: {
        kind: "runtime-error",
        message: "the session host could not read a command: {not json",
        fatal: false,
        at: 1_000,
      },
    });

    harness.input.end();
    await harness.run;
  });

  it("reports a failed turn as a non-fatal error and keeps the session", async () => {
    const harness = host();
    harness.session.promptFailure = new Error("provider refused the request");
    harness.input.send({ type: "prompt", id: "c1", text: "do the thing" });
    await settle();

    expect(harness.frames).toContainEqual({
      type: "observation",
      observation: {
        kind: "runtime-error",
        message: "provider refused the request",
        fatal: false,
        at: 1_000,
      },
    });

    // Still reading: a failed turn is not a session that ended.
    harness.session.promptFailure = null;
    harness.input.send({ type: "prompt", id: "c2", text: "try again" });
    await settle();
    expect(harness.frames).toContainEqual({ type: "ack", id: "c2" });

    harness.session.finishTurn();
    harness.input.end();
    await harness.run;
  });
});
