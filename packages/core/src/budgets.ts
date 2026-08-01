/**
 * Budgets (spec §8, principle 2, principle 11).
 *
 * "Budgets are the mechanism that makes agent-initiated work safe: a session can
 * see what remains of every budget that binds it and plan within it, and reaching
 * a cap cuts work off as its own outcome, distinct from failure, which a retry
 * must not blindly re-run."
 *
 * Three things about this module are the decisions, and everything else follows
 * from them:
 *
 * 1. **A budget binds transitively, and the tightest one wins.** A session is
 *    bound by every scope above it — the run or batch that initiated it, the
 *    workstream it runs in, the global ceiling — *and* by the same scopes of every
 *    ancestor in its initiation chain, because "its spend counts against every
 *    budget that binds the initiating work" (§3.6). What a session may still spend
 *    is therefore the **minimum remaining** over that whole set, never the sum and
 *    never the nearest one. {@link resolveEffectiveBudget} is that rule, stated
 *    once so the run path, the session-facing read, and the enforcement point
 *    cannot disagree (principle 8).
 * 2. **Reaching a cap is an outcome, not an error.** Nothing here throws: the
 *    state is `at-cap`, the tripped binding is named, and the caller records
 *    out-of-budget — a distinct end state (§3.6) — rather than a failure.
 * 3. **Near a cap the session is told, and told what to do.** "The defined
 *    behavior is to stop cleanly: wrap up, report, leave the workspace coherent",
 *    and "racing the budget — skipping verification to fit under it — is a failure
 *    mode, and the product's guidance to agents says so explicitly." That guidance
 *    is {@link BUDGET_GUIDANCE}, and it is part of the message rather than
 *    documentation nobody delivers.
 *
 * There is deliberately **no timer in any of this**. A daily period is a window
 * over the spend ledger evaluated at the moment of the check, never a scheduled
 * reset: nothing in the product wakes up because a budget did (principle 2).
 */

import type { BudgetScope } from "./sessions/end-states.js";
import { formatMicros } from "./runs.js";

/**
 * Over what stretch of spend a limit is measured.
 *
 * `total` is every dollar ever attributed to the scope; `day` is the current day
 * only. Both are queries over the attribution ledger at check time — the day
 * boundary is arithmetic on the clock, not an event.
 */
export const BUDGET_PERIODS = ["day", "total"] as const;

export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

/**
 * Where a budget came from. The shipped default global ceiling is the product's
 * own, and the distinction is recorded rather than inferred: an operator who
 * raised the ceiling should be able to tell their number from ours.
 */
export const BUDGET_ORIGINS = ["shipped-default", "authored"] as const;

export type BudgetOrigin = (typeof BUDGET_ORIGINS)[number];

/**
 * A budget the operator set (or the product shipped), at workstream or global
 * scope.
 *
 * The **run/batch scope has no row here** on purpose: a run's cap is the number
 * accepted at its preview and it is already recorded on the run
 * (`runs.spend_cap_micros`, §4.1). A second representation of the same cap is a
 * second source of truth waiting to disagree.
 */
