import { describe, expect, it } from "vitest";

import { focusTrapNext } from "./focus-trap.js";

describe("focusTrapNext", () => {
  it("returns null for an empty list", () => {
    expect(focusTrapNext([], null, "forward")).toBeNull();
    expect(focusTrapNext([], null, "backward")).toBeNull();
  });

  it("traps a single element to itself in both directions", () => {
    const only = { id: "only" };
    expect(focusTrapNext([only], only, "forward")).toBe(only);
    expect(focusTrapNext([only], only, "backward")).toBe(only);
  });

  it("wraps Tab from the last element to the first", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const c = { id: "c" };
    expect(focusTrapNext([a, b, c], c, "forward")).toBe(a);
  });

  it("wraps Shift+Tab from the first element to the last", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const c = { id: "c" };
    expect(focusTrapNext([a, b, c], a, "backward")).toBe(c);
  });

  it("steps forward and backward without wrapping in the middle", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const c = { id: "c" };
    expect(focusTrapNext([a, b, c], a, "forward")).toBe(b);
    expect(focusTrapNext([a, b, c], b, "backward")).toBe(a);
  });

  it("starts at the ends when the current focus is outside the list", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const outsider = { id: "out" };
    expect(focusTrapNext([a, b], outsider, "forward")).toBe(a);
    expect(focusTrapNext([a, b], outsider, "backward")).toBe(b);
  });
});
