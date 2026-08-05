import { describe, expect, it } from "vitest";

import {
  nextRovingIndex,
  nextRovingIndexSkippingDisabled,
  type RovingKey,
} from "./roving-tabindex.js";

describe("nextRovingIndex", () => {
  describe("vertical", () => {
    const orientation = "vertical" as const;

    it("wraps ArrowDown from last to first", () => {
      expect(nextRovingIndex(2, 3, "ArrowDown", orientation)).toBe(0);
    });

    it("wraps ArrowUp from first to last", () => {
      expect(nextRovingIndex(0, 3, "ArrowUp", orientation)).toBe(2);
    });

    it("steps ArrowDown without wrapping in the middle", () => {
      expect(nextRovingIndex(0, 3, "ArrowDown", orientation)).toBe(1);
    });

    it("steps ArrowUp without wrapping in the middle", () => {
      expect(nextRovingIndex(2, 3, "ArrowUp", orientation)).toBe(1);
    });

    it("ignores horizontal arrow keys", () => {
      expect(nextRovingIndex(1, 3, "ArrowLeft", orientation)).toBe(1);
      expect(nextRovingIndex(1, 3, "ArrowRight", orientation)).toBe(1);
    });

    it("jumps Home and End", () => {
      expect(nextRovingIndex(2, 5, "Home", orientation)).toBe(0);
      expect(nextRovingIndex(1, 5, "End", orientation)).toBe(4);
    });
  });

  describe("horizontal", () => {
    const orientation = "horizontal" as const;

    it("wraps ArrowRight from last to first", () => {
      expect(nextRovingIndex(2, 3, "ArrowRight", orientation)).toBe(0);
    });

    it("wraps ArrowLeft from first to last", () => {
      expect(nextRovingIndex(0, 3, "ArrowLeft", orientation)).toBe(2);
    });

    it("ignores vertical arrow keys", () => {
      expect(nextRovingIndex(1, 3, "ArrowUp", orientation)).toBe(1);
      expect(nextRovingIndex(1, 3, "ArrowDown", orientation)).toBe(1);
    });

    it("jumps Home and End", () => {
      expect(nextRovingIndex(3, 4, "Home", orientation)).toBe(0);
      expect(nextRovingIndex(0, 4, "End", orientation)).toBe(3);
    });
  });

  describe("edge cases", () => {
    it("keeps index 0 for a single-item list", () => {
      const keys: RovingKey[] = [
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
      ];
      for (const key of keys) {
        expect(nextRovingIndex(0, 1, key, "vertical")).toBe(0);
        expect(nextRovingIndex(0, 1, key, "horizontal")).toBe(0);
      }
    });

    it("returns 0 for an empty list", () => {
      expect(nextRovingIndex(0, 0, "ArrowDown", "vertical")).toBe(0);
    });
  });
});

describe("nextRovingIndexSkippingDisabled", () => {
  const orientation = "vertical" as const;

  it("skips a disabled middle item when moving down", () => {
    const disabled = [false, true, false];
    expect(
      nextRovingIndexSkippingDisabled(0, disabled, "ArrowDown", orientation),
    ).toBe(2);
  });

  it("skips a disabled middle item when moving up", () => {
    const disabled = [false, true, false];
    expect(
      nextRovingIndexSkippingDisabled(2, disabled, "ArrowUp", orientation),
    ).toBe(0);
  });

  it("Home lands on the first enabled item", () => {
    const disabled = [true, false, false];
    expect(
      nextRovingIndexSkippingDisabled(2, disabled, "Home", orientation),
    ).toBe(1);
  });

  it("End lands on the last enabled item", () => {
    const disabled = [false, false, true];
    expect(
      nextRovingIndexSkippingDisabled(0, disabled, "End", orientation),
    ).toBe(1);
  });

  it("wraps across disabled items at the boundary", () => {
    const disabled = [true, false, true];
    expect(
      nextRovingIndexSkippingDisabled(1, disabled, "ArrowDown", orientation),
    ).toBe(1);
  });
});
