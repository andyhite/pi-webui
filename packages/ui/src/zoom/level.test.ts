import { describe, expect, it } from "vitest";

import { DEFAULT_ZOOM_THRESHOLDS, zoomLevelForScale } from "./level.js";

describe("zoomLevelForScale", () => {
  it("is workstream below the inner threshold", () => {
    expect(zoomLevelForScale(0)).toBe("workstream");
    expect(zoomLevelForScale(0.59)).toBe("workstream");
  });

  it("is inner at and above the inner threshold, below detail", () => {
    expect(zoomLevelForScale(DEFAULT_ZOOM_THRESHOLDS.inner)).toBe("inner");
    expect(zoomLevelForScale(0.9)).toBe("inner");
  });

  it("is detail at and above the detail threshold", () => {
    expect(zoomLevelForScale(DEFAULT_ZOOM_THRESHOLDS.detail)).toBe("detail");
    expect(zoomLevelForScale(3)).toBe("detail");
  });

  it("respects custom thresholds", () => {
    const thresholds = { inner: 1, detail: 2 };
    expect(zoomLevelForScale(0.9, thresholds)).toBe("workstream");
    expect(zoomLevelForScale(1, thresholds)).toBe("inner");
    expect(zoomLevelForScale(2, thresholds)).toBe("detail");
  });
});
