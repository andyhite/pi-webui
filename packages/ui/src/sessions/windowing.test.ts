import { describe, expect, it } from "vitest";

import {
  DEFAULT_TRANSCRIPT_WINDOW,
  TRANSCRIPT_WINDOW_STEP,
  computeTailWindow,
  growTranscriptWindow,
  hasEarlierTurns,
} from "./windowing.js";

describe("computeTailWindow", () => {
  it("renders everything when the transcript is within the window", () => {
    expect(computeTailWindow(5, 50)).toEqual({ start: 0, end: 5 });
  });

  it("renders only the newest windowSize turns for a long transcript", () => {
    expect(computeTailWindow(500, 50)).toEqual({ start: 450, end: 500 });
  });

  it("never produces a negative start", () => {
    expect(computeTailWindow(3, 0)).toEqual({ start: 3, end: 3 });
  });

  it("an empty transcript windows to an empty range", () => {
    expect(computeTailWindow(0, 50)).toEqual({ start: 0, end: 0 });
  });
});

describe("growTranscriptWindow", () => {
  it("grows by one step", () => {
    expect(growTranscriptWindow(50, 500)).toBe(50 + TRANSCRIPT_WINDOW_STEP);
  });

  it("never grows past the whole transcript", () => {
    expect(growTranscriptWindow(480, 500)).toBe(500);
    expect(growTranscriptWindow(500, 500)).toBe(500);
  });
});

describe("hasEarlierTurns", () => {
  it("is true when the window does not start at the beginning", () => {
    expect(
      hasEarlierTurns(computeTailWindow(500, DEFAULT_TRANSCRIPT_WINDOW)),
    ).toBe(true);
  });

  it("is false once the window covers everything", () => {
    expect(
      hasEarlierTurns(computeTailWindow(5, DEFAULT_TRANSCRIPT_WINDOW)),
    ).toBe(false);
  });
});
