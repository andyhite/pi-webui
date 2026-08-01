/**
 * The session timeline (spec §8, §11): "where the time and money went, as a
 * temporal view of turns and tool calls — including for finished sessions, so it
 * is the post-mortem for something that failed overnight."
 *
 * Projected from the observation log, like the transcript and every phase: there
 * is one record of what a session did, and this is a second *read* of it rather
 * than a second record (principle 7). That is what makes it work for a finished
 * session at all — nothing is asked of a runtime that is gone.
 *
 * Time is milliseconds here, matching the observation vocabulary. A turn or a
 * call that never ended has `endedAt: null` and `elapsedMillis: null` — a session
 * caught mid-turn by a crash is honest about it rather than being closed at the
 * moment somebody happened to read it (principle 11).
 */

import type { RuntimeObservation, TurnUsage } from "./sessions/runtime.js";

export interface TimelineTurn {
  readonly kind: "turn";
  readonly ordinal: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly elapsedMillis: number | null;
  /** What this turn consumed, as the runtime reported it. Null until it ended. */
  readonly usage: TurnUsage | null;
  /** Reported by the runtime, or null: a turn that priced nothing prices nothing. */
  readonly costUsd: number | null;
  readonly toolCalls: readonly TimelineToolCall[];
}

export interface TimelineToolCall {
  readonly kind: "tool-call";
  readonly callId: string;
  readonly toolName: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly elapsedMillis: number | null;
  /** Null while the call is still running. */
  readonly failed: boolean | null;
}

export interface SessionTimeline {
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly turns: readonly TimelineTurn[];
  /** Every call, flat and in order, for a surface that wants the tool view. */
  readonly toolCalls: readonly TimelineToolCall[];
  /** Wall-clock milliseconds inside a turn, which is where time was spent. */
  readonly busyMillis: number;
  /** Wall-clock milliseconds between turns — waiting, or nothing happening. */
  readonly idleMillis: number;
  readonly costUsd: number | null;
}

/**
 * Fold the log into turns with their tool calls.
 *
 * A tool call is attached to the turn that was open when it started, because that
 * is what "where the time went" means: a fifty-second call inside turn 3 is turn
 * 3's cost. A call observed with no turn open is attached to nothing and appears
 * in `toolCalls` only — observed exactly as it happened rather than assigned to a
 * turn that was not running.
 */
export function sessionTimeline(
  observations: readonly RuntimeObservation[],
): SessionTimeline {
  const turns: TimelineTurn[] = [];
  const calls: TimelineToolCall[] = [];
  const openCalls = new Map<string, TimelineToolCall>();
  let startedAt: number | null = null;
  let endedAt: number | null = null;

  const currentTurn = (): TimelineTurn | undefined => turns.at(-1);

  for (const observation of observations) {
    startedAt ??= observation.at;

    switch (observation.kind) {
      case "turn-started":
        turns.push({
          kind: "turn",
          ordinal: observation.turn,
          startedAt: observation.at,
          endedAt: null,
          elapsedMillis: null,
          usage: null,
          costUsd: null,
          toolCalls: [],
        });
        break;

      case "turn-ended": {
        const turn = turns.find(
          (one) => one.ordinal === observation.turn && one.endedAt === null,
        );
        if (turn === undefined) break;
        replace(turns, turn, {
          ...turn,
          endedAt: observation.at,
          elapsedMillis: observation.at - turn.startedAt,
          usage: observation.usage,
          costUsd: observation.usage.costUsd ?? null,
        });
        break;
      }

      case "tool-started": {
        const call: TimelineToolCall = {
          kind: "tool-call",
          callId: observation.callId,
          toolName: observation.toolName,
          startedAt: observation.at,
          endedAt: null,
          elapsedMillis: null,
          failed: null,
        };
        openCalls.set(observation.callId, call);
        calls.push(call);
        const turn = currentTurn();
        if (turn !== undefined) {
          replace(turns, turn, {
            ...turn,
            toolCalls: [...turn.toolCalls, call],
          });
        }
        break;
      }

      case "tool-finished": {
        const open = openCalls.get(observation.callId);
        if (open === undefined) break;
        openCalls.delete(observation.callId);
        const settled: TimelineToolCall = {
          ...open,
          endedAt: observation.at,
          elapsedMillis: observation.at - open.startedAt,
          failed: observation.isError,
        };
        replace(calls, open, settled);
        for (const turn of turns) {
          if (!turn.toolCalls.includes(open)) continue;
          replace(turns, turn, {
            ...turn,
            toolCalls: turn.toolCalls.map((one) =>
              one === open ? settled : one,
            ),
          });
        }
        break;
      }

      case "session-ended":
        endedAt = observation.at;
        break;

      default:
        break;
    }
  }

  return {
    startedAt,
    endedAt,
    turns,
    toolCalls: calls,
    busyMillis: turns.reduce(
      (total, turn) => total + (turn.elapsedMillis ?? 0),
      0,
    ),
    idleMillis: idleBetween(turns),
    costUsd: totalCost(turns),
  };
}

function replace<T>(list: T[], from: T, to: T): void {
  const index = list.indexOf(from);
  if (index >= 0) list[index] = to;
}

function idleBetween(turns: readonly TimelineTurn[]): number {
  let idle = 0;
  for (let index = 1; index < turns.length; index += 1) {
    const previous = turns[index - 1] as TimelineTurn;
    const next = turns[index] as TimelineTurn;
    if (previous.endedAt === null) continue;
    idle += Math.max(0, next.startedAt - previous.endedAt);
  }
  return idle;
}

/**
 * Null when no turn reported a cost — the same rule the estimate keeps: "a run
 * whose runtime reported no cost contributes no evidence about money" (§4.1). A
 * zero would read as free.
 */
function totalCost(turns: readonly TimelineTurn[]): number | null {
  const priced = turns.filter((turn) => turn.costUsd !== null);
  if (priced.length === 0) return null;
  return priced.reduce((total, turn) => total + (turn.costUsd ?? 0), 0);
}
