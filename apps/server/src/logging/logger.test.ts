import { expect } from "vitest";
import { describe, it } from "bun:test";
import { Logger, redact } from "./logger.js";

function collect() {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

describe("Logger (spec §8)", () => {
  it("emits one consistent JSON shape: time, level, msg, plus fields", () => {
    const { lines, sink } = collect();
    const logger = new Logger("info", sink, () => "2024-01-01T00:00:00.000Z");

    logger.info("server started", { port: 4600 });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      time: "2024-01-01T00:00:00.000Z",
      level: "info",
      msg: "server started",
      port: 4600,
    });
  });

  it("adjusts level at runtime via setLevel, no restart", () => {
    const { lines, sink } = collect();
    const logger = new Logger("warn", sink);

    logger.info("suppressed below warn");
    expect(lines).toHaveLength(0);

    logger.setLevel("info");
    logger.info("now visible");
    expect(lines).toHaveLength(1);
  });

  it("redacts sensitive keys, however deeply nested", () => {
    const { lines, sink } = collect();
    const logger = new Logger("debug", sink);

    logger.debug("auth attempt", {
      credential: "s3cret",
      nested: { password: "hunter2", ok: true },
      list: [{ token: "abc" }],
    });

    const entry = JSON.parse(lines[0]!);
    expect(entry.credential).toBe("[redacted]");
    expect(entry.nested.password).toBe("[redacted]");
    expect(entry.nested.ok).toBe(true);
    expect(entry.list[0].token).toBe("[redacted]");
  });

  it("redact() leaves non-sensitive values untouched", () => {
    expect(redact({ a: 1, b: "x" })).toEqual({ a: 1, b: "x" });
  });

  it("child() tags every line with a component, sharing the same level (Epic 8.3)", () => {
    const { lines, sink } = collect();
    const logger = new Logger("warn", sink, () => "2024-01-01T00:00:00.000Z");
    const component = logger.child("maintenance");

    component.info("suppressed below warn");
    expect(lines).toHaveLength(0);

    component.warn("a sweep ran", { removed: 3 });
    expect(JSON.parse(lines[0]!)).toEqual({
      time: "2024-01-01T00:00:00.000Z",
      level: "warn",
      msg: "a sweep ran",
      component: "maintenance",
      removed: 3,
    });

    // The level is the parent's, not a second one to drift from it.
    logger.setLevel("info");
    component.info("now visible too");
    expect(lines).toHaveLength(2);
  });
});
