import {
  initialObservationState,
  reduceObservation,
  type RuntimeObservation,
  type TodoPhaseSnapshot,
} from "@plotroom/core";

/**
 * The plan as a projection of the observation log (§3.6), mirroring
 * `session-transcript.ts`'s own doc comment: derived here rather than
 * written twice. This is the exact fold every session's phase derivation
 * already runs (`reduceObservation`) — `plan-updated` observations are the
 * only ones read; `startedAt` is a fold seed with no bearing on the phases
 * it accumulates, so the caller need not supply the session's real start
 * time to ask "what is the plan now".
 */
export interface PlanFromObservations {
  readonly phases: readonly TodoPhaseSnapshot[];
}

export function planFromObservations(
  observations: readonly RuntimeObservation[],
): PlanFromObservations {
  const state = observations.reduce(
    (folded, observation) => reduceObservation(folded, observation),
    initialObservationState(observations[0]?.at ?? 0),
  );
  return { phases: state.phases };
}
