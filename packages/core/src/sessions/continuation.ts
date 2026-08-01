import type { Author } from "../author.js";
import type { SessionId } from "../ids.js";
import {
  estimateRunCost,
  type CostEstimate,
  type PriorRunCost,
} from "../runs.js";
import {
  checkContinuation,
  type ContinuationGate,
  type DivergenceReport,
} from "../workspaces/divergence.js";
import { isDeleted } from "./deletion.js";
import type { TranscriptPoint } from "./runtime.js";
import { isRunning, type Session } from "./session.js";

/**
 * Resume, fork, and the continue-or-fresh trade (§6.3, §4.3).
 *
 * Two decisions live here because they are the same decision at two tempos, and
 * both are the human's:
 *
 * - **Resume or fork** (§6.3): "Continuing a session is an explicit choice
 *   between resume and fork — never an implicit consequence of typing into it."
 * - **Continue or fresh** (§4.3): re-running a command "is an explicit choice
 *   between two modes, and the product makes the trade visible rather than
 *   deciding silently".
 *
 * Nothing here performs either. These are the inputs a preview renders and a
 * gesture is checked against, as pure functions, so the canvas, the API, and an
 * agent tool cannot reach different verdicts about the same session.
 */

/* --------------------------------------------------- typing is not a choice */

/**
 * What typing into a session does. §6.3's "never an implicit consequence of
 * typing into it" is this union: a live session takes the text as an injection,
 * and an ended one **has no disposition at all** until somebody names resume or
 * fork. There is no third variant that continues something quietly.
 */
export type TypedInputDisposition =
  | {
      readonly kind: "inject";
      readonly sessionId: SessionId;
      /** Mid-flight steering, queued until delivered (§6.5). */
      readonly message: string;
    }
  | {
      readonly kind: "choice-required";
      readonly sessionId: SessionId;
      readonly options: readonly ["resume", "fork"];
      readonly message: string;
    };

export function dispositionOfTypedInput(
  session: Session,
): TypedInputDisposition {
  if (isRunning(session)) {
    return {
      kind: "inject",
      sessionId: session.id,
      message:
        "this session is live, so the text arrives as a new turn and as content on the graph (§6.5)",
    };
  }
  return {
    kind: "choice-required",
    sessionId: session.id,
    options: ["resume", "fork"],
    message:
      "this session has ended; continuing it is an explicit choice between resume and fork (§6.3)",
  };
}

/* ------------------------------------------------------------------ resume */

/**
 * Resume continues the **same session record**: same id, same workstream, same
 * workspace, same accounting, one more turn. Fork is the other verb, and
 * `planSessionFork` (fork.ts) is where it lives.
 */
export interface ResumePlan {
  readonly sessionId: SessionId;
  readonly workstreamId: Session["workstreamId"];
  /** The native session to resume — persisted for exactly this (§3.6). */
  readonly runtime: Session["runtime"];
  readonly launch: Session["launch"];
  /** Who asked. Resuming is never automatic (principle 2), so this is not optional. */
  readonly resumedBy: Author;
  /** Delivered as the first turn of the resumed session; null just reopens it. */
  readonly firstTurn: string | null;
  readonly at: number;
}

export const RESUME_REFUSAL_REASONS = [
  /** It never stopped: this is injection, not resumption (§6.5). */
  "already_running",
  /** Deleted records stay readable, but resuming one silently un-deletes it. */
  "deleted",
  /** Workspace divergence forces fresh, and that includes resuming (§4.3). */
  "workspace_diverged",
] as const;

export type ResumeRefusalReason = (typeof RESUME_REFUSAL_REASONS)[number];

export interface ResumeRefusal {
  readonly reason: ResumeRefusalReason;
  readonly message: string;
  /** The divergence that refused, when that is what refused. */
  readonly gate?: ContinuationGate;
}

export type ResumeResult =
  | { readonly ok: true; readonly plan: ResumePlan }
  | { readonly ok: false; readonly refusal: ResumeRefusal };

export interface ResumeRequest {
  readonly resumedBy: Author;
  readonly firstTurn?: string | null;
  /**
   * The workspace as it stands now, compared against the session's own
   * fingerprint (`deriveDivergence`).
   *
   * **Required, and explicitly `null` when there is nothing to compare.** It was
   * optional, which meant a caller that left it out skipped §4.3's forced-fresh
   * gate and resumed a session whose picture is stale — and the caller most
   * likely to leave it out is the one that never looked at the workspace. Both
   * states have to be said out loud, because only one of them is safe: `null`
   * means "no workspace to compare" (never provisioned, or removed), a report
   * means "here is what changed".
   */
  readonly divergence: DivergenceReport | null;
  readonly at: number;
}

