/**
 * The end-state taxonomy (spec §3.6, principle 11).
 *
 * "A thing that gave up says why — distinguishing _it did not work_ from _it
 * was stopped_ from _it ran out of budget_." Interruption is the fourth of
 * those distinctions: a crash or restart with sessions in flight did not fail
 * and nobody stopped it.
 *
 * The taxonomy is complete and closed. Every consumer switches exhaustively
 * over `SessionEndKind`, so adding an outcome later is a compile error at every
 * place that renders or reasons about one — which is the point: a retry that
 * treats out-of-budget like failure re-runs work the money already ran out on.
 */

/** Budget scopes (§8). A cap that binds can be any of the three. */
export const BUDGET_SCOPES = ["run", "workstream", "global"] as const;

export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export const SESSION_END_KINDS = [
  "completed",
  "ended-by-user",
  "stopped",
  "out-of-budget",
  "failed",
  "interrupted",
] as const;

export type SessionEndKind = (typeof SESSION_END_KINDS)[number];

export type SessionEnd = { readonly at: number } &
  /** A producing session ended on proven completion (principle 3). */
  (
    | { readonly kind: "completed" }
    /** An open session the user ended; whatever work remains, remains. */
    | { readonly kind: "ended-by-user" }
    /** Somebody stopped it (§6.7). */
    | { readonly kind: "stopped"; readonly by: "user" | "session" }
    /**
     * The money ran out. PlotRoom stops the session; the runtime never reports
     * this outcome (§3.6, §8).
     */
    | { readonly kind: "out-of-budget"; readonly scope: BudgetScope }
    /** Unrecoverable failure, with the reason the spec requires it to state. */
    | { readonly kind: "failed"; readonly message: string }
    /**
     * A crash or restart caught the session in flight (principle 11). Not
     * stopped, not failed; resumable like any session, and resuming it is a
     * gesture, never automatic (principle 2).
     */
    | { readonly kind: "interrupted"; readonly message: string }
  );

/**
 * What each outcome means, stated once. Everything that renders or acts on an
 * end state reads these facts instead of re-deriving them from the kind —
 * otherwise "out-of-budget is not failure" is true in one surface and false in
 * the next.
 */
export interface EndStateFacts {
  readonly kind: SessionEndKind;
  /** Every ended session stays readable, resumable, forkable (§3.6). */
  readonly resumable: boolean;
  /** Did the work fail? Only `failed` (principle 11). */
  readonly failed: boolean;
  /** Did somebody stop it? Only `stopped` (§6.7). */
  readonly stopped: boolean;
  /** Was completion proven against the world? Only `completed` (principle 3). */
  readonly proven: boolean;
  /** Might work remain undone? Everything except a proven completion. */
  readonly workIncomplete: boolean;
  /**
   * May a retry re-run this without asking anyone? False for out-of-budget:
   * "something a retry must not blindly re-run" (§3.6).
   */
  readonly safeToRetryBlindly: boolean;
  /**
   * Does the outcome itself put the session in front of the operator? An
   * interrupted or out-of-budget session needs a decision (resume, raise the
   * cap, or leave it); a stopped one was already the operator's decision.
   */
  readonly wantsDecision: boolean;
}

export function endStateFacts(end: SessionEnd): EndStateFacts {
  switch (end.kind) {
    case "completed":
      return {
        kind: end.kind,
        resumable: true,
        failed: false,
        stopped: false,
        proven: true,
        workIncomplete: false,
        safeToRetryBlindly: true,
        wantsDecision: false,
      };
    case "ended-by-user":
      return {
        kind: end.kind,
        resumable: true,
        failed: false,
        stopped: false,
        proven: false,
        workIncomplete: true,
        safeToRetryBlindly: true,
        wantsDecision: false,
      };
    case "stopped":
      return {
        kind: end.kind,
        resumable: true,
        failed: false,
        stopped: true,
        proven: false,
        workIncomplete: true,
        safeToRetryBlindly: true,
        wantsDecision: false,
      };
    case "out-of-budget":
      return {
        kind: end.kind,
        resumable: true,
        failed: false,
        stopped: false,
        proven: false,
        workIncomplete: true,
        safeToRetryBlindly: false,
        wantsDecision: true,
      };
    case "failed":
      return {
        kind: end.kind,
        resumable: true,
        failed: true,
        stopped: false,
        proven: false,
        workIncomplete: true,
        safeToRetryBlindly: true,
        wantsDecision: true,
      };
    case "interrupted":
      return {
        kind: end.kind,
        resumable: true,
        failed: false,
        stopped: false,
        proven: false,
        workIncomplete: true,
        safeToRetryBlindly: true,
        wantsDecision: true,
      };
  }
}

/**
 * The short reason a card shows. Kept beside the taxonomy so no surface
 * invents its own wording for "the money ran out".
 */
export function describeEnd(end: SessionEnd): string {
  switch (end.kind) {
    case "completed":
      return "completed";
    case "ended-by-user":
      return "ended by you";
    case "stopped":
      return end.by === "user" ? "stopped by you" : "stopped by a session";
    case "out-of-budget":
      return `out of budget (${end.scope})`;
    case "failed":
      return `failed: ${end.message}`;
    case "interrupted":
      return `interrupted: ${end.message}`;
  }
}
