import type { SessionEnd, BudgetScope } from "./end-states.js";

/**
 * The runtime boundary PlotRoom owns (decision 0001).
 *
 * Adapters translate one runtime's native surface into a timestamped
 * observation stream plus a small command set. Everything the spec makes
 * product behavior — phase derivation, the injection ledger, accounting
 * aggregation, budgets, session records, fork bookkeeping — is on this side of
 * the seam and lives in `@plotroom/core`. An adapter supplies raw capability
 * and nothing above it.
 *
 * Session records store these observations, not vendor payloads, so
 * resume/fork/accounting survive vendor churn.
 */

/** Milliseconds since the epoch, as the adapter stamped it. */
export type EpochMillis = number;

/** Opaque native identity, persisted so resume/fork survive a restart. */
export type RuntimeSessionRef = string;

export type RuntimeRequestId = string;

export type InjectionId = string;

/** What a runtime adapter declares it can do; PlotRoom emulates or refuses the rest. */
export interface RuntimeCapabilities {
  /**
   * Native fork support. "none" means PlotRoom emulates by seeding a new
   * native session from its own transcript record (§6.3).
   */
  readonly fork: "any-point" | "turn-boundary" | "none";
  /**
   * Whether input submitted mid-turn is consumed at the next boundary without
   * a new explicit turn ("between-turns"), or only as the next turn's prompt
   * ("next-turn"). Governs how long "queued" lasts (§6.5).
   */
  readonly injection: "between-turns" | "next-turn";
  /**
   * Whether the runtime reports monetary cost itself; if false PlotRoom prices
   * token usage from its own model-pricing table.
   */
  readonly reportsCost: boolean;
  /**
   * Whether context-window occupancy is reported; if false the meter is
   * estimated from cumulative usage against the model's known window.
   */
  readonly reportsContextWindow: boolean;
  /**
   * Whether the runtime lets the host decide tool permissions per call, so
   * approvals (§6.6) and claims (§3.4) gate the runtime rather than advise it
   * (decision 0001, C6). An adapter that returns false cannot be trusted with
   * claim enforcement — `checkPermissionEnforcement` is what refuses.
   */
  readonly enforcesPermissions: boolean;
}

/** Per-session choices, made at launch and visible after (§3.6). */
export interface SessionLaunchChoices {
  readonly model: string;
  readonly effort: SessionEffort;
  readonly toolPermissions: SessionToolPermissions;
}

/**
 * PlotRoom's own effort vocabulary. Adapters map it onto whatever their
 * runtime calls the same idea; the product never speaks a vendor's dialect.
 */
export const SESSION_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "max",
] as const;

export type SessionEffort = (typeof SESSION_EFFORTS)[number];

/**
 * What one session was launched with (§3.6) — deliberately not `ToolPermissions`
 * from `commands.ts` (§3.5), which is a command definition's *declared*
 * allow/deny list where an empty `allowed` means no tools at all. This type is a
 * narrowing of what the app already permits, so `null` means inherit rather than
 * forbid. Two different questions, two names: a launch choice that a human made
 * for one run, against a definition's standing declaration.
 */
export interface SessionToolPermissions {
  /**
   * Null inherits the app's tools; a list narrows them. A session can be
   * launched narrower than the app (§3.6) — never wider, which
   * `checkToolPermissions` enforces rather than documents.
   */
  readonly allowedTools: readonly string[] | null;
}

export const INHERIT_APP_TOOLS: SessionToolPermissions = { allowedTools: null };

export type ToolPermissionRefusal = {
  readonly reason: "widens_app";
  readonly message: string;
  readonly tools: readonly string[];
};

export type ToolPermissionCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: ToolPermissionRefusal };

export function checkToolPermissions(
  app: SessionToolPermissions,
  session: SessionToolPermissions,
): ToolPermissionCheck {
  if (app.allowedTools === null) return { allowed: true };
  if (session.allowedTools === null) return { allowed: true };

  const appTools = new Set(app.allowedTools);
  const widened = session.allowedTools.filter((tool) => !appTools.has(tool));
  if (widened.length === 0) return { allowed: true };

  return {
    allowed: false,
    refusal: {
      reason: "widens_app",
      message:
        "a session is launched narrower than the app, never wider; remove the extra tools",
      tools: widened,
    },
  };
}

