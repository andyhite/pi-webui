import {
  classifyEnd,
  deriveSessionStatus,
  epochSeconds,
  initialObservationState,
  reduceObservation,
  sessionAuthor,
  type AccountingContext,
  type RuntimeObservation,
  type RuntimeSessionHandle,
  type SessionEnd,
  type SessionEndReason,
  type SessionId,
  type SessionObservationState,
  type SessionStatus,
  type VersionId,
} from "@plotroom/core";
import type { SessionStore, StoredSession } from "@plotroom/db";
import type { EventBus } from "../events/bus.js";
import type { Logger } from "../logging/logger.js";
import {
  parseSubmission,
  PLOTROOM_SUBMIT_TOOL,
  type ScriptedSubmission,
} from "../runtime/scripted.js";

/**
 * The observation pump: one adapter's stream becomes PlotRoom's record.
 *
 * Every observation takes the same route, whichever runtime produced it —
 * appended to the log, folded by `@plotroom/core`'s reducer, snapshotted, and
 * published on the one event vocabulary. The phase a surface renders is
 * therefore always derived from what was observed and never reported by an
 * agent (principle 7), and the scripted runtime exercises this exact path.
 */
export interface SessionDriverHooks {
  /**
   * A session submitted its outcome. The submission is a claim; PlotRoom checks
   * the declared world conditions itself and hands back feedback or proof
   * (§3.5, principle 3).
   */
  onSubmission(input: {
    readonly sessionId: string;
    readonly submission: ScriptedSubmission;
  }): Promise<void>;
  /** A session's stream ended. The run must stop being "running" too. */
  onEnded(input: {
    readonly sessionId: string;
    readonly end: SessionEnd;
  }): Promise<void>;
}

export interface SessionDriverDeps {
  readonly sessions: SessionStore;
  readonly bus: EventBus;
  readonly logger: Logger;
  readonly hooks: SessionDriverHooks;
  /** Millisecond clock, matching the observation vocabulary. */
  readonly nowMillis: () => number;
}

export interface DriveSessionInput {
  readonly sessionId: string;
  readonly handle: RuntimeSessionHandle;
  /**
   * What the accounting fold needs when the runtime reports none of it itself:
   * a model window to measure occupancy against, and a pricing table if there
   * is one. Both are labelled in the result, never presented as reported.
   */
  readonly accounting?: AccountingContext;
}

/**
 * Drain one session's observations until the stream ends. Returns when it does;
 * the caller keeps the promise so shutdown can wait for a clean drain, and a
 * stream that ends *without* an end observation deliberately leaves the session
 * in flight — that is what a crash looks like, and the next start names it
 * (principle 11).
 */
export function driveSession(
  deps: SessionDriverDeps,
  input: DriveSessionInput,
): Promise<void> {
  const { sessions, bus, logger, hooks } = deps;
  const sessionId = input.sessionId;
  const author = sessionAuthor(sessionId as SessionId);
  const accounting = input.accounting ?? {};

  return (async () => {
    const initial = sessions.get(sessionId);
    let state = initialObservationState(initial.session.startedAt * 1000);

    try {
      for await (const observation of input.handle.observations()) {
        const record = sessions.appendObservation(sessionId, observation);
        state = reduceObservation(state, observation, accounting);

        const status = deriveSessionStatus(state, { now: deps.nowMillis() });
        const stored = sessions.saveDerived(sessionId, state, status.phase);

        bus.publish({
          entity: "session_observation",
          verb: "created",
          sessionId: sessionId as SessionId,
          seqInSession: record.seq,
          observation,
          author,
        });
        publishSession(bus, stored, status, author);

        switch (observation.kind) {
          case "injection-delivered":
            // Delivery is the observed fact the ledger has been waiting for; it
            // is never inferred from the queue accepting the input (§6.5).
            sessions.markDelivered(
              observation.injectionId,
              epochSeconds(observation.at),
            );
            break;

          case "tool-started":
            if (observation.toolName === PLOTROOM_SUBMIT_TOOL) {
              await hooks.onSubmission({
                sessionId,
                submission: parseSubmission(observation.input),
              });
            }
            break;

          case "session-ended":
            await endFromObservation(deps, {
              sessionId,
              reason: observation.reason,
              at: epochSeconds(observation.at),
              mode: stored.session.mode,
              proven: completionAlreadyProven(stored),
            });
            break;

          default:
            break;
        }
      }
    } catch (error) {
      // A crashed adapter never crashes the host (decision 0001): the failure is
      // recorded as the session's own outcome and the server keeps serving.
      const message = error instanceof Error ? error.message : String(error);
      logger.error("session runtime stream failed", { sessionId, message });
      await endFromObservation(deps, {
        sessionId,
        reason: { kind: "failed", message },
        at: epochSeconds(deps.nowMillis()),
        mode: sessions.get(sessionId).session.mode,
        proven: false,
      });
    }
  })();
}

