import { describe, expect, it } from "vitest";

import { applyLifecycleEvent } from "./types.js";

describe("applyLifecycleEvent", () => {
  it("loading carries no reason", () => {
    expect(applyLifecycleEvent({ type: "loading" })).toEqual({
      status: "loading",
      reason: null,
    });
  });

  it("ready carries no reason", () => {
    expect(applyLifecycleEvent({ type: "ready" })).toEqual({
      status: "ready",
      reason: null,
    });
  });

  it("unavailable is reported, never silent (§10.2)", () => {
    expect(
      applyLifecycleEvent({ type: "unavailable", reason: "plugin threw" }),
    ).toEqual({ status: "unavailable", reason: "plugin threw" });
  });

  it("disabled is the user-facing verb's own state, also reported", () => {
    expect(
      applyLifecycleEvent({ type: "disabled", reason: "disabled by operator" }),
    ).toEqual({ status: "disabled", reason: "disabled by operator" });
  });

  it("a sequence of events folds to the latest one, independent of prior state", () => {
    const sequence = [
      { type: "loading" as const },
      { type: "ready" as const },
      { type: "unavailable" as const, reason: "crashed" },
      { type: "disabled" as const, reason: "operator disabled it" },
    ];
    const final = sequence.reduce(
      (_current, event) => applyLifecycleEvent(event),
      applyLifecycleEvent({ type: "loading" }),
    );
    expect(final).toEqual({
      status: "disabled",
      reason: "operator disabled it",
    });
  });
});