export interface RuntimeStartConfig {
  /** Assembled content (§3.5). The adapter never assembles or widens anything. */
  readonly prompt: string;
  readonly launch: SessionLaunchChoices;
  /** Absolute path of the workspace the session may touch (§3.4). */
  readonly workspacePath: string;
  /**
   * A transcript prefix to seed a new native session with, used when
   * `capabilities.fork` cannot fork from the requested point (§6.3).
   */
  readonly seedTranscript?: string;
}

export interface RuntimeResumeConfig {
  readonly launch: SessionLaunchChoices;
  readonly workspacePath: string;
}

/** Where in PlotRoom's own transcript record a fork starts (§6.3). */
export interface TranscriptPoint {
  /** 1-based turn ordinal; the fork inherits everything up to and including it. */
  readonly turn: number;
}

export interface InjectedInput {
  readonly id: InjectionId;
  readonly text: string;
}

/**
 * Returned by `inject()` — proof the runtime took the input into its queue,
 * not proof it was consumed. Delivery arrives later as an observation (§6.5).
 */
export interface InjectionReceipt {
  readonly id: InjectionId;
  readonly queuedAt: EpochMillis;
}

export type RuntimeRequest =
  /** A tool the runtime wants to run; PlotRoom answers from approvals (§6.6) and claims (§3.4). */
  | {
      readonly kind: "tool-permission";
      readonly toolName: string;
      readonly input: unknown;
    }
  /** A structured question for the human (§6.4). */
  | {
      readonly kind: "question";
      readonly text: string;
      readonly options: readonly string[];
    };

export type RequestOutcome =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "answer"; readonly value: string };

export interface TurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** Present only when capabilities.reportsCost. */
  readonly costUsd?: number;
  /** Present only when capabilities.reportsContextWindow. */
  readonly contextWindow?: {
    readonly usedTokens: number;
    readonly maxTokens: number;
  };
}

/**
 * Why a native session's stream ended, as far as the adapter can observe.
 *
 * Reconciled with the end-state taxonomy (§3.6, principle 11): the draft in
 * decision 0001 carried `stopped: { by: "user" | "budget" }` and no
 * interruption, which disagreed with its own note that a budget stop is a
 * distinct outcome. So:
 *
 * - `out-of-budget` is its own kind, and an adapter may never report it —
 *   PlotRoom initiates budget stops, so it is PlotRoom that records them
 *   (`isAdapterReportable` is the check).
 * - `interrupted` exists here because a stream that dies with the process is
 *   exactly the observation a crash produces; it is neither stopped nor failed.
 * - `ended-by-user` is distinguished from `stopped`: an open session the user
 *   ended is not a stop of running work (§3.5, §3.6).
 *
 * `SessionEndReason` is the runtime's report; `SessionEnd` is PlotRoom's
 * record, and `classifyEnd` is the only place one becomes the other.
 */
export type SessionEndReason =
  | { readonly kind: "completed" }
  | { readonly kind: "ended-by-user" }
  | { readonly kind: "stopped"; readonly by: "user" | "session" }
  | { readonly kind: "out-of-budget"; readonly scope: BudgetScope }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "interrupted"; readonly message: string };

/** Everything an adapter may legitimately claim to have observed. */
export const ADAPTER_REPORTABLE_END_KINDS = [
  "completed",
  "ended-by-user",
  "stopped",
  "failed",
  "interrupted",
] as const;

export function isAdapterReportable(reason: SessionEndReason): boolean {
  return reason.kind !== "out-of-budget";
}

/**
 * What the session was launched to produce, and whether the world agrees it did
 * (principle 3, §3.5).
 *
 * A producing command declares an outcome and optionally world conditions; the
 * session ends when the outcome is submitted *and* the conditions hold. An open
 * command declares nothing, so there is nothing to prove — which is why the two
 * lifecycles are different shapes here rather than one shape with a flag.
 */
export type CompletionEvidence =
  | {
      readonly lifecycle: "producing";
      /** Did the session actually submit its declared outcome? */
      readonly outcomeSubmitted: boolean;
      /** Declared conditions checked against the world and found false (§3.5). */
      readonly failedConditionIds: readonly string[];
    }
  | { readonly lifecycle: "open" };