export function planResume(
  session: Session,
  request: ResumeRequest,
): ResumeResult {
  if (isRunning(session)) {
    return {
      ok: false,
      refusal: {
        reason: "already_running",
        message:
          "this session is still running; add content to it mid-flight instead of resuming it (§6.5)",
      },
    };
  }
  if (isDeleted(session)) {
    return {
      ok: false,
      refusal: {
        reason: "deleted",
        message:
          "this session was deleted; restore it first — resuming would un-delete it as a side effect (principle 10)",
      },
    };
  }

  if (request.divergence) {
    const gate = checkContinuation(request.divergence);
    if (!gate.allowed) {
      return {
        ok: false,
        refusal: {
          reason: "workspace_diverged",
          // §4.3: "the session's mental picture is stale in a way no update can
          // repair, and the product says so rather than letting a confused
          // continuation spend money."
          message: `${gate.message ?? "the workspace changed outside this session"} — start fresh, or fork from a point before the change (§4.3)`,
          gate,
        },
      };
    }
  }

  return {
    ok: true,
    plan: {
      sessionId: session.id,
      workstreamId: session.workstreamId,
      runtime: session.runtime,
      launch: session.launch,
      resumedBy: request.resumedBy,
      firstTurn: request.firstTurn ?? null,
      at: request.at,
    },
  };
}

/** The §6.3 choice, as a value a gesture must carry rather than a default. */
export type SessionContinuation =
  | { readonly kind: "resume" }
  | { readonly kind: "fork"; readonly point: TranscriptPoint };

/* ------------------------------------------------------- continue or fresh */

export const CONTINUATION_MODES = ["continue", "fresh"] as const;

export type ContinuationMode = (typeof CONTINUATION_MODES)[number];

/**
 * Each command carries a default mode (§4.3). A *default*, never a decision: the
 * preview still shows both, and `compareContinueVsFresh` reports the default
 * separately from what is available, so a default of "continue" against a
 * diverged workspace does not quietly continue.
 */
export const DEFAULT_CONTINUATION_MODE: ContinuationMode = "fresh";

/**
 * "The combined content must fit the model's window with headroom" (§4.3). The
 * headroom is a fraction of the window rather than a token count, so it scales
 * with the model instead of being tuned per model. **20%**: enough for a real
 * turn's reasoning and tool output on top of what continuation brings back.
 */
export const DEFAULT_CONTINUE_HEADROOM_FRACTION = 0.2;

export interface WindowFit {
  readonly fits: boolean;
  readonly combinedTokens: number;
  readonly windowTokens: number;
  readonly headroomTokens: number;
  readonly requiredHeadroomTokens: number;
  readonly requiredHeadroomFraction: number;
  readonly description: string;
}

export function checkWindowFit(input: {
  readonly combinedTokens: number;
  readonly windowTokens: number;
  readonly requiredHeadroomFraction?: number;
}): WindowFit {
  const fraction =
    input.requiredHeadroomFraction ?? DEFAULT_CONTINUE_HEADROOM_FRACTION;
  const requiredHeadroomTokens = Math.ceil(input.windowTokens * fraction);
  const headroomTokens = input.windowTokens - input.combinedTokens;
  const fits = headroomTokens >= requiredHeadroomTokens;

  return {
    fits,
    combinedTokens: input.combinedTokens,
    windowTokens: input.windowTokens,
    headroomTokens,
    requiredHeadroomTokens,
    requiredHeadroomFraction: fraction,
    description: fits
      ? `${input.combinedTokens} of ${input.windowTokens} tokens, leaving ${headroomTokens} of headroom`
      : `${input.combinedTokens} tokens against a ${input.windowTokens}-token window leaves ${headroomTokens}, under the ${requiredHeadroomTokens} of headroom continuation needs`,
  };
}

export const CONTINUATION_BLOCK_REASONS = [
  /** Nothing to continue: there is no prior session for this command. */
  "no_prior_session",
  /** The prior session was deleted; continuing it would un-delete it. */
  "session_deleted",
  /** §4.3's hard gate: the workspace changed outside the session. */
  "workspace_diverged",
  /** The combined content does not fit the window with headroom. */
  "window_too_small",
] as const;

export type ContinuationBlockReason =
  (typeof CONTINUATION_BLOCK_REASONS)[number];

export interface ContinuationBlock {
  readonly reason: ContinuationBlockReason;
  readonly message: string;
}

export interface ModeOption {
  readonly mode: ContinuationMode;
  readonly available: boolean;
  readonly blocks: readonly ContinuationBlock[];
  /** What this mode would send the model, which is the honest difference (§4.3). */
  readonly inputTokens: number;
  /** Priced from this definition's history, with its basis stated (§4.1). */
  readonly cost: CostEstimate;
  readonly description: string;
}

export interface ContinuationComparison {
  /** Which mode sends less; null when they are the same size. */
  readonly cheaper: ContinuationMode | null;
  /**
   * Deliberately "input-tokens" and not money. Cost history is priced **per
   * definition** (§4.1, `estimateRunCost`), so both modes inherit the same
   * range, and scaling that range by a token ratio would invent precision the
   * product does not have. The comparison the preview can make honestly is how
   * much each mode sends; the money estimate rides beside it, basis and all.
   */
  readonly basis: "input-tokens";
  readonly description: string;
}

