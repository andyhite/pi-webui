import { Hono } from "hono";
import { z } from "zod";
import type { Author } from "@plotroom/core";
import { LOG_LEVELS, type Logger } from "../logging/logger.js";
import { forbidden } from "../http/errors.js";
import { validateJsonBody } from "../http/validate.js";
import { actorOf, type ApiEnv } from "./api.js";

const logLevelBody = z.object({ level: z.enum(LOG_LEVELS) });

/**
 * Runtime-adjustable log level (spec §8: "adjustable at runtime" means an
 * endpoint or signal, never a restart). Gated behind the same credential and
 * origin checks as every other state-changing request.
 *
 * Both verbs are the **operator's own** (`log_level_get` and `log_level_set` are
 * declared `humanOnly`), and the actor is what enforces that rather than the flag:
 * a flag describes and a route refuses, which is the same arrangement the claim
 * routes keep for grant and force-release. What a session would do with it is the
 * point — turning the log down is how you make your own behaviour harder to see.
 */
function requireOperator(actor: Author, gesture: string): void {
  if (actor.kind === "human") return;
  throw forbidden(
    `${gesture} is the operator's control (§8); a session cannot make it`,
  );
}

export function logLevelRoutes(logger: Logger): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get("/log-level", (c) => {
    requireOperator(actorOf(c), "reading the log level");
    return c.json({ level: logger.level });
  });

  app.patch("/log-level", validateJsonBody(logLevelBody), (c) => {
    requireOperator(actorOf(c), "setting the log level");
    const { level } = c.get("body") as z.infer<typeof logLevelBody>;
    logger.setLevel(level);
    return c.json({ level: logger.level });
  });

  return app;
}