export const UNPROVEN_COMPLETION_REASONS = [
  /** The runtime said it finished without submitting the declared outcome. */
  "not_submitted",
  /** The outcome was submitted but a declared world condition is false. */
  "conditions_failed",
  /** An open session has no outcome, so completion is not a thing it can claim. */
  "no_declared_outcome",
  /** Nobody supplied evidence, so all there is is the agent's own word. */
  "no_evidence",
] as const;

export type UnprovenCompletionReason =
  (typeof UNPROVEN_COMPLETION_REASONS)[number];

export type ProvenCompletionCheck =
  | { readonly proven: true }
  | {
      readonly proven: false;
      readonly reason: UnprovenCompletionReason;
      readonly message: string;
      readonly failedConditionIds: readonly string[];
    };

/**
 * Principle 3 as a predicate: "whether work got done is decided by checking the
 * world — an artifact exists and validates, a pull request is open, checks are
 * green — never by an agent's own statement that it finished."
 *
 * This is the rule the run loop shares with `classifyEnd`: the same answer decides
 * whether to record a completion and whether to hand the failing condition back
 * as feedback and let the session continue within its budget (§3.5).
 */
export function checkProvenCompletion(
  evidence?: CompletionEvidence,
): ProvenCompletionCheck {
  if (evidence === undefined) {
    return {
      proven: false,
      reason: "no_evidence",
      message:
        "completion was reported but never proven: no completion evidence was supplied, so this is the agent's own word (principle 3)",
      failedConditionIds: [],
    };
  }
  if (evidence.lifecycle === "open") {
    return {
      proven: false,
      reason: "no_declared_outcome",
      message:
        "an open session declares no outcome, so it cannot complete; it ends when someone ends it (§3.5)",
      failedConditionIds: [],
    };
  }
  if (!evidence.outcomeSubmitted) {
    return {
      proven: false,
      reason: "not_submitted",
      message:
        "the session reported completion without submitting its declared outcome (principle 3)",
      failedConditionIds: [],
    };
  }
  if (evidence.failedConditionIds.length > 0) {
    return {
      proven: false,
      reason: "conditions_failed",
      message: `the declared outcome was submitted but these world conditions are false: ${evidence.failedConditionIds.join(", ")}`,
      failedConditionIds: evidence.failedConditionIds,
    };
  }
  return { proven: true };
}

/**
 * PlotRoom's state wins over the runtime's report.
 *
 * A runtime that was stopped because the budget ran out sees a user-initiated
 * abort and will happily call it `stopped` — or, if the abort raced a crash,
 * `failed`. The outcome is out-of-budget either way: PlotRoom initiated it, so
 * PlotRoom names it (§3.6, §8).
 */
export interface EndClassificationContext {
  /** PlotRoom stopped this session because a budget was exhausted. */
  readonly budgetStop?: { readonly scope: BudgetScope };
  /** The server restarted while this session was in flight (principle 11). */
  readonly interrupted?: { readonly message: string };
  /**
   * What the world says about the declared outcome (principle 3). Supplying it is
   * how a `completed` becomes recordable: **absent evidence is not proof**, so a
   * reported completion with none is recorded as a failure that says exactly that
   * rather than as a completion nobody checked.
   */
  readonly completion?: CompletionEvidence;
}

/**
 * The runtime's report becomes PlotRoom's record here, and nowhere else — which
 * is why the proven-completion clause lives here too. A driver that decided
 * "completed" for itself would be principle 3 as driver code, true in one path and
 * false in the next.
 */
export function classifyEnd(
  reason: SessionEndReason,
  at: number,
  context: EndClassificationContext = {},
): SessionEnd {
  if (context.budgetStop) {
    return { kind: "out-of-budget", scope: context.budgetStop.scope, at };
  }
  if (context.interrupted) {
    return { kind: "interrupted", message: context.interrupted.message, at };
  }

  switch (reason.kind) {
    case "completed": {
      const proof = checkProvenCompletion(context.completion);
      if (proof.proven) return { kind: "completed", at };
      // An open session had nothing to prove: its end is the end an open session
      // has (§3.5), not a failure. Anything else is work reported done that the
      // world does not agree is done.
      return proof.reason === "no_declared_outcome"
        ? { kind: "ended-by-user", at }
        : { kind: "failed", message: proof.message, at };
    }
    case "ended-by-user":
      return { kind: "ended-by-user", at };
    case "stopped":
      return { kind: "stopped", by: reason.by, at };
    case "out-of-budget":
      return { kind: "out-of-budget", scope: reason.scope, at };
    case "failed":
      return { kind: "failed", message: reason.message, at };
    case "interrupted":
      return { kind: "interrupted", message: reason.message, at };
  }
}