export interface Budget {
  readonly id: string;
  /** `workstream` or `global`; a run's cap lives on the run. */
  readonly scope: Exclude<BudgetScope, "run">;
  /** The workstream a workstream budget binds; null for the global ceiling. */
  readonly workstreamId: string | null;
  /** Integer micros, like every other money value. Removing a budget deletes it. */
  readonly limitMicros: number;
  readonly period: BudgetPeriod;
  /** The fraction at which the session is told to wrap up (§8). */
  readonly warnFraction: number;
  readonly origin: BudgetOrigin;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * **The shipped default global ceiling** (§8): "a real number the operator can
 * raise or remove, not an empty field with a recommendation — because with agent
 * fan-out, one gesture can otherwise authorize unbounded spend."
 *
 * $25 per day, decided. Per day rather than in total because a lifetime global
 * ceiling stops being a safety net and becomes an expiry date — a number that
 * bricks the product in its second week is a number every operator removes on
 * day one, which is the same as shipping no ceiling at all. A day is also the
 * grain §8's fleet view already speaks in ("today's total"), so the ceiling and
 * the number beside it measure the same thing.
 *
 * $25 is chosen to be survivable rather than generous: enough that an ordinary
 * day of a few sessions never touches it, small enough that a fan-out bug is
 * caught while it is still an anecdote. The operator raises it with
 * `PUT /api/budgets` and removes it with `DELETE /api/budgets/:id`; both are
 * theirs alone, because a session raising the budget that binds it is exactly
 * what principle 1 forbids.
 */
export const DEFAULT_GLOBAL_CEILING_MICROS = 25_000_000;

export const DEFAULT_GLOBAL_BUDGET_PERIOD: BudgetPeriod = "day";

/**
 * Where "near a cap" starts (§8). Configurable per budget; this is what a budget
 * that names no threshold gets. Nine tenths leaves a real turn's worth of room to
 * wrap up in, which is what the warning is for — a warning at 99% is a stop with
 * extra steps.
 */
export const DEFAULT_BUDGET_WARN_FRACTION = 0.9;

/**
 * The start of the day a moment falls in, in UTC seconds.
 *
 * UTC rather than the host's zone, stated rather than assumed: a boundary that
 * moved with the machine's locale would make "today's total" disagree between the
 * server and a remote renderer (§12). A configurable accounting timezone is a
 * settings question (Epic 8.3), not a budget one.
 */
export function dayStartSeconds(nowSeconds: number): number {
  const day = 24 * 60 * 60;
  return Math.floor(nowSeconds / day) * day;
}

/** The window a period covers, as a lower bound on attribution timestamps. */
export function periodStartSeconds(
  period: BudgetPeriod,
  nowSeconds: number,
): number | null {
  return period === "day" ? dayStartSeconds(nowSeconds) : null;
}

/**
 * What kind of thing a binding is. Finer than {@link BudgetScope} because §8's
 * "a single run or batch" is one scope with two shapes, and a session told it ran
 * out needs to know which one to ask the operator about.
 */
export const BUDGET_BINDING_KINDS = [
  "run",
  "batch",
  "workstream",
  "global",
] as const;

export type BudgetBindingKind = (typeof BUDGET_BINDING_KINDS)[number];

/**
 * One budget that binds a session, with what has been charged against it.
 *
 * `chargedSessionId` is why this is transitive: a binding may belong to an
 * *ancestor's* run, in which case what it counts is that ancestor's attributed
 * total — its own work plus everything its chain delegated. A child that cannot
 * see that binding could spend its parent's cap without ever exceeding its own.
 */
export interface BudgetBinding {
  readonly kind: BudgetBindingKind;
  readonly scope: BudgetScope;
  /** The run, batch, workstream, or budget row this cap comes from. */
  readonly id: string;
  /** What a surface calls it, so a refusal reads as a sentence (§8). */
  readonly label: string;
  readonly limitMicros: number;
  readonly spentMicros: number;
  readonly warnFraction: number;
  readonly period: BudgetPeriod;
  /** The session whose attributed total this binding counts, when it is one. */
  readonly chargedSessionId: string | null;
}

export const BUDGET_STATES = [
  /** Nothing binds this work: no cap at any scope. */
  "unbounded",
  "ok",
  /** Past the warn threshold: the session is told to wrap up cleanly (§8). */
  "near-cap",
  /** The money ran out. PlotRoom stops the session as out-of-budget (§3.6). */
  "at-cap",
] as const;

export type BudgetState = (typeof BUDGET_STATES)[number];

export interface EffectiveBudget {
  /** Every binding, so a surface can show *why* the tightest one is tightest. */
  readonly bindings: readonly BudgetBinding[];
  /** The one with the least left. Null exactly when nothing binds. */
  readonly tightest: BudgetBinding | null;
  /** Never negative: a cap overshot by a final turn is exhausted, not owed. */
  readonly remainingMicros: number | null;
  /** How much of the tightest binding is spent, 0..1; null when nothing binds. */
  readonly fraction: number | null;
  readonly state: BudgetState;
  /** The sentence a session or a card reads (§8). */
  readonly description: string;
}

/**
 * The product's standing instruction about spending, delivered with every
 * near-cap warning rather than left in documentation an agent never reads.
 *
 * §8 names the failure mode explicitly, so the guidance does too: the thing to do
 * with a nearly-empty budget is finish cleanly and report, not sprint.
 */
export const BUDGET_GUIDANCE =
  "Wrap up cleanly: finish or safely stop what you are doing, leave the workspace coherent, " +
  "and report what is done and what is not. Do not race the budget — skipping verification " +
  "to fit under it is a failure mode, not a saving.";

/**
 * The rule: a session may spend what the *tightest* budget binding it leaves.
 *
 * Ties go to the first binding at the tighter scope, which is the order callers
 * build the list in (run, then batch, then workstream, then global), so a
 * refusal names the most specific cap that could have been raised.
 */
export function resolveEffectiveBudget(
  bindings: readonly BudgetBinding[],
): EffectiveBudget {
  if (bindings.length === 0) {
    return {
      bindings,
      tightest: null,
      remainingMicros: null,
      fraction: null,
      state: "unbounded",
      description:
        "no budget binds this work: no run cap was accepted, and no workstream or global ceiling is set",
    };
  }

  let tightest = bindings[0] as BudgetBinding;
  for (const binding of bindings) {
    if (remainingOf(binding) < remainingOf(tightest)) tightest = binding;
  }

  const remainingMicros = remainingOf(tightest);
  const fraction = fractionOf(tightest);
  const state = stateOf(remainingMicros, fraction, tightest.warnFraction);

  return {
    bindings,
    tightest,
    remainingMicros,
    fraction,
    state,
    description: describeBinding(tightest, state),
  };
}

function stateOf(
  remainingMicros: number,
  fraction: number,
  warnFraction: number,
): BudgetState {
  if (remainingMicros <= 0) return "at-cap";
  return fraction >= warnFraction ? "near-cap" : "ok";
}

/** Never negative: past a cap the answer is "nothing left", not a debt. */
function remainingOf(binding: BudgetBinding): number {
  return Math.max(0, binding.limitMicros - binding.spentMicros);
}

function fractionOf(binding: BudgetBinding): number {
  if (binding.limitMicros <= 0) return 1;
  return Math.min(1, binding.spentMicros / binding.limitMicros);
}

function periodWords(binding: BudgetBinding): string {
  return binding.period === "day" ? " today" : "";
}

function describeBinding(binding: BudgetBinding, state: BudgetState): string {
  const spent = `${formatMicros(binding.spentMicros)} of ${formatMicros(binding.limitMicros)}`;
  return state === "at-cap"
    ? `the ${binding.label} budget is exhausted: ${spent} spent${periodWords(binding)}`
    : `${formatMicros(remainingOf(binding))} left of the ${binding.label} budget (${spent} spent${periodWords(binding)})`;
}

/**
 * What PlotRoom tells a session that is nearly out of money (§8).
 *
 * One message, so the wording cannot differ between the run path and a tool
 * response: the number, then the instruction, then why racing it is worse.
 */
export function budgetWarningText(effective: EffectiveBudget): string {
  if (effective.tightest === null) return BUDGET_GUIDANCE;
  return (
    `Budget warning: ${effective.description}. ` +
    `${BUDGET_GUIDANCE} ` +
    `You can read what remains at any time; only the operator can raise this cap.`
  );
}

/** What PlotRoom tells the chain above a session it stopped (§8, §3.6). */
export function budgetStopNotice(
  stoppedSessionId: string,
  binding: BudgetBinding,
): string {
  return (
    `Session ${stoppedSessionId} was stopped out of budget: the ${binding.label} budget is exhausted ` +
    `(${formatMicros(binding.spentMicros)} of ${formatMicros(binding.limitMicros)} spent${periodWords(binding)}). ` +
    "It did not fail and nobody stopped it — the money ran out, and a retry must not blindly re-run it. " +
    BUDGET_GUIDANCE
  );
}
