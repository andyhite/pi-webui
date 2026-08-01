import { Hono } from "hono";
import { z } from "zod";
import { LOG_LEVELS, type Logger } from "../logging/logger.js";
import { validateJsonBody } from "../http/validate.js";

const logLevelBody = z.object({ level: z.enum(LOG_LEVELS) });

/**
 * Runtime-adjustable log level (spec §8: "adjustable at runtime" means an
 * endpoint or signal, never a restart). Gated behind the same credential and
 * origin checks as every other state-changing request.
 */
export function logLevelRoutes(logger: Logger): Hono {
  const app = new Hono();

  app.get("/log-level", (c) => c.json({ level: logger.level }));

  app.patch("/log-level", validateJsonBody(logLevelBody), (c) => {
    const { level } = c.get("body") as z.infer<typeof logLevelBody>;
    logger.setLevel(level);
    return c.json({ level: logger.level });
  });

  return app;
}
