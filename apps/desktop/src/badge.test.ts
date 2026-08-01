import { describe, expect, it, vi } from "vitest";

import { applyBadgeCount, clampBadgeCount } from "./badge.js";

describe("clampBadgeCount", () => {
  it("passes a positive integer through", () => {
    expect(clampBadgeCount(5)).toBe(5);
  });

  it("never goes negative", () => {
    expect(clampBadgeCount(-3)).toBe(0);
  });

  it("truncates a fractional count", () => {
    expect(clampBadgeCount(2.9)).toBe(2);
  });
});

describe("applyBadgeCount", () => {
  it("calls setBadgeCount with the clamped count when supported", () => {
    const setBadgeCount = vi.fn(() => true);
    const result = applyBadgeCount({ setBadgeCount }, 7);
    expect(setBadgeCount).toHaveBeenCalledWith(7);
    expect(result).toEqual({ applied: true, count: 7 });
  });

  it("reports unapplied, without throwing, when the platform has no setBadgeCount", () => {
    const result = applyBadgeCount({}, 3);
    expect(result).toEqual({ applied: false, count: 3 });
  });

  it("clamps a negative count to zero before calling setBadgeCount", () => {
    const setBadgeCount = vi.fn(() => true);
    applyBadgeCount({ setBadgeCount }, -5);
    expect(setBadgeCount).toHaveBeenCalledWith(0);
  });
});
