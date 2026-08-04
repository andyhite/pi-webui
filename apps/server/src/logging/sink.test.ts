import { describe, expect, it } from "vitest";
import { Logger } from "./logger.js";
import { LogRingBuffer } from "./ring-buffer.js";
import { createBufferedSink } from "./sink.js";

describe("createBufferedSink (§8, Epic 8.3)", () => {
  it("writes every line through unchanged, and feeds the ring buffer too", () => {
    const written: string[] = [];
    const logs = new LogRingBuffer(10);
    const logger = new Logger(
      "info",
      createBufferedSink({
        logs,
        onFirstDrop: () => {},
        write: (line) => written.push(line),
      }),
      () => "2024-01-01T00:00:00.000Z",
    );

    logger.info("hello", { component: "http", path: "/api/x" });

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!)).toMatchObject({ msg: "hello" });

    const result = logs.query();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      msg: "hello",
      component: "http",
      fields: { path: "/api/x" },
    });
  });

  it("reports the drop notice exactly once — never per line after the bound is reached", () => {
    const logs = new LogRingBuffer(2);
    const notices: { droppedCount: number; sinceSeq: number }[] = [];
    const logger = new Logger(
      "info",
      createBufferedSink({
        logs,
        onFirstDrop: (n) => notices.push(n),
        write: () => {},
      }),
      () => "2024-01-01T00:00:00.000Z",
    );

    logger.info("one");
    logger.info("two");
    expect(notices).toHaveLength(0);

    logger.info("three"); // first eviction
    expect(notices).toHaveLength(1);
    expect(notices[0]).toEqual({ droppedCount: 1, sinceSeq: 2 });

    logger.info("four"); // second eviction — no new notice
    logger.info("five");
    expect(notices).toHaveLength(1);
    expect(logs.query().droppedTotal).toBe(3);
  });
});
