import {
  DEFAULT_BUDGET_WARN_FRACTION,
  budgetStopNotice,
  budgetWarningText,
  formatMicros,
  periodStartSeconds,
  resolveEffectiveBudget,
  type Budget,
  type BudgetBinding,
  type BudgetPeriod,
  type EffectiveBudget,
  type SessionId,
  type WorkstreamId,
} from "@plotroom/core";
import type { EventBus } from "../events/bus.js";
import type { Logger } from "../logging/logger.js";
import type { ApiStores } from "../routes/api.js";
import { attributionChain } from "../runs/delegation.js";

/**
 * Budget enforcement (spec §8, principle 2, principle 11).
 *
 * Three things live here and nothing else does:
 *
 * 1. **Which budgets bind a session**, which is the transitive part. A session is
 *    bound by the cap accepted for its own run *and by every ancestor's* — "its
 *    spend counts against every budget that binds the initiating work" (§3.6) — by
 *    each of those sessions' workstream budgets, and by the global ceiling. The
 *    spend ledger is the substrate: an ancestor's run cap counts that ancestor's
 *    attributed total, which already includes everything its chain delegated.
 * 2. **What the answer means**, which is `@plotroom/core`'s `resolveEffectiveBudget`
 *    and not restated here. This service gathers facts; the rule decides.
 * 3. **What has already been said**, so a session is told once per binding even
 *    across a restart (the notice ledger).
 *
 * What deliberately does *not* live here: stopping a session and delivering
 * feedback. Those are the run path's verbs and it owns them — a second place that
 * could end a session would be a second way for an end state to be recorded, which
 * is exactly what §3.6's taxonomy exists to prevent. This service says "at cap,
 * because of this binding"; `RunService` acts.
 */
export interface BudgetServiceDeps {
  readonly stores: ApiStores;
  readonly bus: EventBus;
  readonly logger: Logger;
}

/** A budget row with what its scope has spent against it, in its own period. */
export interface BudgetWithSpend {
  readonly budget: Budget;
  readonly spentMicros: number;
  readonly remainingMicros: number;
  readonly spent: string;
  readonly limit: string;
}

export class BudgetService {
  constructor(private readonly deps: BudgetServiceDeps) {}

  /* ------------------------------------------------------------------ reads */

  budgets(): readonly BudgetWithSpend[] {
    return this.deps.stores.budgets
      .list()
      .map((budget) => this.withSpend(budget));
  }

  withSpend(budget: Budget): BudgetWithSpend {
    const spentMicros = this.spentAgainst(budget);
    return {
      budget,
      spentMicros,
      remainingMicros: Math.max(0, budget.limitMicros - spentMicros),
      spent: formatMicros(spentMicros),
      limit: formatMicros(budget.limitMicros),
    };
  }

  /**
   * What binds a workstream's next run, before any session exists: its own budget
   * and the global ceiling. The run's own cap is not here — it is accepted at the
   * preview, so it cannot already be exhausted.
   */
  forWorkstream(workstreamId: string): EffectiveBudget {
    return resolveEffectiveBudget(this.scopeBindings(workstreamId));
  }

  /**
   * What binds one session — the answer §8 says a session may read: "a session can
   * see what remains of every budget that binds it and plan accordingly".
   *
   * Transitive by construction: the chain is walked, and each session in it
   * contributes its run's cap, its batch's cap, and its workstream's budget. A
   * child that could only see its own scopes could spend its parent's cap without
   * ever exceeding one of its own.
   */
  forSession(sessionId: string): EffectiveBudget {
    const { stores } = this.deps;
    const bindings: BudgetBinding[] = [];
    const chain = attributionChain(stores, sessionId);
    const workstreams = new Set<string>();

    for (const ancestor of chain) {
      const stored = stores.sessions.get(ancestor);
      workstreams.add(stored.session.workstreamId);
      bindings.push(...this.runBindings(ancestor, stored.runId));
    }

    for (const workstreamId of workstreams) {
      bindings.push(...this.scopeBindings(workstreamId, { global: false }));
    }

    // The global ceiling binds everything once, however many workstreams the
    // chain touched: repeating it would not change the answer but would make the
    // list read as several ceilings.
    const global = this.deps.stores.budgets.global();
    if (global !== null)
      bindings.push(this.bindingOf(global, "global", global.id));

    return resolveEffectiveBudget(bindings);
  }

  /* ------------------------------------------------------------- enforcement */

  /**
   * Whether a session has already been told this. Returns the text to deliver, or
   * null when it has been said — the notice ledger is what makes that survive a
   * restart, because a counter in memory cannot.
   */
  claimWarning(sessionId: string, effective: EffectiveBudget): string | null {
    const tightest = effective.tightest;
    if (tightest === null) return null;

    const recorded = this.deps.stores.budgets.recordNotice({
      sessionId,
      bindingKind: tightest.kind,
      bindingId: tightest.id,
      kind: "near-cap",
      remainingMicros: effective.remainingMicros ?? 0,
    });
    if (recorded === null) return null;

    this.deps.logger.info("session warned near its budget cap", {
      sessionId,
      binding: `${tightest.kind}:${tightest.id}`,
      remainingMicros: effective.remainingMicros,
    });
    return budgetWarningText(effective);
  }

