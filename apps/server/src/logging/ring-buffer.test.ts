import { describe, expect, it } from "vitest";
import { DEFAULT_LOG_BUFFER_CAPACITY, LogRingBuffer } from "./ring-buffer.js";

function entry(overrides: Partial<Parameters<LogRingBuffer["push"]>[0]> = {}) {
  return {
    time: "2024-01-01T00:00:00.000Z",
    level: "info" as const,
    msg: "something happened",
    fields: {},
    ...overrides,
  };
}

describe("LogRingBuffer (§8, Epic 8.3)", () => {
  it("assigns each entry a stable, increasing seq", () => {
    const buffer = new LogRingBuffer(10);
    const first = buffer.push(entry({ msg: "one" }));
    const second = buffer.push(entry({ msg: "two" }));

    expect(first.stored.seq).toBe(1);
    expect(second.stored.seq).toBe(2);
    expect(first.evicted).toBe(false);
    expect(second.evicted).toBe(false);
  });

  it("evicts the oldest entry once the bound is reached, and says so — never silently", () => {
    const buffer = new LogRingBuffer(2);
    buffer.push(entry({ msg: "one" }));
    buffer.push(entry({ msg: "two" }));
    const third = buffer.push(entry({ msg: "three" }));

    expect(third.evicted).toBe(true);
    const result = buffer.query();
    expect(result.entries.map((e) => e.msg)).toEqual(["two", "three"]);
    expect(result.droppedTotal).toBe(1);
    expect(result.capacity).toBe(2);
  });

  it("droppedTotal never resets: it is this process's whole history of drops", () => {
    const buffer = new LogRingBuffer(1);
    buffer.push(entry({ msg: "one" }));
    buffer.push(entry({ msg: "two" }));
    buffer.push(entry({ msg: "three" }));

    expect(buffer.query().droppedTotal).toBe(2);
  });

  it("filters by minimum level, never an exact match only", () => {
    const buffer = new LogRingBuffer(10);
    buffer.push(entry({ level: "debug", msg: "debug line" }));
    buffer.push(entry({ level: "warn", msg: "warn line" }));
    buffer.push(entry({ level: "error", msg: "error line" }));

    const result = buffer.query({ level: "warn" });
    expect(result.entries.map((e) => e.msg)).toEqual([
      "warn line",
      "error line",
    ]);
  });

  it("filters by component", () => {
    const buffer = new LogRingBuffer(10);
    buffer.push(entry({ component: "http", msg: "a request" }));
    buffer.push(entry({ component: "maintenance", msg: "a sweep" }));

    const result = buffer.query({ component: "maintenance" });
    expect(result.entries.map((e) => e.msg)).toEqual(["a sweep"]);
  });

  it("filters by sinceSeq, exclusive", () => {
    const buffer = new LogRingBuffer(10);
    const first = buffer.push(entry({ msg: "one" }));
    buffer.push(entry({ msg: "two" }));
    buffer.push(entry({ msg: "three" }));

    const result = buffer.query({ sinceSeq: first.stored.seq });
    expect(result.entries.map((e) => e.msg)).toEqual(["two", "three"]);
  });

  it("caps the result at limit, keeping the most recent — a tail, not page one", () => {
    const buffer = new LogRingBuffer(10);
    for (let i = 1; i <= 5; i += 1) buffer.push(entry({ msg: `line ${i}` }));

    const result = buffer.query({ limit: 2 });
    expect(result.entries.map((e) => e.msg)).toEqual(["line 4", "line 5"]);
  });

  it("reports oldest and newest seq, and null for an empty buffer", () => {
    const empty = new LogRingBuffer(10);
    expect(empty.query()).toMatchObject({ oldestSeq: null, newestSeq: null });

    const buffer = new LogRingBuffer(10);
    buffer.push(entry({ msg: "one" }));
    buffer.push(entry({ msg: "two" }));
    expect(buffer.query()).toMatchObject({ oldestSeq: 1, newestSeq: 2 });
  });

  it("refuses a non-positive capacity rather than silently being unbounded", () => {
    expect(() => new LogRingBuffer(0)).toThrow();
    expect(() => new LogRingBuffer(-1)).toThrow();
  });

  it("ships with a sane default capacity", () => {
    expect(DEFAULT_LOG_BUFFER_CAPACITY).toBeGreaterThan(0);
  });
});
