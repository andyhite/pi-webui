import { Hono } from "hono";
import { dayStartSeconds, formatMicros } from "@plotroom/core";
import type { BudgetService } from "../budgets/service.js";
import { param, type ApiEnv, type ApiStores } from "./api.js";

/**
 * Spend, attributed (§3.6, §8, principle 2).
 *
 * "Every delegated or dispatched session is visible on the graph with its
 * provenance... its spend counts against every budget that binds the initiating
 * work." These are the reads over that ledger. **Enforcement is Phase 6's** —
 * nothing here refuses anything — but the data exists from the first delegation
 * rather than being retrofitted onto a history that never recorded it, for the
 * same reason §15-1 records a run whole.
 *
 * Money is integer micros everywhere, with a formatted string beside it rather
 * than instead of it: a surface that had to parse "$0.02" back into a number is a
 * surface that will get it wrong.
 */
export function spendRoutes(
  stores: ApiStores,
  budgets: BudgetService,
  limit: number,
): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  /**
   * What one session's budgets must count: its own work plus everything its
   * delegates spent. The rows are returned too, because "which descendant cost
   * this" is the question a total cannot answer.
   */
  app.get("/sessions/:id/spend", (c) => {
    const id = param(c, "id");
    // Reads through the store so a session that does not exist is a 404 from the
    // same place every other session read reports one.
    stores.sessions.get(id);
    const total = stores.spend.sessionTotal(id);

    return c.json({
      sessionId: id,
      attributedMicros: total.amountMicros,
      attributed: formatMicros(total.amountMicros),
      sources: total.sources,
      entries: stores.spend.forSession(id),
    });
  });

  /**
   * A workstream's total: every session in it, counted once. `own` rows only —
   * summing the `descendant` rows as well would count a delegated dollar once
   * per ancestor, which is right for one session's budget and wrong for a
   * workstream's.
   */
  app.get("/workstreams/:id/spend", (c) => {
    const id = param(c, "id");
    const total = stores.spend.workstreamTotal(id);

    return c.json({
      workstreamId: id,
      spentMicros: total.amountMicros,
      spent: formatMicros(total.amountMicros),
      sessions: total.sources,
    });
  });

  /**
   * The fleet's total (§8). Everything ever spent, and today's separately — both,
   * because "totals do not reset when sessions end" and "today's total" are two
   * different numbers and a panel showing one labelled as the other would be
   * wrong twice a day.
   */
  app.get("/spend", (c) => {
    const total = stores.spend.fleetTotal();
    const today = stores.spend.todayTotal();

    return c.json({
      spentMicros: total.amountMicros,
      spent: formatMicros(total.amountMicros),
      sessions: total.sources,
      today: {
        spentMicros: today.amountMicros,
        spent: formatMicros(today.amountMicros),
        sessions: today.sources,
      },
    });
  });

  /**
   * **The fleet view** (§8, §11): "today's total, the biggest spender, and running
   * sessions against the concurrency limit."
   *
   * The data behind §11's Fleet panel, which is Track B's to render. Everything
   * here is a read over records that already exist — the spend ledger, the session
   * store, and the configured limit — so it works for a fleet that has finished
   * exactly as well as for one that is running (§8's post-mortem requirement
   * applied to the fleet rather than to one session).
   */
  app.get("/fleet", (c) => {
    const today = stores.spend.todayTotal();
    const total = stores.spend.fleetTotal();
    const todayBySession = stores.spend.bySession({
      since: dayStartSeconds(stores.clock()),
    });
    const biggest = todayBySession[0] ?? null;

    const sessions = stores.sessions.list();
    const running = sessions.filter(
      (stored) => stored.session.end === null,
    ).length;

    return c.json({
      today: {
        spentMicros: today.amountMicros,
        spent: formatMicros(today.amountMicros),
        sessions: today.sources,
      },
      allTime: {
        spentMicros: total.amountMicros,
        spent: formatMicros(total.amountMicros),
      },
      // Null rather than a zero-spend placeholder: nothing has spent anything
      // today, and naming an arbitrary session as the biggest spender of $0 would
      // be a number that looks like evidence (principle 7).
      biggestSpender:
        biggest === null
          ? null
          : {
              sessionId: biggest.sessionId,
              workstreamId: biggest.workstreamId,
              spentMicros: biggest.amountMicros,
              spent: formatMicros(biggest.amountMicros),
            },
      concurrency: {
        running,
        limit,
        // The queue's own count, not a guess from the difference: work waiting is
        // admitted work, and it is visible (§4.1).
        queued: stores.queue.waiting().length,
      },
      budgets: budgets.budgets().map((entry) => ({
        budget: entry.budget,
        spentMicros: entry.spentMicros,
        remainingMicros: entry.remainingMicros,
        remaining: formatMicros(entry.remainingMicros),
      })),
    });
  });

  return app;
}
