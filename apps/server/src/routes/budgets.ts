import { Hono } from "hono";
import { z } from "zod";
import {
  BUDGET_GUIDANCE,
  BUDGET_PERIODS,
  formatMicros,
  type Budget,
} from "@plotroom/core";
import type { BudgetService, BudgetWithSpend } from "../budgets/service.js";
import { notFound, refused } from "../http/errors.js";
import { validateJsonBody } from "../http/validate.js";
import { body, param, type ApiEnv, type ApiStores } from "./api.js";

/**
 * Budgets, as endpoints (§8, principle 2).
 *
 * Two shapes of read and two verbs, and the split is the decision:
 *
 * - **the reads are for everyone**, including a session. "A session can see what
 *   remains of every budget that binds it and plan accordingly" (§8), so
 *   `GET /api/sessions/:id/budget` is an agent tool like any other read.
 * - **the writes are the operator's alone.** Principle 1: a session "cannot wire
 *   its own inputs, grant itself capabilities, [or] raise its own budget", and the
 *   safe half — lowering one — is not a gesture the spec asks for either. So there
 *   is no budget-writing tool in the catalog, and these two routes are declared
 *   operator-only rather than being left for the reflexivity check to argue about
 *   case by case.
 *
 * `DELETE` is how §8's "a real number the operator can raise or remove" is spelled:
 * removing a ceiling deletes the row. There is deliberately no second way to say
 * "no cap" — a nullable limit that also meant removed is how one surface starts
 * enforcing a ceiling another thinks is gone.
 */
const setBudgetBody = z.object({
  scope: z.enum(["workstream", "global"]),
  /** Required for a workstream budget; refused for the global ceiling. */
  workstreamId: z.string().min(1).optional(),
  /** Integer micros, like every other money value on the wire. */
  limitMicros: z.number().int().nonnegative(),
  period: z.enum(BUDGET_PERIODS).optional(),
  /** Where "near a cap" starts, 0..1 exclusive of zero (§8). */
  warnFraction: z.number().gt(0).lte(1).optional(),
});

export function budgetRoutes(
  stores: ApiStores,
  budgets: BudgetService,
): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  /**
   * Every budget with what has been spent against it, narrowest scope first — and
   * the shipped default global ceiling is in here on a fresh install, because it
   * is a row rather than a constant somewhere (§8).
   */
  app.get("/budgets", (c) =>
    c.json({
      budgets: budgets.budgets().map(describe),
      guidance: BUDGET_GUIDANCE,
    }),
  );

  /**
   * Set or raise a budget at one scope. The operator's alone (principle 1).
   *
   * `POST` on the collection rather than `PUT`, and it upserts: there is one budget
   * per scope target, so "set the global ceiling" and "raise the global ceiling"
   * are the same gesture with the same result, and the unique index is what makes
   * that true rather than this handler.
   */
  app.post("/budgets", validateJsonBody(setBudgetBody), (c) => {
    const input = body<z.infer<typeof setBudgetBody>>(c);

    if (input.scope === "global" && input.workstreamId !== undefined) {
      throw refused({
        reason: "global_budget_names_no_workstream",
        message:
          "the global ceiling binds everything and belongs to nothing; omit workstreamId (§8)",
      });
    }
    if (input.scope === "workstream") {
      if (input.workstreamId === undefined) {
        throw refused({
          reason: "workstream_budget_needs_workstream",
          message: "a workstream budget names the workstream it binds (§8)",
        });
      }
      requireWorkstream(stores, input.workstreamId);
    }

    const existing =
      input.scope === "global"
        ? stores.budgets.global()
        : stores.budgets.forWorkstream(input.workstreamId as string);

    const budget = stores.budgets.set({
      scope: input.scope,
      ...(input.workstreamId === undefined
        ? {}
        : { workstreamId: input.workstreamId }),
      limitMicros: input.limitMicros,
      ...(input.period === undefined ? {} : { period: input.period }),
      ...(input.warnFraction === undefined
        ? {}
        : { warnFraction: input.warnFraction }),
    });

    budgets.publish(budget, existing === null ? "created" : "updated");
    return c.json({ budget: describe(budgets.withSpend(budget)) }, 200);
  });

  /**
   * Remove a budget: §8's "or remove". Removing the shipped default ceiling is
   * allowed and stays removed — it is the operator's product — and the removal is
   * an event, because a surface showing "what may still be spent" has to hear that
   * the answer became "anything".
   */
  app.delete("/budgets/:id", (c) => {
    const id = param(c, "id");
    const removed = stores.budgets.remove(id);
    if (removed === null) throw notFound(`unknown budget ${id}`);

    budgets.publishRemoval(removed, "removed by the operator");
    return c.json({
      removed: { id: removed.id, scope: removed.scope },
      warning:
        removed.scope === "global"
          ? "no global ceiling is set: agent fan-out can now authorize unbounded spend (§8)"
          : null,
    });
  });

  /**
   * What binds one workstream: its own budget and the global ceiling, with what is
   * left. The same resolution a run of anything inside it will be measured
   * against, from the same function (principle 8).
   */
  app.get("/workstreams/:id/budget", (c) => {
    const id = param(c, "id");
    requireWorkstream(stores, id);
    return c.json({
      workstreamId: id,
      budget: budgets.forWorkstream(id),
      guidance: BUDGET_GUIDANCE,
    });
  });

  /**
   * **The session-facing read** (§8): "a session can see what remains of every
   * budget that binds it and plan accordingly."
   *
   * Every binding is returned, not only the tightest one, because "plan
   * accordingly" needs to know *which* cap is the constraint — a session near a
   * daily global ceiling and one near its own run cap should do different things.
   * The guidance travels with it: racing the budget is a failure mode, and saying
   * so only in a warning would mean a session that read this early never heard it.
   */
  app.get("/sessions/:id/budget", (c) => {
    const id = param(c, "id");
    stores.sessions.get(id);
    const effective = budgets.forSession(id);

    return c.json({
      sessionId: id,
      budget: effective,
      remaining:
        effective.remainingMicros === null
          ? null
          : formatMicros(effective.remainingMicros),
      notices: stores.budgets.notices(id),
      guidance: BUDGET_GUIDANCE,
    });
  });

  return app;
}

/** The same 404 every other workstream read reports (§3.3). */
function requireWorkstream(stores: ApiStores, id: string): void {
  if (stores.workstreams.get(id) === undefined) {
    throw notFound(`unknown workstream ${id}`);
  }
}

/** Money as micros *and* as text, never text instead of it. */
function describe(entry: BudgetWithSpend): {
  readonly budget: Budget;
  readonly spentMicros: number;
  readonly spent: string;
  readonly remainingMicros: number;
  readonly remaining: string;
  readonly limit: string;
} {
  return {
    budget: entry.budget,
    spentMicros: entry.spentMicros,
    spent: entry.spent,
    remainingMicros: entry.remainingMicros,
    remaining: formatMicros(entry.remainingMicros),
    limit: entry.limit,
  };
}