/**
 * Everything is timestamped by the adapter at observation time; PlotRoom
 * computes elapsed and time-since-last-activity itself (§3.6).
 */
export type RuntimeObservation = { readonly at: EpochMillis } & (
  | { readonly kind: "turn-started"; readonly turn: number }
  | { readonly kind: "reasoning-delta"; readonly text: string }
  | { readonly kind: "output-delta"; readonly text: string }
  | {
      readonly kind: "tool-started";
      readonly toolName: string;
      readonly callId: string;
      readonly input: unknown;
    }
  | {
      readonly kind: "tool-finished";
      readonly callId: string;
      readonly output: unknown;
      readonly isError: boolean;
    }
  | { readonly kind: "compaction-started" }
  | { readonly kind: "compaction-finished" }
  | {
      readonly kind: "request-raised";
      readonly requestId: RuntimeRequestId;
      readonly request: RuntimeRequest;
    }
  | {
      readonly kind: "request-settled";
      readonly requestId: RuntimeRequestId;
      readonly outcome: RequestOutcome;
    }
  | { readonly kind: "injection-delivered"; readonly injectionId: InjectionId }
  | {
      readonly kind: "turn-ended";
      readonly turn: number;
      readonly usage: TurnUsage;
    }
  | { readonly kind: "session-ended"; readonly reason: SessionEndReason }
  | {
      readonly kind: "runtime-error";
      readonly message: string;
      readonly fatal: boolean;
    }
);

export interface RuntimeSessionHandle {
  /** Opaque native identity, persisted in the session record. */
  readonly ref: RuntimeSessionRef;

  /**
   * The single stream PlotRoom derives everything from. Ends when the native
   * session ends; a crashed adapter never crashes the host, so failures arrive
   * as `runtime-error` / `session-ended` observations rather than as throws.
   */
  observations(): AsyncIterable<RuntimeObservation>;

  /**
   * Submit content mid-flight. Resolves as soon as the runtime has accepted the
   * input into its queue — NOT when consumed. Consumption is observed as an
   * `injection-delivered` observation carrying this receipt's id (§6.5).
   */
  inject(input: InjectedInput): Promise<InjectionReceipt>;

  /** Answer a runtime-raised request (§6.4, §6.6). */
  respond(requestId: RuntimeRequestId, outcome: RequestOutcome): Promise<void>;

  /**
   * "graceful" asks the runtime to wind down; "abort" terminates. Both end the
   * observation stream with a `session-ended` observation.
   */
  stop(mode: "graceful" | "abort"): Promise<void>;
}

export interface SessionRuntimeAdapter {
  readonly id: string;
  readonly capabilities: RuntimeCapabilities;

  start(config: RuntimeStartConfig): Promise<RuntimeSessionHandle>;

  resume(
    ref: RuntimeSessionRef,
    config: RuntimeResumeConfig,
  ): Promise<RuntimeSessionHandle>;

  /**
   * Fork natively where `capabilities.fork` allows. Where it does not, callers
   * go through `planFork`, which produces a seeded `start()` instead.
   */
  fork(
    ref: RuntimeSessionRef,
    point: TranscriptPoint,
    config: RuntimeStartConfig,
  ): Promise<RuntimeSessionHandle>;
}

/** Which adapter, and which native session, a PlotRoom session is bound to. */
export interface SessionRuntimeBinding {
  readonly adapterId: string;
  readonly ref: RuntimeSessionRef;
}

export type PermissionEnforcementRefusal = {
  readonly reason: "permissions_advisory_only";
  readonly message: string;
};

export type PermissionEnforcementCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: PermissionEnforcementRefusal };

/**
 * Decision 0001, C6: approvals (§6.6) and path claims (§3.4) must gate the
 * runtime, not advise it. A runtime that cannot refuse a tool call on the
 * host's word may not run work that depends on either.
 */
export function checkPermissionEnforcement(
  capabilities: RuntimeCapabilities,
): PermissionEnforcementCheck {
  if (capabilities.enforcesPermissions) return { allowed: true };

  return {
    allowed: false,
    refusal: {
      reason: "permissions_advisory_only",
      message:
        "this runtime cannot enforce tool permissions per call; approvals and claims would be advice, not gates",
    },
  };
}