export interface ContinueVsFresh {
  readonly continue: ModeOption;
  readonly fresh: ModeOption;
  readonly comparison: ContinuationComparison;
  /** The command's declared default (§4.3). */
  readonly defaultMode: ContinuationMode;
  /** The default, unless it is unavailable — never a mode the gates refused. */
  readonly recommended: ContinuationMode;
  /**
   * True when continuation is impossible, whatever the operator prefers: "two
   * things gate continuation regardless of preference" (§4.3).
   */
  readonly forcedFresh: boolean;
  readonly windowFit: WindowFit;
}

export interface PriorSessionForContinuation {
  readonly sessionId: SessionId;
  /** Live sessions are the cheap path; a completed one brings its history back. */
  readonly running: boolean;
  readonly deleted: boolean;
  /** What replaying this session's history into the window would cost, in tokens. */
  readonly historyTokens: number;
}

export interface ContinueVsFreshInput {
  /** Null when the command has never run: only fresh exists (§4.3). */
  readonly priorSession: PriorSessionForContinuation | null;
  /** Full context assembly — what a fresh run sends (§3.5). */
  readonly assemblyTokens: number;
  /** What changed since, delivered as a new turn — what continuing adds. */
  readonly changedSinceTokens: number;
  readonly windowTokens: number;
  readonly requiredHeadroomFraction?: number;
  /**
   * The workspace against the session's own fingerprint. **Required**, and `null`
   * only when there is genuinely nothing to compare: §4.3's "workspace divergence
   * forces fresh" is not a gate a caller may skip by leaving a field out, and a
   * preview that skipped it is exactly the one that spends money on a confused
   * continuation.
   */
  readonly divergence: DivergenceReport | null;
  readonly priorRuns: readonly PriorRunCost[];
  readonly defaultMode?: ContinuationMode;
}

/**
 * The §4.3 decision, side by side. Both options are always described — the
 * refused one included, with the reason it is refused — because a preview that
 * hides the option it rejected cannot be argued with.
 */
export function compareContinueVsFresh(
  input: ContinueVsFreshInput,
): ContinueVsFresh {
  const prior = input.priorSession;
  const defaultMode = input.defaultMode ?? DEFAULT_CONTINUATION_MODE;

  // "Continuing a live session is always the cheap path. Continuing a completed
  // session means bringing its whole history back, which can cost more than
  // starting over" (§4.3).
  const continueTokens =
    prior === null
      ? input.changedSinceTokens
      : prior.running
        ? input.changedSinceTokens
        : prior.historyTokens + input.changedSinceTokens;

  const windowFit = checkWindowFit({
    combinedTokens: continueTokens,
    windowTokens: input.windowTokens,
    ...(input.requiredHeadroomFraction === undefined
      ? {}
      : { requiredHeadroomFraction: input.requiredHeadroomFraction }),
  });

  const blocks: ContinuationBlock[] = [];
  if (prior === null) {
    blocks.push({
      reason: "no_prior_session",
      message: "this command has never run, so there is nothing to continue",
    });
  } else if (prior.deleted) {
    blocks.push({
      reason: "session_deleted",
      message:
        "the prior session was deleted; restore it first rather than continuing it (principle 10)",
    });
  }

  if (input.divergence) {
    const gate = checkContinuation(input.divergence);
    if (!gate.allowed) {
      blocks.push({
        reason: "workspace_diverged",
        message: `${gate.message ?? "the workspace changed outside this session"} — divergence forces fresh (§4.3)`,
      });
    }
  }

  if (!windowFit.fits) {
    blocks.push({
      reason: "window_too_small",
      message: windowFit.description,
    });
  }

  const continueOption: ModeOption = {
    mode: "continue",
    available: blocks.length === 0,
    blocks,
    inputTokens: continueTokens,
    cost: estimateRunCost({
      inputTokens: continueTokens,
      priorRuns: input.priorRuns,
    }),
    description:
      prior === null
        ? "nothing to continue"
        : prior.running
          ? `continue the live session with ${input.changedSinceTokens} tokens of what changed since`
          : `continue the completed session, bringing back ${prior.historyTokens} tokens of history plus ${input.changedSinceTokens} of what changed`,
  };

  const freshOption: ModeOption = {
    mode: "fresh",
    // Fresh is never gated. It is the answer to every refusal above, so it
    // cannot itself be refused here.
    available: true,
    blocks: [],
    inputTokens: input.assemblyTokens,
    cost: estimateRunCost({
      inputTokens: input.assemblyTokens,
      priorRuns: input.priorRuns,
    }),
    description: `a new session with ${input.assemblyTokens} tokens of freshly assembled context`,
  };

  const cheaper =
    continueTokens === input.assemblyTokens
      ? null
      : continueTokens < input.assemblyTokens
        ? ("continue" as const)
        : ("fresh" as const);

  return {
    continue: continueOption,
    fresh: freshOption,
    comparison: {
      cheaper,
      basis: "input-tokens",
      description:
        cheaper === null
          ? `both modes send about ${continueTokens} tokens`
          : `continue sends ${continueTokens} tokens, fresh sends ${input.assemblyTokens}${
              cheaper === "fresh"
                ? " — starting over sends less than bringing the history back"
                : ""
            }`,
    },
    defaultMode,
    recommended: continueOption.available ? defaultMode : "fresh",
    forcedFresh: !continueOption.available,
    windowFit,
  };
}
