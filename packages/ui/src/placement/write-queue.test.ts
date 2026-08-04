import { describe, expect, it, vi } from "vitest";

import {
  createArrangementWriteQueue,
  type ArrangementWriteResult,
  type ArrangementWriter,
} from "./write-queue.js";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

  it("routes a *thrown* write through onFailure rather than losing the batch to an unhandled rejection", async () => {
    const timers = fakeTimers();
    const w = writer({
      setNodePosition: vi.fn().mockRejectedValue(new Error("network down")),
    });
    const onFailure = vi.fn();
    const queue = createArrangementWriteQueue(w, {
      onFailure,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    queue.enqueue({ a: { x: 1, y: 1 } });
    // flush() itself must resolve, never reject: the debounce timer's own
    // `void flush()` would otherwise be an unhandled rejection and
    // `onFailure` would never run at all — the exact loss this is guarding
    // against.
    await expect(queue.flush()).resolves.toBeUndefined();

    expect(onFailure).toHaveBeenCalledTimes(1);
    const [result, batch] = onFailure.mock.calls[0] as [
      ArrangementWriteResult,
      Record<string, unknown>,
    ];
    expect(result.ok).toBe(false);
    expect(result.refusal?.message).toContain("network down");
    expect(batch).toEqual({ a: { x: 1, y: 1 } });
  });

  it("re-merges a failed batch as retry material, resent on the next flush", async () => {
    const timers = fakeTimers();
    const setNodePosition = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(ok);
    const w = writer({ setNodePosition });
    const queue = createArrangementWriteQueue(w, {
      onFailure: () => {},
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    queue.enqueue({ a: { x: 1, y: 1 } });
    await queue.flush(); // fails; { a: { x: 1, y: 1 } } goes back into pending

    await queue.flush(); // retried
    expect(setNodePosition).toHaveBeenCalledTimes(2);
    expect(setNodePosition).toHaveBeenNthCalledWith(2, "a", { x: 1, y: 1 });
  });

  it("a value enqueued while a failing write is still in flight wins over the retried stale one", async () => {
    const timers = fakeTimers();
    const first = deferred<ArrangementWriteResult>();
    const setNodePosition = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(ok);
    const w = writer({ setNodePosition });
    const queue = createArrangementWriteQueue(w, {
      onFailure: () => {},
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    queue.enqueue({ a: { x: 1, y: 1 } });
    const flushing = queue.flush(); // in flight, awaiting `first`

    // A newer drag settles before the in-flight write's failure surfaces.
    queue.enqueue({ a: { x: 9, y: 9 } });
    first.reject(new Error("network down"));
    await flushing;

    await queue.flush(); // retry
    expect(setNodePosition).toHaveBeenLastCalledWith("a", { x: 9, y: 9 });
  });

  it("flush({ keepalive: true }) passes the option through to a single-node write", async () => {
    const timers = fakeTimers();
    const w = writer();
    const queue = createArrangementWriteQueue(w, {
      onFailure: () => {},
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    queue.enqueue({ a: { x: 1, y: 1 } });
    await queue.flush({ keepalive: true });

    expect(w.setNodePosition).toHaveBeenCalledWith(
      "a",
      { x: 1, y: 1 },
      { keepalive: true },
    );
  });

  it("flush({ keepalive: true }) passes the option through to a batched write", async () => {
    const timers = fakeTimers();
    const w = writer();
    const queue = createArrangementWriteQueue(w, {
      onFailure: () => {},
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    queue.enqueue({ a: { x: 1, y: 1 }, b: { x: 2, y: 2 } });
    await queue.flush({ keepalive: true });

    expect(w.setArrangement).toHaveBeenCalledTimes(1);
    const call = (w.setArrangement as ReturnType<typeof vi.fn>).mock
      .calls[0] as [readonly unknown[], { keepalive: boolean } | undefined];
    expect(call[1]).toEqual({ keepalive: true });
  });

  it("the ordinary debounced flush never passes keepalive (or any options argument at all)", async () => {
    const timers = fakeTimers();
    const w = writer();
    const queue = createArrangementWriteQueue(w, {
      onFailure: () => {},
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    queue.enqueue({ a: { x: 1, y: 1 } });
    timers.fireAll();
    await Promise.resolve();

    // Not `toHaveBeenCalledWith("a", { x: 1, y: 1 }, undefined)` on purpose:
    // an explicit `undefined` third argument is a different call shape from
    // no third argument at all, and this must be the latter — the everyday
    // write is unaffected by the option's existence.
    expect(
      (w.setNodePosition as ReturnType<typeof vi.fn>).mock.calls[0],
    ).toHaveLength(2);
  });

  it("a caller-triggered flush() with no options also omits the third argument", async () => {
    const timers = fakeTimers();
    const w = writer();
    const queue = createArrangementWriteQueue(w, {
      onFailure: () => {},
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    queue.enqueue({ a: { x: 1, y: 1 } });
    await queue.flush();

    expect(
      (w.setNodePosition as ReturnType<typeof vi.fn>).mock.calls[0],
    ).toHaveLength(2);
  });
});
