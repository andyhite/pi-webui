/**
 * Bounded transcript rendering (spec §6.1 mechanics, Epic 5.1 finish): a
 * long-running session's transcript already stays within a *byte* budget
 * via tool-output release (`@plotroom/core`'s `planRelease`); this is the
 * separate, DOM-side bound — a thousand-turn session must not force a
 * thousand-node render. Pure and simple on purpose: a tail window (the
 * newest N turns), grown backward one step at a time on request, is enough
 * for perf sanity without pretending to be a scroll-linked virtualizer.
 */

export interface TurnWindow {
  /** Inclusive start index into the turns array. */
  readonly start: number;
  /** Exclusive end index — always the transcript's current length (a live tail). */
  readonly end: number;
}

export const DEFAULT_TRANSCRIPT_WINDOW = 50;
export const TRANSCRIPT_WINDOW_STEP = 50;

/** The newest `windowSize` turns, clamped to what actually exists. */
export function computeTailWindow(
  totalTurns: number,
  windowSize: number,
): TurnWindow {
  const end = Math.max(0, totalTurns);
  const clampedWindow = Math.max(0, windowSize);
  const start = Math.max(0, end - clampedWindow);
  return { start, end };
}

/** "load earlier turns" (mechanics only): grow the window one step, never past the whole transcript. */
export function growTranscriptWindow(
  windowSize: number,
  totalTurns: number,
): number {
  return Math.min(windowSize + TRANSCRIPT_WINDOW_STEP, Math.max(totalTurns, 0));
}

/** Whether there is anything left for "load earlier turns" to reveal. */
export function hasEarlierTurns(window: TurnWindow): boolean {
  return window.start > 0;
}
