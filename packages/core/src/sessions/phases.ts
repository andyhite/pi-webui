import type { AccountingContext, SessionAccounting } from "./accounting.js";
import { applyTurnUsage, startAccounting, touch } from "./accounting.js";
import type {
  EpochMillis,
  RuntimeObservation,
  RuntimeRequest,
  RuntimeRequestId,
  SessionEndReason,
} from "./runtime.js";

/**
 * Phase derivation (§3.6, principle 7): phases are computed by PlotRoom from
 * what it observes, never reported by the agent. This is a pure reducer plus a
 * pure selector, the same pattern as the graph predicates — one place states
 * the rule, and the canvas, the API, and agent tools read the same answer.
 *
 * The record's timestamps are milliseconds (an adapter stamps them); PlotRoom's
 * own records are Unix seconds, matching every `created_at` in the schema. The
 * conversion happens here, at the seam, and nowhere else.
 */
export function epochSeconds(at: EpochMillis): number {
  return Math.floor(at / 1000);
}

export type SessionPhase =
  | { readonly kind: "thinking" }
  | { readonly kind: "responding" }
  | { readonly kind: "tool-running"; readonly toolName: string }
  | { readonly kind: "compacting" }
  | { readonly kind: "waiting-approval" }
  | { readonly kind: "waiting-input" }
  | { readonly kind: "waiting-on-claim" }
  | { readonly kind: "stopped" }
  | { readonly kind: "failed" }
  | { readonly kind: "idle" };

export interface RunningToolCall {
  readonly callId: string;
  readonly toolName: string;
  readonly startedAt: EpochMillis;
}

export interface OpenRuntimeRequest {
  readonly requestId: RuntimeRequestId;
  readonly request: RuntimeRequest;
  readonly raisedAt: EpochMillis;
}

/** What the fold over the observation log knows. Nothing here is agent-reported. */
export interface SessionObservationState {
  readonly startedAt: EpochMillis;
  readonly lastObservedAt: EpochMillis;
  readonly turnOpen: boolean;
  readonly turnsCompleted: number;
  /** The last streaming activity observed inside the open turn. */
  readonly streaming: "none" | "reasoning" | "output";
  readonly compacting: boolean;
  readonly runningTools: readonly RunningToolCall[];
  readonly openRequests: readonly OpenRuntimeRequest[];
  readonly ended: SessionEndReason | null;
  /** A fatal runtime error observed before any end reason arrived. */
  readonly fatalError: string | null;
  /** Folded from the same log, in seconds (§3.6 accounting). */
  readonly accounting: SessionAccounting;
}

export function initialObservationState(
  startedAt: EpochMillis,
): SessionObservationState {
  return {
    startedAt,
    lastObservedAt: startedAt,
    turnOpen: false,
    turnsCompleted: 0,
    streaming: "none",
    compacting: false,
    runningTools: [],
    openRequests: [],
    ended: null,
    fatalError: null,
    accounting: startAccounting(epochSeconds(startedAt)),
  };
}

/**
 * Fold one observation. Deliberately total: an observation that says nothing
 * about the phase still counts as activity, because silence — not idleness —
 * is what health alerts watch (§7.2).
 */
export function reduceObservation(
  state: SessionObservationState,
  observation: RuntimeObservation,
  context: AccountingContext = {},
): SessionObservationState {
  const seconds = epochSeconds(observation.at);
  const base: SessionObservationState = {
    ...state,
    lastObservedAt: Math.max(state.lastObservedAt, observation.at),
    accounting: touch(state.accounting, seconds),
  };

  switch (observation.kind) {
    case "turn-started":
      return { ...base, turnOpen: true, streaming: "none" };
    case "reasoning-delta":
      return { ...base, streaming: "reasoning" };
    case "output-delta":
      return { ...base, streaming: "output" };
    case "tool-started":
      return {
        ...base,
        runningTools: [
          ...base.runningTools,
          {
            callId: observation.callId,
            toolName: observation.toolName,
            startedAt: observation.at,
          },
        ],
      };
    case "tool-finished":
      return {
        ...base,
        runningTools: base.runningTools.filter(
          (call) => call.callId !== observation.callId,
        ),
      };
    case "compaction-started":
      return { ...base, compacting: true };
    case "compaction-finished":
      return { ...base, compacting: false };
    case "request-raised":
      return {
        ...base,
        openRequests: [
          ...base.openRequests,
          {
            requestId: observation.requestId,
            request: observation.request,
            raisedAt: observation.at,
          },
        ],
      };
    case "request-settled":
      return {
        ...base,
        openRequests: base.openRequests.filter(
          (open) => open.requestId !== observation.requestId,
        ),
      };
    case "injection-delivered":
      return base;
    case "turn-ended":
      return {
        ...base,
        turnOpen: false,
        streaming: "none",
        turnsCompleted: base.turnsCompleted + 1,
        accounting: applyTurnUsage(
          base.accounting,
          observation.usage,
          seconds,
          context,
        ),
      };
    case "session-ended":
      return {
        ...base,
        turnOpen: false,
        streaming: "none",
        runningTools: [],
        ended: base.ended ?? observation.reason,
      };
    case "runtime-error":
      return observation.fatal
        ? { ...base, fatalError: base.fatalError ?? observation.message }
        : base;
  }
}

