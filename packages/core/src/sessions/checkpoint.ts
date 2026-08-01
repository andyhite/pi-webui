import type { Author } from "../author.js";
import type { SessionEnd } from "./end-states.js";

/**
 * The live-transcript checkpoint rule (§3.6).
 *
 * "A live transcript versions on checkpoint, not on every turn: a wired
 * transcript that drifted its consumers per turn would bury the drift feed in
 * noise (§4.5); its consumers drift when the session ends or when someone —
 * the session included — explicitly checkpoints it."
 *
 * The rule is this predicate. A turn never publishes; nothing else in the
 * product decides when a transcript versions, so the noise floor cannot be
 * raised by a caller that forgot.
 */
export type TranscriptEvent =
  | { readonly kind: "turn-ended"; readonly at: number; readonly turn: number }
  | { readonly kind: "checkpoint"; readonly at: number; readonly by: Author }
  | {
      readonly kind: "session-ended";
      readonly at: number;
      readonly end: SessionEnd;
    };

export function publishesVersion(event: TranscriptEvent): boolean {
  switch (event.kind) {
    case "turn-ended":
      return false;
    case "checkpoint":
    case "session-ended":
      return true;
  }
}

/** Why a transcript version exists, recorded with the version. */
export type PublicationTrigger = "checkpoint" | "session-end";

export interface TranscriptPublication {
  /** 1-based, monotonic per transcript — the version consumers can wire. */
  readonly ordinal: number;
  /** Every turn up to and including this one is in the published content. */
  readonly throughTurn: number;
  readonly at: number;
  readonly trigger: PublicationTrigger;
  /**
   * Who checkpointed. §3.6 allows the session itself: checkpointing its own
   * transcript publishes what it already said, so it is not authoring context
   * into its own chain (principle 1).
   */
  readonly by: Author | null;
}

export interface TranscriptPublicationState {
  /** Turns observed but not yet published — visible, never silent (§4.5). */
  readonly pendingTurns: number;
  readonly observedTurns: number;
  readonly publishedThroughTurn: number;
  readonly publications: readonly TranscriptPublication[];
  readonly ended: boolean;
}

export const INITIAL_PUBLICATION_STATE: TranscriptPublicationState = {
  pendingTurns: 0,
  observedTurns: 0,
  publishedThroughTurn: 0,
  publications: [],
  ended: false,
};

/**
 * Fold one transcript event. A checkpoint with nothing pending publishes
 * nothing: an empty version would drift every consumer for no change, which is
 * exactly the noise the rule exists to prevent.
 */
export function reduceTranscriptPublication(
  state: TranscriptPublicationState,
  event: TranscriptEvent,
): TranscriptPublicationState {
  if (event.kind === "turn-ended") {
    return {
      ...state,
      observedTurns: Math.max(state.observedTurns, event.turn),
      pendingTurns: state.pendingTurns + 1,
    };
  }

  const ended = state.ended || event.kind === "session-ended";
  if (state.pendingTurns === 0) return { ...state, ended };

  const publication: TranscriptPublication = {
    ordinal: state.publications.length + 1,
    throughTurn: state.observedTurns,
    at: event.at,
    trigger: event.kind === "checkpoint" ? "checkpoint" : "session-end",
    by: event.kind === "checkpoint" ? event.by : null,
  };

  return {
    pendingTurns: 0,
    observedTurns: state.observedTurns,
    publishedThroughTurn: state.observedTurns,
    publications: [...state.publications, publication],
    ended,
  };
}

export function latestPublication(
  state: TranscriptPublicationState,
): TranscriptPublication | null {
  return state.publications.at(-1) ?? null;
}

/**
 * Whether consumers of this transcript are looking at stale content. Only a
 * publication moves this; unpublished turns are invisible to drift by design
 * (§3.6, §4.5).
 */
export function consumersDrift(
  state: TranscriptPublicationState,
  consumedOrdinal: number,
): boolean {
  const latest = latestPublication(state);
  if (!latest) return false;
  return consumedOrdinal < latest.ordinal;
}
