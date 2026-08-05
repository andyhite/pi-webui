import {
  classifyEnd,
  deriveSessionStatus,
  epochSeconds,
  initialObservationState,
  reduceObservation,
  sessionAuthor,
  type AccountingContext,
  type CompletionEvidence,
  type PhaseContext,
  type RuntimeObservation,
  type RuntimeRequest,
  type RuntimeRequestId,
  type RuntimeSessionHandle,
  type SessionEnd,
  type SessionEndReason,
  type SessionId,
  type SessionObservationState,
  type SessionStatus,
} from "@plotroom/core";
import type { SessionStore, StoredSession } from "@plotroom/db";
import type { EventBus } from "../events/bus.js";
import { announceTranscriptPublished } from "../routes/announce.js";
import type { Logger } from "../logging/logger.js";
import {
  parseSubmission,
  PLOTROOM_SUBMIT_TOOL,
  type ScriptedSubmission,
} from "../runtime/scripted.js";
import type { SessionGate } from "./gate.js";

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
  /**
   * What the world says about this session's declared outcome (principle 3).
   *
   * The driver cannot know: the evidence is the run's own record of what was
   * submitted and which declared conditions held, and the run path is what keeps
   * it. `classifyEnd` is handed the answer and decides — a driver that decided
   * for itself would be principle 3 written twice.
   */
  completionEvidence(sessionId: string): CompletionEvidence;
  /**
   * A runtime raised a structured question (§6.4). Raised, never answered here:
   * the operator answers, and the blocked call stays blocked until they do.
   * Optional only so a test can drive the pump without a question store.
   */
  onQuestion?(input: {
    readonly sessionId: string;
    readonly requestId: RuntimeRequestId;
    readonly request: Extract<RuntimeRequest, { kind: "question" }>;
  }): void;
  /**
   * The session's accounting moved: it spent money (§8).
   *
   * Called from the pump rather than on a timer, because there is no timer
   * anywhere in this product (principle 2) and because spending is observable:
   * the moment a turn reports usage is the moment a budget can be exhausted. The
   * hook attributes the spend up the chain and decides whether anything binds it
   * — the driver knows neither rule and asks.
   *
   * Optional only so a test can drive the pump without budgets wired.
   */
  onAccounting?(input: {
    readonly sessionId: string;
    readonly costUsd: number;
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
  /**
   * Where claims gate the runtime (§3.4, decision 0001's C6). A `tool-permission`
   * request is answered here, per call, before the tool runs. Optional only so a
   * test can drive the pump without a claim store; a session running without one
   * is a session whose writes nothing checked, which is why the app always wires
   * it.
   */
  readonly gate?: SessionGate;
  /**
   * PlotRoom's own gates, which outrank whatever the runtime is doing (§3.6):
   * waiting on a claim is a phase, and it is derived from claim rows rather than
   * from anything the runtime said.
   */
  readonly phaseContext?: (sessionId: string) => Partial<PhaseContext>;
}

export interface DriveSessionInput {
  readonly sessionId: string;
  readonly handle: RuntimeSessionHandle;
  /** Which adapter's tool surface the gate should consult (`WriteIntent`). */
  readonly adapterId?: string;
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
    // Zero, and only ever this pump's own accrual: `initialObservationState`
    // starts a fresh fold, so a resumed session's new pump counts from nothing
    // rather than from what the session has already spent. That is fine because
    // this is a **trigger**, not a total — it answers "has this stream reported
    // new cost?", and the budget path reads the real figure by folding the whole
    // log. Comparing against a stored total here would miss the first turn of a
    // resumed session, which is exactly when a cap is most likely already tight.
    let spent = state.accounting.costUsd;

    try {
      for await (const observation of input.handle.observations()) {
        const record = sessions.appendObservation(sessionId, observation);
        state = reduceObservation(state, observation, accounting);

        const status = deriveSessionStatus(state, {
          now: deps.nowMillis(),
          // Claim waits and pending approvals are PlotRoom's own state, not the
          // runtime's, so they are read here rather than folded from the log.
          ...deps.phaseContext?.(sessionId),
        });
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

        // Money first, before the observation is acted on: a turn that finished
        // by exhausting a budget is a session PlotRoom stops now rather than
        // after whatever it does next (§8).
        if (state.accounting.costUsd > spent) {
          spent = state.accounting.costUsd;
          await hooks.onAccounting?.({ sessionId, costUsd: spent });
        }

        switch (observation.kind) {
          case "injection-delivered":
            // Delivery is the observed fact the ledger has been waiting for; it
            // is never inferred from the queue accepting the input (§6.5).
            sessions.markDelivered(
              observation.injectionId,
              epochSeconds(observation.at),
            );
            break;

          case "injection-refused":
            // The runtime rejected input already acknowledged as queued (issue
            // #107) — reported against the injection it was, so the §6.5 ledger's
            // `refused` state is reachable rather than left `queued` forever.
            sessions.markRefused(
              observation.injectionId,
              epochSeconds(observation.at),
              observation.reason,
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

          case "request-raised":
            if (observation.request.kind === "question") {
              // §6.4: a question is the **human's** to answer, so it is raised and
              // left open rather than answered by anything here. Routing it through
              // the permission gate would have denied it — the gate's own words are
              // "this gate answers tool permissions; a question is answered by a
              // human" — which would have turned every structured question a runtime
              // asked into an instant refusal. The blocked call stays blocked until
              // the operator answers, which is exactly what §6.4 describes and what
              // principle 2 requires: no timer resolves it.
              deps.hooks.onQuestion?.({
                sessionId,
                requestId: observation.requestId,
                request: observation.request,
              });
              break;
            }

            // §3.4's enforcement point: a write is answered from claims before
            // the tool runs, and an unbounded one raises an approval instead of
            // being allowed because nothing recognized it.
            await answerRequest(deps, {
              sessionId,
              handle: input.handle,
              adapterId: input.adapterId ?? "unknown",
              requestId: observation.requestId,
              request: observation.request,
            });
            break;

          case "session-ended":
            await endFromObservation(deps, {
              sessionId,
              reason: observation.reason,
              at: epochSeconds(observation.at),
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
      });
    }
  })().catch((error: unknown) => {
    // The pump must never reject. Recording the end can itself fail — the
    // clearest case is a session whose record was removed underneath it by a
    // confirmed reset (§12) — and an unhandled rejection is a process Node
    // terminates. Nothing downstream waits on this promise except shutdown, so
    // the honest end of the line is a log entry (§8).
    logger.error("session driver stopped without recording an end", {
      sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

interface EndInput {
  readonly sessionId: string;
  readonly reason: SessionEndReason;
  readonly at: number;
}

/**
 * Answer one runtime request (§3.4, §6.6).
 *
 * The decision is `@plotroom/core`'s `decideToolPermission`, reached through the
 * gate; this only carries the answer back. With no gate wired the request is
 * **denied**, not allowed: a write nothing could check is exactly the fail-open
 * the C6 verification exists to rule out.
 *
 * **A call that raised an approval is left blocked**, exactly like a question
 * (§6.4): the approval outlives the call, and answering it settles *that* call
 * rather than a copy of it (`ApprovalService.answer` responds). Sending the
 * refusal that accompanies a raise would settle the call before anybody was
 * asked, and the session would be told "no" for a question the operator was
 * about to answer "yes".
 */
async function answerRequest(
  deps: SessionDriverDeps,
  input: {
    readonly sessionId: string;
    readonly handle: RuntimeSessionHandle;
    readonly adapterId: string;
    readonly requestId: RuntimeRequestId;
    readonly request: RuntimeRequest;
  },
): Promise<void> {
  const decision = deps.gate?.decide({
    sessionId: input.sessionId,
    adapterId: input.adapterId,
    requestId: input.requestId,
    request: input.request,
  });

  if (decision?.pendingApprovalId != null) {
    deps.logger.info("a runtime call is waiting on an approval", {
      sessionId: input.sessionId,
      requestId: input.requestId,
      approvalId: decision.pendingApprovalId,
    });
    return;
  }

  const outcome =
    decision === undefined
      ? ({
          kind: "deny",
          reason:
            "no claim gate is wired, so nothing could check this write (§3.4)",
        } as const)
      : decision.outcome;

  try {
    await input.handle.respond(input.requestId, outcome);
  } catch (error) {
    // A runtime that will not take an answer is a runtime whose request nobody
    // can settle; it is logged and the stream carries on, because the pump must
    // never be what stops (principle 11).
    deps.logger.error("a runtime would not accept a permission answer", {
      sessionId: input.sessionId,
      requestId: input.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Turn what the runtime reported into what PlotRoom records.
 *
 * `classifyEnd` is the only place one becomes the other, and PlotRoom's own state
 * outranks the report — including the rule that **completion is proof, never a
 * claim** (§3.5, principle 3), which lives beside it as `checkProvenCompletion`.
 * This used to be a clause here; it is core's now, and all this does is supply
 * the evidence only the run path can know and record whatever comes back.
 */
async function endFromObservation(
  deps: SessionDriverDeps,
  input: EndInput,
): Promise<void> {
  // No `budgetStop` context is ever supplied here: PlotRoom initiates budget
  // stops itself and writes that outcome before it touches the runtime, so what
  // reaches this point is only ever the runtime's own report (§3.6, §8). The
  // completion evidence is supplied for every report, because absent evidence is
  // not proof: `classifyEnd` records an unproven completion as a failure that
  // says which half was missing.
  const end = classifyEnd(input.reason, input.at, {
    completion: deps.hooks.completionEvidence(input.sessionId),
  });

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
    announceTranscriptPublished(deps.bus, input.sessionId, published, author);
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
