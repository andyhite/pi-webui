import { describe, expect, it } from "vitest";

import { beginRun, endRun } from "./run-guard.js";

describe("beginRun", () => {
  it("allows the first run for a command node and marks it in flight", () => {
    const result = beginRun(new Set(), "cmd-1");
    expect(result.allowed).toBe(true);
    expect(result.inFlight).toEqual(new Set(["cmd-1"]));
  });

  it("refuses a second begin for a node already in flight — the double-click case", () => {
    const first = beginRun(new Set(), "cmd-1");
    const second = beginRun(first.inFlight, "cmd-1");
    expect(second.allowed).toBe(false);
    // Unchanged: a refused begin never mints a second key.
    expect(second.inFlight).toBe(first.inFlight);
  });

  it("allows a different command node concurrently", () => {
    const first = beginRun(new Set(), "cmd-1");
    const second = beginRun(first.inFlight, "cmd-2");
    expect(second.allowed).toBe(true);
    expect(second.inFlight).toEqual(new Set(["cmd-1", "cmd-2"]));
  });

  it("does not mutate the set it was given", () => {
    const original = new Set(["cmd-1"]);
    beginRun(original, "cmd-2");
    expect(original).toEqual(new Set(["cmd-1"]));
  });
});

describe("endRun", () => {
  it("clears the in-flight mark", () => {
    const { inFlight } = beginRun(new Set(), "cmd-1");
    expect(endRun(inFlight, "cmd-1")).toEqual(new Set());
  });

  it("is a no-op (same reference) for a node not in flight", () => {
    const inFlight = new Set(["cmd-1"]);
    expect(endRun(inFlight, "cmd-missing")).toBe(inFlight);
  });

  it("only clears the named node, leaving others in flight", () => {
    let inFlight = beginRun(new Set(), "cmd-1").inFlight;
    inFlight = beginRun(inFlight, "cmd-2").inFlight;
    inFlight = endRun(inFlight, "cmd-1");
    expect(inFlight).toEqual(new Set(["cmd-2"]));
  });

  it("supports the exact begin -> refuse -> end -> begin-again round trip", () => {
    // This is the double-click scenario as a pure sequence: a second begin
    // while in flight is refused, ending it frees the node for a later,
    // genuinely new run.
    let inFlight: ReadonlySet<string> = new Set<string>();
    const first = beginRun(inFlight, "cmd-1");
    expect(first.allowed).toBe(true);
    inFlight = first.inFlight;

    const doubleClick = beginRun(inFlight, "cmd-1");
    expect(doubleClick.allowed).toBe(false);

    inFlight = endRun(inFlight, "cmd-1");
    const retry = beginRun(inFlight, "cmd-1");
    expect(retry.allowed).toBe(true);
  });
});
