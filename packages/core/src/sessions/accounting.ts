import type { TurnUsage } from "./runtime.js";

/**
 * Accounting per session (§3.6): turns, elapsed, tokens, cost, time since last
 * activity, and a context-window meter with warning thresholds.
 *
 * PlotRoom aggregates; the adapter only reports what it observed for one turn
 * (decision 0001, "what PlotRoom owns vs what an adapter supplies"). Elapsed
 * and time-since-last-activity are computed against an injected clock, never a
 * stored duration, so a restart cannot lose them.
 */
export interface TokenTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export const ZERO_TOKENS: TokenTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function totalTokens(tokens: TokenTotals): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

/**
 * Where a cost number came from. Recorded because the two sources can
 * disagree, and a number that cannot name its source is not evidence
 * (decision 0001, "cost truth").
 */
export type CostBasis = "runtime-reported" | "priced-from-tokens" | "none";

/** USD per million tokens, PlotRoom's own table for runtimes that report none. */
export interface ModelPricing {
  readonly inputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
  readonly cacheReadPerMillionUsd: number;
  readonly cacheWritePerMillionUsd: number;
}

export interface ContextWindowMeter {
  readonly usedTokens: number;
  readonly maxTokens: number;
  /** Reported by the runtime, or estimated by PlotRoom from cumulative usage. */
  readonly basis: "reported" | "estimated";
}

export interface SessionAccounting {
  readonly turns: number;
  readonly startedAt: number;
  /** Advanced by every observation, not just turn boundaries (§3.6, §7.2). */
  readonly lastActivityAt: number;
  readonly tokens: TokenTotals;
  readonly costUsd: number;
  readonly costBasis: CostBasis;
  /** Null until anything is known about the window. */
  readonly contextWindow: ContextWindowMeter | null;
}

export function startAccounting(at: number): SessionAccounting {
  return {
    turns: 0,
    startedAt: at,
    lastActivityAt: at,
    tokens: ZERO_TOKENS,
    costUsd: 0,
    costBasis: "none",
    contextWindow: null,
  };
}

export function priceUsage(usage: TurnUsage, pricing: ModelPricing): number {
  const perMillion = (tokens: number, rate: number) =>
    (tokens / 1_000_000) * rate;
  return (
    perMillion(usage.inputTokens, pricing.inputPerMillionUsd) +
    perMillion(usage.outputTokens, pricing.outputPerMillionUsd) +
    perMillion(usage.cacheReadTokens ?? 0, pricing.cacheReadPerMillionUsd) +
    perMillion(usage.cacheWriteTokens ?? 0, pricing.cacheWritePerMillionUsd)
  );
}

export interface AccountingContext {
  /** Used only when the runtime reports no cost of its own. */
  readonly pricing?: ModelPricing;
  /** Used only when the runtime reports no context-window occupancy. */
  readonly contextWindowTokens?: number;
}

/** Fold one observed turn into the session's running totals. */
export function applyTurnUsage(
  accounting: SessionAccounting,
  usage: TurnUsage,
  at: number,
  context: AccountingContext = {},
): SessionAccounting {
  const tokens: TokenTotals = {
    input: accounting.tokens.input + usage.inputTokens,
    output: accounting.tokens.output + usage.outputTokens,
    cacheRead: accounting.tokens.cacheRead + (usage.cacheReadTokens ?? 0),
    cacheWrite: accounting.tokens.cacheWrite + (usage.cacheWriteTokens ?? 0),
  };

  const reported = usage.costUsd;
  const priced = context.pricing ? priceUsage(usage, context.pricing) : null;
  const turnCost = reported ?? priced ?? 0;
  const costBasis: CostBasis =
    reported !== undefined
      ? "runtime-reported"
      : priced !== null
        ? "priced-from-tokens"
        : accounting.costBasis;

  return {
    turns: accounting.turns + 1,
    startedAt: accounting.startedAt,
    lastActivityAt: at,
    tokens,
    costUsd: accounting.costUsd + turnCost,
    costBasis,
    contextWindow: nextContextWindow(usage, tokens, context),
  };
}

function nextContextWindow(
  usage: TurnUsage,
  tokens: TokenTotals,
  context: AccountingContext,
): ContextWindowMeter | null {
  if (usage.contextWindow) {
    return {
      usedTokens: usage.contextWindow.usedTokens,
      maxTokens: usage.contextWindow.maxTokens,
      basis: "reported",
    };
  }

  if (context.contextWindowTokens === undefined) return null;

  // Estimated, and labelled as such: input plus output is what the next call
  // carries, cache reads are already counted inside the input figure.
  return {
    usedTokens: tokens.input + tokens.output,
    maxTokens: context.contextWindowTokens,
    basis: "estimated",
  };
}

/** Any observation is activity; silence is what health alerts watch (§7.2). */
export function touch(
  accounting: SessionAccounting,
  at: number,
): SessionAccounting {
  if (at <= accounting.lastActivityAt) return accounting;
  return { ...accounting, lastActivityAt: at };
}

export function elapsedSeconds(
  accounting: SessionAccounting,
  now: number,
): number {
  return Math.max(0, now - accounting.startedAt);
}

export function secondsSinceLastActivity(
  accounting: SessionAccounting,
  now: number,
): number {
  return Math.max(0, now - accounting.lastActivityAt);
}

export type ContextWindowLevel = "ok" | "warning" | "critical";

export interface ContextWindowThresholds {
  readonly warning: number;
  readonly critical: number;
}

/** Shipped defaults, so a session near its window is visible without setup. */
export const DEFAULT_CONTEXT_WINDOW_THRESHOLDS: ContextWindowThresholds = {
  warning: 0.75,
  critical: 0.9,
};

export function contextWindowFraction(meter: ContextWindowMeter): number {
  if (meter.maxTokens <= 0) return 0;
  return meter.usedTokens / meter.maxTokens;
}

export function contextWindowLevel(
  meter: ContextWindowMeter,
  thresholds: ContextWindowThresholds = DEFAULT_CONTEXT_WINDOW_THRESHOLDS,
): ContextWindowLevel {
  const fraction = contextWindowFraction(meter);
  if (fraction >= thresholds.critical) return "critical";
  if (fraction >= thresholds.warning) return "warning";
  return "ok";
}
