import { describe, expect, it } from "vitest";

import {
  budgetStopNotice,
  budgetWarningText,
  dayStartSeconds,
  periodStartSeconds,
  resolveEffectiveBudget,
  BUDGET_GUIDANCE,
  DEFAULT_BUDGET_WARN_FRACTION,
  DEFAULT_GLOBAL_CEILING_MICROS,
  type BudgetBinding,
} from "./budgets.js";

/**
 * The budget rule (§8, principle 2).
 *
 * What is asserted here is the rule itself, not a store's rendering of it: the
 * tightest binding wins, reaching a cap is an outcome rather than an error, and
 * near a cap the session is told what to do rather than merely how much is left.
 */
const binding = (over: Partial<BudgetBinding> = {}): BudgetBinding => ({
  kind: "global",
  scope: "global",
  id: "budget_global",
  label: "global daily ceiling",
  limitMicros: 1_000_000,
  spentMicros: 0,
  warnFraction: DEFAULT_BUDGET_WARN_FRACTION,
  period: "day",
  chargedSessionId: null,
  ...over,
});

describe("resolveEffectiveBudget", () => {
  it("says nothing binds when nothing does — and does not invent a number", () => {
    const effective = resolveEffectiveBudget([]);

    expect(effective.state).toBe("unbounded");
    expect(effective.tightest).toBeNull();
    // Null rather than zero or Infinity: a surface cannot accidentally render
    // "0 left" for work nothing bounds.
    expect(effective.remainingMicros).toBeNull();
    expect(effective.fraction).toBeNull();
  });

  it("picks the binding with the least left, whatever scope it is", () => {
    const effective = resolveEffectiveBudget([
      binding({
        kind: "run",
        scope: "run",
        id: "run_1",
        label: "run 1",
        limitMicros: 5_000_000,
        spentMicros: 1_000_000,
      }),
      binding({
        kind: "workstream",
        scope: "workstream",
        id: "ws_1",
        label: "workstream",
        limitMicros: 2_000_000,
        spentMicros: 1_900_000,
      }),
      binding({ limitMicros: 10_000_000, spentMicros: 0 }),
    ]);

    expect(effective.tightest?.id).toBe("ws_1");
    expect(effective.remainingMicros).toBe(100_000);
    // 95% of the workstream budget: past the threshold, so the session is told.
    expect(effective.state).toBe("near-cap");
  });

  it("is at-cap when the tightest binding is exhausted, and never owes money", () => {
    const effective = resolveEffectiveBudget([
      binding({ limitMicros: 1_000_000, spentMicros: 1_500_000 }),
    ]);

    expect(effective.state).toBe("at-cap");
    // Overshooting a cap by a final turn leaves nothing left, not a debt.
    expect(effective.remainingMicros).toBe(0);
    expect(effective.description).toContain("exhausted");
  });

  it("honours a per-budget warn threshold rather than one global constant", () => {
    const early = resolveEffectiveBudget([
      binding({ spentMicros: 600_000, warnFraction: 0.5 }),
    ]);
    const late = resolveEffectiveBudget([
      binding({ spentMicros: 600_000, warnFraction: 0.95 }),
    ]);

    expect(early.state).toBe("near-cap");
    expect(late.state).toBe("ok");
  });

  it("prefers the tighter scope when two bindings leave exactly the same", () => {
    // Callers build the list run → batch → workstream → global, so a tie names
    // the most specific cap that could have been raised.
    const effective = resolveEffectiveBudget([
      binding({ kind: "run", scope: "run", id: "run_1", label: "run 1" }),
      binding(),
    ]);

    expect(effective.tightest?.id).toBe("run_1");
  });

  it("reports a zero-limit budget as at-cap rather than dividing by zero", () => {
    const effective = resolveEffectiveBudget([binding({ limitMicros: 0 })]);

    expect(effective.state).toBe("at-cap");
    expect(effective.fraction).toBe(1);
  });
});

describe("what a session is told", () => {
  it("names the remaining budget and says racing it is a failure mode (§8)", () => {
    const effective = resolveEffectiveBudget([
      binding({ spentMicros: 950_000 }),
    ]);
    const warning = budgetWarningText(effective);

    expect(warning).toContain("$0.05");
    expect(warning).toContain("Wrap up cleanly");
    expect(warning).toContain("Do not race the budget");
    expect(warning).toContain("only the operator can raise this cap");
  });

  it("still states the guidance when nothing binds", () => {
    expect(budgetWarningText(resolveEffectiveBudget([]))).toBe(BUDGET_GUIDANCE);
  });

  it("tells the chain a stop was not a failure (§3.6)", () => {
    const notice = budgetStopNotice(
      "sess_child",
      binding({ limitMicros: 1_000_000, spentMicros: 1_000_000 }),
    );

    expect(notice).toContain("sess_child");
    expect(notice).toContain("out of budget");
    expect(notice).toContain("did not fail");
    expect(notice).toContain("must not blindly re-run");
  });
});

describe("periods", () => {
  it("floors to the UTC day, so a total and a ceiling measure the same day", () => {
    const noon = Date.UTC(2025, 0, 15, 12, 30, 0) / 1000;
    const midnight = Date.UTC(2025, 0, 15, 0, 0, 0) / 1000;

    expect(dayStartSeconds(noon)).toBe(midnight);
    expect(dayStartSeconds(midnight)).toBe(midnight);
    expect(periodStartSeconds("day", noon)).toBe(midnight);
  });

  it("has no lower bound for a total period — nothing is ever forgotten", () => {
    expect(periodStartSeconds("total", 1_000_000)).toBeNull();
  });
});

describe("the shipped default ceiling", () => {
  it("is a real number, not zero and not absent (§8, principle 2)", () => {
    // "The product ships with a default global ceiling — a real number the
    // operator can raise or remove, not an empty field with a recommendation."
    expect(DEFAULT_GLOBAL_CEILING_MICROS).toBe(25_000_000);
    expect(DEFAULT_GLOBAL_CEILING_MICROS).toBeGreaterThan(0);
  });
});
