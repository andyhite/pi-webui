import { describe, expect, it } from "vitest";

import { nextTrappedIndex } from "./focus-trap.js";

describe("nextTrappedIndex", () => {
  it("moves focus inside on the first Tab, from either direction", () => {
    expect(nextTrappedIndex(3, -1, "forward")).toBe(0);
    expect(nextTrappedIndex(3, -1, "backward")).toBe(2);
  });

  it("cycles rather than clamping — a dialog Tab must never reach the page behind it", () => {
    expect(nextTrappedIndex(3, 2, "forward")).toBe(0);
    expect(nextTrappedIndex(3, 0, "backward")).toBe(2);
  });

  it("steps one at a time in between", () => {
    expect(nextTrappedIndex(3, 0, "forward")).toBe(1);
    expect(nextTrappedIndex(3, 2, "backward")).toBe(1);
  });

  it("returns null when there is nothing focusable, so the caller leaves the event alone", () => {
    expect(nextTrappedIndex(0, -1, "forward")).toBeNull();
  });
});
