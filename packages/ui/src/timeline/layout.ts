/**
 * The Timeline panel's layout math (§8, §11): "a temporal view of turns and
 * tool calls ... including for finished sessions." Pure: given the exact
 * observation log `GET /api/sessions/:id/observations` already returns
 * (`@plotroom/core`'s `RuntimeObservation`, decision 0001 — PlotRoom's own
 * record, never a vendor payload), produce time-proportional segments a
 * panel can lay out left-to-right without knowing anything about wall-clock
 * time itself.
 *
 * Two segment kinds, matched by their own start/end observation pair:
 * `turn-started`/`turn-ended` (keyed by turn number) and
 * `tool-started`/`tool-finished` (keyed by `callId`). An unterminated span
 * (a tool call still running when the log was read) reports `endAt: null`
 * and a zero-width fraction rather than guessing an end — the same honesty
 * rule every other "we don't actually know" case in this codebase follows
 * (principle 7).
 */

import type { RuntimeObservation } from "@plotroom/core";

export type TimelineSegmentKind = "turn" | "tool-call";

export interface TimelineSegment {
  readonly kind: TimelineSegmentKind;
  readonly id: string;
  readonly label: string;
  readonly startAt: number;
  readonly endAt: number | null;
  /** 0..1 within the whole layout's [startAt, endAt] span. */
  readonly startFraction: number;
  /** Equals `startFraction` when `endAt` is null \u2014 a point, not a bar. */
  readonly endFraction: number;
  readonly isError: boolean;
}

export interface TimelineLayout {
  readonly startAt: number;
  readonly endAt: number;
  readonly segments: readonly TimelineSegment[];
}

const EMPTY_LAYOUT: TimelineLayout = { startAt: 0, endAt: 0, segments: [] };

function fractionOf(at: number, startAt: number, span: number): number {
  return span === 0 ? 0 : (at - startAt) / span;
}

export function buildTimelineLayout(
  observations: readonly RuntimeObservation[],
): TimelineLayout {
  if (observations.length === 0) return EMPTY_LAYOUT;

  const sorted = [...observations].sort((a, b) => a.at - b.at);
  const startAt = sorted[0]?.at ?? 0;
  const endAt = sorted.at(-1)?.at ?? startAt;
  const span = Math.max(0, endAt - startAt);

  interface Open {
    readonly kind: TimelineSegmentKind;
    readonly id: string;
    readonly label: string;
    readonly startAt: number;
  }

  const openTurns = new Map<number, Open>();
  const openTools = new Map<string, Open>();
  const segments: TimelineSegment[] = [];

  function close(open: Open, at: number | null, isError: boolean): void {
    segments.push({
      kind: open.kind,
      id: open.id,
      label: open.label,
      startAt: open.startAt,
      endAt: at,
      startFraction: fractionOf(open.startAt, startAt, span),
      endFraction:
        at === null
          ? fractionOf(open.startAt, startAt, span)
          : fractionOf(at, startAt, span),
      isError,
    });
  }

  for (const observation of sorted) {
    switch (observation.kind) {
      case "turn-started":
        openTurns.set(observation.turn, {
          kind: "turn",
          id: String(observation.turn),
          label: `turn ${observation.turn}`,
          startAt: observation.at,
        });
        break;
      case "turn-ended": {
        const open = openTurns.get(observation.turn);
        openTurns.delete(observation.turn);
        if (open) close(open, observation.at, false);
        break;
      }
      case "tool-started":
        openTools.set(observation.callId, {
          kind: "tool-call",
          id: observation.callId,
          label: observation.toolName,
          startAt: observation.at,
        });
        break;
      case "tool-finished": {
        const open = openTools.get(observation.callId);
        openTools.delete(observation.callId);
        if (open) close(open, observation.at, observation.isError);
        break;
      }
      default:
        break;
    }
  }

  // Whatever never closed (still running when the log was read) is honestly
  // reported as an unterminated point rather than silently dropped.
  for (const open of openTurns.values()) close(open, null, false);
  for (const open of openTools.values()) close(open, null, false);

  segments.sort((a, b) => a.startAt - b.startAt);

  return { startAt, endAt, segments };
}