/** PlotRoom's own state, joined in — it is not observable from the runtime. */
export interface PhaseContext {
  readonly now: EpochMillis;
  /** An approval PlotRoom raised and nobody has answered (§6.6). */
  readonly pendingApproval?: boolean;
  /** The session wants a path another session holds (§3.4). */
  readonly waitingOnClaim?: boolean;
  /**
   * How long a session may go entirely unobserved before its phase is reported
   * as possibly stalled (decision 0001, "phase derivation blind spots").
   */
  readonly silenceTimeoutMs?: number;
}

export const DEFAULT_SILENCE_TIMEOUT_MS = 5 * 60 * 1000;

export function deriveSessionPhase(
  state: SessionObservationState,
  context: PhaseContext,
): SessionPhase {
  if (state.ended) return endedPhase(state.ended);
  if (state.fatalError !== null) return { kind: "failed" };

  // PlotRoom's own gates outrank whatever the runtime is doing: a session that
  // cannot proceed until a human or a claim answers is waiting, whatever it was
  // last seen streaming.
  if (context.waitingOnClaim) return { kind: "waiting-on-claim" };
  if (context.pendingApproval || hasOpenApproval(state)) {
    return { kind: "waiting-approval" };
  }
  if (hasOpenQuestion(state)) return { kind: "waiting-input" };

  if (state.compacting) return { kind: "compacting" };

  const tool = state.runningTools.at(-1);
  if (tool) return { kind: "tool-running", toolName: tool.toolName };

  if (state.turnOpen) {
    return state.streaming === "output"
      ? { kind: "responding" }
      : { kind: "thinking" };
  }

  // Between turns: a session that has spoken is waiting for the next thing
  // said to it; one that has never run has nothing to wait on yet.
  return state.turnsCompleted > 0
    ? { kind: "waiting-input" }
    : { kind: "idle" };
}

function endedPhase(reason: SessionEndReason): SessionPhase {
  switch (reason.kind) {
    case "failed":
      return { kind: "failed" };
    case "stopped":
    case "out-of-budget":
      return { kind: "stopped" };
    case "completed":
    case "ended-by-user":
    case "interrupted":
      return { kind: "idle" };
  }
}

function hasOpenApproval(state: SessionObservationState): boolean {
  return state.openRequests.some(
    (open) => open.request.kind === "tool-permission",
  );
}

function hasOpenQuestion(state: SessionObservationState): boolean {
  return state.openRequests.some((open) => open.request.kind === "question");
}

/** Each phase carries whether the session is busy and whether it wants attention (§3.6). */
export interface PhaseFacts {
  readonly busy: boolean;
  readonly wantsAttention: boolean;
}

export function phaseFacts(phase: SessionPhase): PhaseFacts {
  switch (phase.kind) {
    case "thinking":
    case "responding":
    case "tool-running":
    case "compacting":
      return { busy: true, wantsAttention: false };
    case "waiting-approval":
    case "waiting-input":
      return { busy: false, wantsAttention: true };
    case "waiting-on-claim":
      // Blocked, not asking: the claim clears on its own, and only a wait past
      // its threshold becomes a health alert (§7.2).
      return { busy: false, wantsAttention: false };
    case "failed":
      return { busy: false, wantsAttention: true };
    case "stopped":
    case "idle":
      return { busy: false, wantsAttention: false };
  }
}

/**
 * Silence is reported as a health signal, never as a phase (decision 0001): a
 * runtime that goes quiet during a long tool call is indistinguishable from a
 * hung one, and claiming either would be inference, not observation
 * (principle 7).
 */
export interface SessionHealth {
  readonly silentForMs: number;
  readonly possiblyStalled: boolean;
}

export function deriveSessionHealth(
  state: SessionObservationState,
  context: PhaseContext,
): SessionHealth {
  const silentForMs = Math.max(0, context.now - state.lastObservedAt);
  const timeout = context.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;
  const live = state.ended === null && state.fatalError === null;
  const busy = state.turnOpen || state.runningTools.length > 0;

  return {
    silentForMs,
    possiblyStalled: live && busy && silentForMs >= timeout,
  };
}

export interface SessionStatus {
  readonly phase: SessionPhase;
  readonly facts: PhaseFacts;
  readonly health: SessionHealth;
}

export function deriveSessionStatus(
  state: SessionObservationState,
  context: PhaseContext,
): SessionStatus {
  const phase = deriveSessionPhase(state, context);
  return {
    phase,
    facts: phaseFacts(phase),
    health: deriveSessionHealth(state, context),
  };
}
