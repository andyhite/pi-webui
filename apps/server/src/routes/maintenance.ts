import { Hono } from "hono";
import { z } from "zod";
import type { Author, WorkspaceKindRegistry } from "@plotroom/core";
import { RESET_SCOPES, type ResetScope } from "@plotroom/db";
import type { ServerConfig } from "../config.js";
import { badRequest, forbidden } from "../http/errors.js";
import { validateJsonBody } from "../http/validate.js";
import type { Logger } from "../logging/logger.js";
import type { CompactionSchedule } from "../maintenance/compaction.js";
import { executeReset, planReset, resetPaths } from "../maintenance/reset.js";
import { actorOf, param, type ApiEnv, type ApiStores } from "./api.js";

/**
 * Durability, portability, and cleanup as endpoints (§12, Epic 2.3).
 *
 * Three rules are visible in the shapes here:
 *
 * - **A destructive verb states what it removes before it removes it.** The plan
 *   is its own read, and executing requires the caller to say `confirm: true` —
 *   so "reset everything" cannot be reached by a stray request, and the answer
 *   to "what will this take?" never has to be inferred from what it took.
 * - **Compaction is reachable on demand as well as on a schedule.** The schedule
 *   is the product keeping its own house; the endpoint is the operator asking it
 *   to, and both call the same sweep.
 * - **Every verb here is the operator's own** — `catalog.test.ts`'s
 *   `OPERATOR_ONLY_ROUTES` already declared every one of them tool-less for
 *   exactly that reason; this is that declaration enforced rather than merely
 *   documented (cross-cutting rule 3, #189). No catalog tool names any of these
 *   endpoints, so neither approvals guard reaches them — the actor check below
 *   is the only gate there is.
 */
function requireOperator(actor: Author, gesture: string): void {
  if (actor.kind === "human") return;
  throw forbidden(
    `${gesture} is the operator's own (§12); a session cannot make it`,
  );
}

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
  workspaceKinds: WorkspaceKindRegistry,
  logger: Logger,
): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  /**
   * The backup and move story, as data (§12): the one directory to copy, what is
   * in it, and the derived directories that are deliberately *not* part of it.
   */
  app.get("/maintenance/state", (c) => {
    requireOperator(actorOf(c), "reading the backup-and-move inventory");
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

  /**
   * What a reset would remove, without removing it (§12). Asking the checkouts
   * whether they hold unsaved work means talking to git, which is why this read
   * is not instant — and why it is worth waiting for.
   */
  app.get("/reset/plan", async (c) => {
    requireOperator(actorOf(c), "reading a reset's plan");
    const scope = c.req.query("scope");
    if (!isScope(scope)) {
      throw badRequest(
        `scope must be one of ${RESET_SCOPES.join(", ")}; each removes something different`,
      );
    }

    return c.json({
      plan: await planReset(stores.maintenance, workspaceKinds, config, scope),
    });
  });

  /**
   * Execute one. Without `confirm: true` this is the plan and nothing else —
   * the same body, the same shape, no removal — so a client can show the plan
   * and then repeat the call with a confirmation.
   */
  app.post("/reset", validateJsonBody(resetBody), async (c) => {
    requireOperator(actorOf(c), "resetting the store");
    const input = c.get("body") as z.infer<typeof resetBody>;
    const plan = await planReset(
      stores.maintenance,
      workspaceKinds,
      config,
      input.scope,
    );

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
  app.post("/maintenance/compact", (c) => {
    requireOperator(actorOf(c), "compacting on demand");
    return c.json({ compaction: compaction.runNow() });
  });

  /**
   * A single run's pin, which is the human's veto over all of the above (§4.4):
   * "pinning is the human's word for never compact this."
   *
   * It reaches everything the run references — its assembled content and every
   * version that went in or came out — which is `RunStore.pin`'s doing, not this
   * route's. And it **publishes**, because a pin changes what a surface may say
   * about a run's future: an unpinned run can stop being comparable, a pinned one
   * cannot, and "comparable forever" (§3.7) is not a state to discover by
   * refetching.
   */
  const setPin = (runId: string, pinned: boolean) => {
    const run = stores.runs.pin(runId, pinned);
    stores.bus.publish({
      entity: "run",
      verb: "updated",
      run,
      author: { kind: "human" },
    });
    return run;
  };

  app.post("/runs/:id/pin", (c) => {
    requireOperator(actorOf(c), "pinning a run");
    return c.json({ run: setPin(param(c, "id"), true) });
  });

  app.delete("/runs/:id/pin", (c) => {
    requireOperator(actorOf(c), "unpinning a run");
    return c.json({ run: setPin(param(c, "id"), false) });
  });

  return app;
}

function isScope(value: string | undefined): value is ResetScope {
  return (
    value !== undefined && (RESET_SCOPES as readonly string[]).includes(value)
  );
}
