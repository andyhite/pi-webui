import { describe, expect, it, vi } from "vitest";

import {
  createArrangementWriteQueue,
  type ArrangementWriteResult,
  type ArrangementWriter,
} from "./write-queue.js";

function fakeTimers() {
  const timers = new Map<number, () => void>();
  let nextId = 1;
  const setTimeoutFake = ((callback: () => void, _delayMs: number) => {
    const id = nextId++;
    timers.set(id, callback);
    return id as unknown as ReturnType<typeof globalThis.setTimeout>;
  }) as typeof globalThis.setTimeout;
  const clearTimeoutFake = ((id: unknown) => {
    timers.delete(id as number);
  }) as typeof globalThis.clearTimeout;
  return {
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    fireAll(): void {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
    },
    pendingCount(): number {
      return timers.size;
    },
  };
}

const ok: ArrangementWriteResult = { ok: true };

function writer(overrides: Partial<ArrangementWriter> = {}): ArrangementWriter {
  return {
    setNodePosition: vi.fn().mockResolvedValue(ok),
    setArrangement: vi.fn().mockResolvedValue(ok),
    ...overrides,
  };
}

describe("createArrangementWriteQueue", () => {
  it("sends a single-node delta through setNodePosition after the debounce window", async () => {
    const timers = fakeTimers();
    const w = writer();
    const queue = createArrangementWriteQueue(w, {
      onFailure: () => {},
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    queue.enqueue({ a: { x: 1, y: 2 } });
    expect(w.setNodePosition).not.toHaveBeenCalled();
    timers.fireAll();
    await Promise.resolve();

    expect(w.setNodePosition).toHaveBeenCalledWith("a", { x: 1, y: 2 });
    expect(w.setArrangement).not.toHaveBeenCalled();
  });

  it("sends a multi-node delta through setArrangement, batched", async () => {
    const timers = fakeTimers();
    const w = writer();
    const queue = createArrangementWriteQueue(w, {
      onFailure: () => {},
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    queue.enqueue({ a: { x: 1, y: 1 }, b: { x: 2, y: 2 } });
    timers.fireAll();
    await Promise.resolve();

    expect(w.setArrangement).toHaveBeenCalledTimes(1);
    const [entries] = (w.setArrangement as ReturnType<typeof vi.fn>).mock
      .calls[0] as [readonly { nodeId: string; position: unknown }[]];
    expect(new Set(entries.map((e) => e.nodeId))).toEqual(new Set(["a", "b"]));
  });

  it("coalesces two rapid enqueues into one write carrying the latest value", async () => {
    const timers = fakeTimers();
    const w = writer();
    const queue = createArrangementWriteQueue(w, {
      onFailure: () => {},
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    queue.enqueue({ a: { x: 1, y: 1 } });
    queue.enqueue({ a: { x: 2, y: 2 } });
    expect(timers.pendingCount()).toBe(1); // the second enqueue reset the timer, not added one
    timers.fireAll();
    await Promise.resolve();

    expect(w.setNodePosition).toHaveBeenCalledTimes(1);
    expect(w.setNodePosition).toHaveBeenCalledWith("a", { x: 2, y: 2 });
  });

  it("never drops the final state: a later enqueue's value wins even if it arrived for a different id", async () => {
    const timers = fakeTimers();
    const w = writer();
    const queue = createArrangementWriteQueue(w, {
      onFailure: () => {},
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    queue.enqueue({ a: { x: 1, y: 1 } });
    queue.enqueue({ b: { x: 2, y: 2 } });
    timers.fireAll();
    await Promise.resolve();

    expect(w.setArrangement).toHaveBeenCalledTimes(1);
    const [entries] = (w.setArrangement as ReturnType<typeof vi.fn>).mock
      .calls[0] as [readonly { nodeId: string; position: unknown }[]];
    expect(new Set(entries.map((e) => e.nodeId))).toEqual(new Set(["a", "b"]));
  });

  it("surfaces a refusal through onFailure rather than swallowing it", async () => {
    const timers = fakeTimers();
    const refusal = { reason: "would_cycle", message: "no" };
    const w = writer({
      setNodePosition: vi.fn().mockResolvedValue({
        ok: false,
        refusal,
      } satisfies ArrangementWriteResult),
    });
    const onFailure = vi.fn();
    const queue = createArrangementWriteQueue(w, {
      onFailure,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    queue.enqueue({ a: { x: 1, y: 1 } });
    timers.fireAll();
    await Promise.resolve();

    expect(onFailure).toHaveBeenCalledWith(
      { ok: false, refusal },
      { a: { x: 1, y: 1 } },
    );
  });

  it("flush() sends immediately, bypassing the debounce window", async () => {
    const timers = fakeTimers();
    const w = writer();
    const queue = createArrangementWriteQueue(w, {
      onFailure: () => {},
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    queue.enqueue({ a: { x: 1, y: 1 } });
    await queue.flush();

    expect(w.setNodePosition).toHaveBeenCalledTimes(1);
    expect(timers.pendingCount()).toBe(0);
  });

  it("flush() with nothing pending is a no-op", async () => {
    const timers = fakeTimers();
    const w = writer();
    const queue = createArrangementWriteQueue(w, {
      onFailure: () => {},
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    await queue.flush();

    expect(w.setNodePosition).not.toHaveBeenCalled();
    expect(w.setArrangement).not.toHaveBeenCalled();
  });
});
