import { Hono } from "hono";
import { formatMicros } from "@plotroom/core";
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
export function spendRoutes(stores: ApiStores): Hono<ApiEnv> {
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

  /** The fleet's total (§8's fleet panel: "today's total, biggest spender"). */
  app.get("/spend", (c) => {
    const total = stores.spend.fleetTotal();

    return c.json({
      spentMicros: total.amountMicros,
      spent: formatMicros(total.amountMicros),
      sessions: total.sources,
    });
  });

  return app;
}
