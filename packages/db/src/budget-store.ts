import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  DEFAULT_BUDGET_WARN_FRACTION,
  systemClock,
  type Budget,
  type BudgetBindingKind,
  type BudgetPeriod,
  type Clock,
} from "@plotroom/core";
import type { DrizzleRunChanges, PlotroomDatabase } from "./client.js";
import { budgetNotices, budgets } from "./schema.js";

/**
 * Budgets at rest (§8, migrations 20).
 *
 * Every rule about budgets is `@plotroom/core`'s — which one binds, which is
 * tightest, what "near a cap" means. This store keeps the rows and answers two
 * questions nothing else can: what budgets exist, and what a session has already
 * been told about one.
 *
 * The **shipped default global ceiling is a row**, seeded by the migration rather
 * than resolved at read time. That is what makes §8's "a real number the operator
 * can raise or remove, not an empty field" literal: it is visible in a list, it is
 * editable, and deleting it stays deleted across restarts. A ceiling resolved from
 * a constant when no row existed could never be removed at all.
 */
export interface SetBudgetInput {
  readonly scope: Budget["scope"];
  /** Required for a workstream budget, refused for the global ceiling. */
  readonly workstreamId?: string | null;
  readonly limitMicros: number;
  readonly period?: BudgetPeriod;
  readonly warnFraction?: number;
}

/** What a session has already been told, so it is never told twice (§8). */
export interface BudgetNotice {
  readonly id: string;
  readonly sessionId: string;
  readonly bindingKind: BudgetBindingKind;
  readonly bindingId: string;
  readonly kind: "near-cap" | "stopped";
  readonly remainingMicros: number;
  readonly at: number;
}

export class BudgetStore {
  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {}

  /** Every budget, narrowest scope first: the order a refusal names caps in. */
  list(): Budget[] {
    return this.state.db
      .select()
      .from(budgets)
      .all()
      .map((row) => toBudget(row))
      .sort((a, b) => scopeRank(a) - scopeRank(b));
  }

  get(id: string): Budget | null {
    const row = this.state.db
      .select()
      .from(budgets)
      .where(eq(budgets.id, id))
      .get();
    return row === undefined ? null : toBudget(row);
  }

  /** The ceiling that binds everything (§8). Null only if the operator removed it. */
  global(): Budget | null {
    const row = this.state.db
      .select()
      .from(budgets)
      .where(and(eq(budgets.scope, "global"), isNull(budgets.workstreamId)))
      .get();
    return row === undefined ? null : toBudget(row);
  }

  forWorkstream(workstreamId: string): Budget | null {
    const row = this.state.db
      .select()
      .from(budgets)
      .where(eq(budgets.workstreamId, workstreamId))
      .get();
    return row === undefined ? null : toBudget(row);
  }

  /**
   * Set or replace the budget at one scope.
   *
   * One row per scope target, so raising a ceiling is an update rather than a
   * second row that would make "the tightest budget wins" a rule about rows. A
   * budget the operator sets is `authored` even where it replaces the shipped
   * default: after they have chosen a number, it is theirs.
   */
  set(input: SetBudgetInput): Budget {
    const at = this.now();
    const existing =
      input.scope === "global"
        ? this.global()
        : this.forWorkstream(requireWorkstream(input));

    const values = {
      scope: input.scope,
      workstreamId: input.scope === "global" ? null : requireWorkstream(input),
      limitMicros: input.limitMicros,
      period: input.period ?? (input.scope === "global" ? "day" : "total"),
      warnFraction: input.warnFraction ?? DEFAULT_BUDGET_WARN_FRACTION,
      origin: "authored" as const,
      updatedAt: at,
    };

    if (existing !== null) {
      this.state.db
        .update(budgets)
        .set(values)
        .where(eq(budgets.id, existing.id))
        .run();
      return this.require(existing.id);
    }

    const id = `budget_${randomUUID()}`;
    this.state.db
      .insert(budgets)
      .values({ id, ...values, createdAt: at })
      .run();
    return this.require(id);
  }

  /**
   * Remove a budget: §8's "or remove". The row goes; nothing is left behind
   * meaning "removed", because a second representation of "no cap" is how one
   * surface starts enforcing a ceiling another one thinks was deleted.
   */
  remove(id: string): Budget | null {
    const existing = this.get(id);
    if (existing === null) return null;
    this.state.db.delete(budgets).where(eq(budgets.id, id)).run();
    return existing;
  }

  /**
   * Record that a session was told something about a budget, once.
   *
   * Returns null when it has already been told — the caller reads that as "say
   * nothing", which is what keeps a restart between the warning and the cap from
   * warning twice.
   */
  recordNotice(input: {
    readonly sessionId: string;
    readonly bindingKind: BudgetBindingKind;
    readonly bindingId: string;
    readonly kind: "near-cap" | "stopped";
    readonly remainingMicros: number;
  }): BudgetNotice | null {
    const at = this.now();
    const id = `budgetnotice_${randomUUID()}`;
    const inserted = this.state.db
      .insert(budgetNotices)
      .values({ id, ...input, at })
      .onConflictDoNothing()
      .run() as unknown as DrizzleRunChanges;

    if (inserted.changes === 0) return null;
    return { id, ...input, at };
  }

  notices(sessionId: string): BudgetNotice[] {
    return this.state.db
      .select()
      .from(budgetNotices)
      .where(eq(budgetNotices.sessionId, sessionId))
      .orderBy(budgetNotices.at)
      .all()
      .map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        bindingKind: row.bindingKind,
        bindingId: row.bindingId,
        kind: row.kind,
        remainingMicros: row.remainingMicros,
        at: row.at,
      }));
  }

  private require(id: string): Budget {
    const budget = this.get(id);
    if (budget === null) {
      throw new Error(`budget ${id} was written but cannot be read back`);
    }
    return budget;
  }
}

function requireWorkstream(input: SetBudgetInput): string {
  const id = input.workstreamId;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("a workstream budget names the workstream it binds (§8)");
  }
  return id;
}

/** Workstream budgets before the global ceiling: narrowest scope first. */
function scopeRank(budget: Budget): number {
  return budget.scope === "workstream" ? 0 : 1;
}

function toBudget(row: {
  readonly id: string;
  readonly scope: "workstream" | "global";
  readonly workstreamId: string | null;
  readonly limitMicros: number;
  readonly period: BudgetPeriod;
  readonly warnFraction: number;
  readonly origin: "shipped-default" | "authored";
  readonly createdAt: number;
  readonly updatedAt: number;
}): Budget {
  return {
    id: row.id,
    scope: row.scope,
    workstreamId: row.workstreamId,
    limitMicros: row.limitMicros,
    period: row.period,
    warnFraction: row.warnFraction,
    origin: row.origin,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