  /** The same once-only ledger for the stop itself, so a chain is told once. */
  claimStopNotice(
    stoppedSessionId: string,
    informedSessionId: string,
    binding: BudgetBinding,
  ): string | null {
    const recorded = this.deps.stores.budgets.recordNotice({
      sessionId: informedSessionId,
      bindingKind: binding.kind,
      bindingId: binding.id,
      kind: "stopped",
      remainingMicros: 0,
    });
    if (recorded === null) return null;
    return budgetStopNotice(stoppedSessionId, binding);
  }

  /**
   * Every ancestor of a stopped session, so the chain that paid for it hears about
   * it (§8's "report"). The stopped session itself is excluded: it is being ended,
   * and telling it costs a turn it has no budget for.
   */
  ancestorsOf(sessionId: string): readonly SessionId[] {
    return attributionChain(this.deps.stores, sessionId).filter(
      (id) => id !== sessionId,
    );
  }

  /* --------------------------------------------------------------- publishing */

  publish(budget: Budget, verb: "created" | "updated"): void {
    this.deps.bus.publish({
      entity: "budget",
      verb,
      budget,
      spentMicros: this.spentAgainst(budget),
      author: { kind: "human" },
    });
  }

  publishRemoval(budget: Budget, reason: string): void {
    this.deps.bus.publish({
      entity: "budget",
      verb: "deleted",
      budgetId: budget.id,
      scope: budget.scope,
      workstreamId: budget.workstreamId as WorkstreamId | null,
      reason,
      author: { kind: "human" },
    });
  }

  /* ------------------------------------------------------------------ private */

  /** A run's cap, and its batch's, both of which are run-scope caps (§8). */
  private runBindings(
    sessionId: string,
    runId: string | null,
  ): readonly BudgetBinding[] {
    const { stores } = this.deps;
    const bindings: BudgetBinding[] = [];
    if (runId === null) return bindings;

    const run = stores.runs.run(runId);
    if (run.spendCapMicros !== null) {
      bindings.push({
        kind: "run",
        scope: "run",
        id: run.id,
        label: `run ${run.ordinal} of ${run.configuration.definitionName}`,
        limitMicros: run.spendCapMicros,
        // What the run's cap must count is what its session was charged: its own
        // work plus everything its chain delegated (§3.6).
        spentMicros: stores.spend.sessionTotal(sessionId).amountMicros,
        warnFraction: this.warnFraction(),
        period: "total",
        chargedSessionId: sessionId,
      });
    }

    const entry = stores.queue.entryForSession(sessionId);
    if (entry === undefined) return bindings;

    const batch = stores.queue.batch(entry.batchId);
    if (batch.spendCapMicros === null) return bindings;

    const sessions = stores.queue
      .entriesForBatch(batch.id)
      .map((one) => one.sessionId)
      .filter((one): one is string => one !== null);

    bindings.push({
      kind: "batch",
      scope: "run",
      id: batch.id,
      label: `the ${batch.scopeKind} batch`,
      limitMicros: batch.spendCapMicros,
      spentMicros: stores.spend.sessionsTotal(sessions).amountMicros,
      warnFraction: this.warnFraction(),
      period: "total",
      chargedSessionId: null,
    });

    return bindings;
  }

  /** A workstream's budget and (optionally) the global ceiling. */
  private scopeBindings(
    workstreamId: string,
    options: { readonly global?: boolean } = {},
  ): readonly BudgetBinding[] {
    const bindings: BudgetBinding[] = [];
    const workstream = this.deps.stores.budgets.forWorkstream(workstreamId);
    if (workstream !== null) {
      bindings.push(this.bindingOf(workstream, "workstream", workstreamId));
    }

    if (options.global === false) return bindings;

    const global = this.deps.stores.budgets.global();
    if (global !== null) {
      bindings.push(this.bindingOf(global, "global", global.id));
    }
    return bindings;
  }

  private bindingOf(
    budget: Budget,
    kind: "workstream" | "global",
    id: string,
  ): BudgetBinding {
    return {
      kind,
      scope: budget.scope,
      id,
      // Named rather than just "workstream": a chain can cross several, and a
      // refusal has to say which one to raise.
      label:
        kind === "global"
          ? `global ${budget.period === "day" ? "daily " : ""}ceiling`
          : `workstream ${id}`,
      limitMicros: budget.limitMicros,
      spentMicros: this.spentAgainst(budget),
      warnFraction: budget.warnFraction,
      period: budget.period,
      chargedSessionId: null,
    };
  }

  /**
   * What a budget's scope has spent inside its period. A window over the ledger,
   * taken at check time — there is no timer and nothing resets (principle 2).
   */
  private spentAgainst(budget: Budget): number {
    const since = periodStartSeconds(
      budget.period as BudgetPeriod,
      this.deps.stores.clock(),
    );
    const window = since === null ? {} : { since };

    return budget.scope === "global"
      ? this.deps.stores.spend.fleetTotal(window).amountMicros
      : this.deps.stores.spend.workstreamTotal(
          budget.workstreamId ?? "",
          window,
        ).amountMicros;
  }

  /**
   * A run cap's warn threshold. Run caps have no row of their own to carry one, so
   * they use the global ceiling's — the operator's one statement about how early
   * "near a cap" is, applied wherever a cap exists.
   */
  private warnFraction(): number {
    const global = this.deps.stores.budgets.global();
    return global?.warnFraction ?? DEFAULT_BUDGET_WARN_FRACTION;
  }
}