/**
 * Whether PlotRoom has already proven this session's outcome. The run path
 * writes the `completed` end the moment the world conditions held (§3.5), so
 * this is a read of PlotRoom's own record — never of the session's opinion.
 */
function completionAlreadyProven(stored: StoredSession): boolean {
  return stored.session.end?.kind === "completed";
}

interface EndInput {
  readonly sessionId: string;
  readonly reason: SessionEndReason;
  readonly at: number;
  readonly mode: "producing" | "open";
  readonly proven: boolean;
}

/**
 * Turn what the runtime reported into what PlotRoom records.
 *
 * `classifyEnd` is the only place one becomes the other, and PlotRoom's own
 * state outranks the report. One rule is added here, and it belongs to the
 * product rather than to any runtime: **a producing session's completion is
 * proof, never a claim** (§3.5, principle 3). A runtime that says "completed"
 * for work whose declared conditions PlotRoom never proved did not complete it,
 * so the outcome recorded is a failure that says exactly that.
 */
async function endFromObservation(
  deps: SessionDriverDeps,
  input: EndInput,
): Promise<void> {
  const reason: SessionEndReason =
    input.mode === "producing" &&
    input.reason.kind === "completed" &&
    !input.proven
      ? {
          kind: "failed",
          message:
            "the session ended without a proven outcome; completion is proof, not a claim",
        }
      : input.reason;

  // No `budgetStop` context is ever supplied here: PlotRoom initiates budget
  // stops itself and writes that outcome before it touches the runtime, so what
  // reaches this point is only ever the runtime's own report (§3.6, §8).
  const end = classifyEnd(reason, input.at);

  const stored = deps.sessions.end(input.sessionId, end);
  const recorded = stored.session.end ?? end;

  // The transcript versions on session end, never per turn (§3.6): consumers
  // drift once, here.
  const published = deps.sessions.publishTranscript(input.sessionId, {
    kind: "session-ended",
    at: input.at,
    end: recorded,
  });

  const author = sessionAuthor(input.sessionId as SessionId);

  if (published) {
    deps.bus.publish({
      entity: "session_transcript",
      verb: "created",
      sessionId: input.sessionId as SessionId,
      publication: published.publication,
      objectId: published.objectId,
      versionId: published.versionId as VersionId,
      author,
    });
  }

  const status = deps.sessions.status(input.sessionId, {
    now: deps.nowMillis(),
  });
  publishSession(deps.bus, deps.sessions.get(input.sessionId), status, author);

  await deps.hooks.onEnded({ sessionId: input.sessionId, end: recorded });
}

function publishSession(
  bus: EventBus,
  stored: StoredSession,
  status: SessionStatus,
  author: ReturnType<typeof sessionAuthor>,
): void {
  bus.publish({
    entity: "session",
    verb: "updated",
    session: stored.session,
    status,
    author,
  });
}

/** Exported for the tests that assert the fold is the only source of a phase. */
export type { SessionObservationState, RuntimeObservation };
