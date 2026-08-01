import type { RuntimeCapabilities, TranscriptPoint } from "./runtime.js";
import type { ReleaseMarker, Transcript } from "./transcript.js";
import { exportTranscript } from "./transcript.js";

/**
 * Fork from any point (§6.3), and what it costs when the runtime cannot.
 *
 * Decision 0001: "fork-from-point is emulated by transcript-prefix seeding when
 * a runtime lacks native fork". PlotRoom owns the bookkeeping either way; the
 * capability flag keeps the difference honest rather than hiding it, because a
 * seeded fork is not bit-identical to a native one (provider caches, tool
 * state).
 */
export type ForkMode = "native" | "seeded";

export interface NativeForkPlan {
  readonly mode: "native";
  readonly point: TranscriptPoint;
}

export interface SeededForkPlan {
  readonly mode: "seeded";
  /** Why the runtime could not do it, in the words the UI can show. */
  readonly reason: "no-native-fork" | "not-a-turn-boundary";
  /** The transcript prefix a fresh native session is started from. */
  readonly seed: string;
  readonly throughTurn: number;
  /**
   * False when released tool output could not be reloaded for the seed. A fork
   * seeded from an incomplete prefix is a truncated context, which the product
   * warns about and never does quietly (principle 12).
   */
  readonly complete: boolean;
  readonly unavailable: readonly string[];
}

export type ForkPlan = NativeForkPlan | SeededForkPlan;

export function transcriptPrefix(
  transcript: Transcript,
  point: TranscriptPoint,
): Transcript {
  return {
    ...transcript,
    turns: transcript.turns.filter((turn) => turn.ordinal <= point.turn),
  };
}

export function isTurnBoundary(
  transcript: Transcript,
  point: TranscriptPoint,
): boolean {
  return transcript.turns.some((turn) => turn.ordinal === point.turn);
}

/**
 * Decide how a fork happens. Native where the adapter can reach the point;
 * seeded otherwise — and the seed is built by exporting the prefix, so released
 * content is reloaded first and the plan reports it if that failed.
 */
export function planFork(
  capabilities: RuntimeCapabilities,
  transcript: Transcript,
  point: TranscriptPoint,
  loadReleased: (marker: ReleaseMarker, callId: string) => string | null = () =>
    null,
): ForkPlan {
  const boundary = isTurnBoundary(transcript, point);

  if (capabilities.fork === "any-point") return { mode: "native", point };
  if (capabilities.fork === "turn-boundary" && boundary) {
    return { mode: "native", point };
  }

  const prefix = transcriptPrefix(transcript, point);
  const exported = exportTranscript(prefix, loadReleased);

  return {
    mode: "seeded",
    reason:
      capabilities.fork === "none" ? "no-native-fork" : "not-a-turn-boundary",
    seed: exported.document,
    throughTurn: prefix.turns.at(-1)?.ordinal ?? 0,
    complete: exported.complete,
    unavailable: exported.unavailable,
  };
}
