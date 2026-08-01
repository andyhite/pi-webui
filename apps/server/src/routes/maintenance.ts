import { Hono } from "hono";
import { z } from "zod";
import { RESET_SCOPES, type ResetScope } from "@plotroom/db";
import type { ServerConfig } from "../config.js";
import { badRequest } from "../http/errors.js";
import { validateJsonBody } from "../http/validate.js";
import type { Logger } from "../logging/logger.js";
import type { CompactionSchedule } from "../maintenance/compaction.js";
import { executeReset, planReset, resetPaths } from "../maintenance/reset.js";
import { param, type ApiEnv, type ApiStores } from "./api.js";

/**
 * Durability, portability, and cleanup as endpoints (§12, Epic 2.3).
 *
 * Two rules are visible in the shapes here:
 *
 * - **A destructive verb states what it removes before it removes it.** The plan
 *   is its own read, and executing requires the caller to say `confirm: true` —
 *   so "reset everything" cannot be reached by a stray request, and the answer
 *   to "what will this take?" never has to be inferred from what it took.
 * - **Compaction is reachable on demand as well as on a schedule.** The schedule
 *   is the product keeping its own house; the endpoint is the operator asking it
 *   to, and both call the same sweep.
 */
const resetBody = z.object({
  scope: z.enum(RESET_SCOPES),
  /**
   * Deliberately not defaulted: an unconfirmed reset answers with the plan and
   * removes nothing, which is what makes the plan the contract (§12).
   */
  confirm: z.boolean().optional(),
});

export function maintenanceRoutes(
  stores: ApiStores,
  config: ServerConfig,
  compaction: CompactionSchedule,
  logger: Logger,
): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  /**
   * The backup and move story, as data (§12): the one directory to copy, what is
   * in it, and the derived directories that are deliberately *not* part of it.
   */
  app.get("/maintenance/state", (c) => {
    const inventory = stores.maintenance.inventory();
    const paths = resetPaths(config);

    return c.json({
      inventory,
      portable: {
        // Copy this directory and you have moved everything (§12). The two
        // entries below live inside it and are deliberately excluded: both are
        // rebuilt on demand, and a git worktree records absolute paths, so
        // copying one to a new machine would move something already broken.
        unit: inventory.stateDir,
        includes: [inventory.databaseFile, inventory.blobsDir],
        excludes: [
          {
            path: paths.workspacesDir,
            why: "provisioned checkouts; re-provisioned at the next run",
          },
          {
            path: paths.gitCacheDir,
            why: "a mirror cache; rebuilt on demand",
          },
          {
            path: paths.runtimeDir,
            why: "generated at every start",
          },
        ],
      },
      compaction: { intervalSeconds: compaction.intervalSeconds },
    });
  });

  /** What a reset would remove, without removing it (§12). */
  app.get("/reset/plan", (c) => {
    const scope = c.req.query("scope");
    if (!isScope(scope)) {
      throw badRequest(
        `scope must be one of ${RESET_SCOPES.join(", ")}; each removes something different`,
      );
    }

    return c.json({ plan: planReset(stores.maintenance, config, scope) });
  });

  /**
   * Execute one. Without `confirm: true` this is the plan and nothing else —
   * the same body, the same shape, no removal — so a client can show the plan
   * and then repeat the call with a confirmation.
   */
  app.post("/reset", validateJsonBody(resetBody), (c) => {
    const input = c.get("body") as z.infer<typeof resetBody>;
    const plan = planReset(stores.maintenance, config, input.scope);

    if (input.confirm !== true) {
      return c.json({ confirmed: false, plan, removed: null }, 200);
    }

    const result = executeReset(
      stores.maintenance,
      config,
      input.scope,
      logger,
    );

    return c.json({ confirmed: true, plan, result });
  });

  /**
   * Compact now (§15-3, §4.4). The sweep never removes pinned or referenced
   * content — the predicates in `@plotroom/core` decide, and this only asks.
   */
  app.post("/maintenance/compact", (c) =>
    c.json({ compaction: compaction.runNow() }),
  );

  /** A single run's pin, which is the human's veto over all of the above (§4.4). */
  app.post("/runs/:id/pin", (c) =>
    c.json({ run: stores.runs.pin(param(c, "id"), true) }),
  );

  app.delete("/runs/:id/pin", (c) =>
    c.json({ run: stores.runs.pin(param(c, "id"), false) }),
  );

  return app;
}

function isScope(value: string | undefined): value is ResetScope {
  return (
    value !== undefined && (RESET_SCOPES as readonly string[]).includes(value)
  );
}
