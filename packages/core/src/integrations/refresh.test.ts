import { describe, expect, it } from "vitest";
import { describeRefreshMode, isIntervalRefreshDue } from "./refresh.js";
import type { IntegrationRefreshMode } from "./types.js";

describe("isIntervalRefreshDue", () => {
  it("is never due for on-demand — manual refresh is the only path", () => {
    const mode: IntegrationRefreshMode = { kind: "on-demand" };
    expect(isIntervalRefreshDue(mode, null, 1_000_000)).toBe(false);
    expect(isIntervalRefreshDue(mode, 0, 1_000_000)).toBe(false);
  });

  it("is never due for observed — the plugin pushes, nothing polls it", () => {
    const mode: IntegrationRefreshMode = { kind: "observed", what: "webhook" };
    expect(isIntervalRefreshDue(mode, null, 1_000_000)).toBe(false);
    expect(isIntervalRefreshDue(mode, 999_999, 1_000_000)).toBe(false);
  });

  it("is due immediately for interval when nothing has ever been read", () => {
    const mode: IntegrationRefreshMode = { kind: "interval", seconds: 60 };
    expect(isIntervalRefreshDue(mode, null, 0)).toBe(true);
  });

  it("is due only once the declared interval has elapsed", () => {
    const mode: IntegrationRefreshMode = { kind: "interval", seconds: 60 };
    expect(isIntervalRefreshDue(mode, 100, 130)).toBe(false);
    expect(isIntervalRefreshDue(mode, 100, 159)).toBe(false);
    expect(isIntervalRefreshDue(mode, 100, 160)).toBe(true);
    expect(isIntervalRefreshDue(mode, 100, 500)).toBe(true);
  });
});

describe("describeRefreshMode", () => {
  it("describes every mode without throwing", () => {
    expect(describeRefreshMode({ kind: "on-demand" })).toMatch(/manually/);
    expect(describeRefreshMode({ kind: "interval", seconds: 30 })).toContain(
      "30",
    );
    expect(describeRefreshMode({ kind: "observed", what: "a push" })).toContain(
      "a push",
    );
  });
});
