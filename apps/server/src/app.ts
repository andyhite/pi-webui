import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { PlotroomDatabase } from "@plotroom/db";
import type { ServerConfig } from "./config.js";
import type { EventBus } from "./events/bus.js";
import { ApiError } from "./http/errors.js";
import {
  credentialMiddleware,
  originCheckMiddleware,
  requestLogMiddleware,
} from "./http/middleware.js";
import type { Logger } from "./logging/logger.js";
import { healthRoutes } from "./routes/health.js";
import { logLevelRoutes } from "./routes/log-level.js";
import { serveRenderer } from "./static/serve.js";
import { mountWsRoute } from "./ws/route.js";

export interface AppDependencies {
  readonly config: ServerConfig;
  readonly db: PlotroomDatabase;
  readonly bus: EventBus;
  readonly logger: Logger;
  readonly upgradeWebSocket: UpgradeWebSocket;
}

/**
 * Wires routes and middleware onto an already-constructed `Hono` instance.
 * Takes the instance (rather than constructing and returning one) because
 * `@hono/node-ws`'s `createNodeWebSocket` must be called with the app before
 * this module can hand it the resulting `upgradeWebSocket` — see
 * `apps/server/src/index.ts` for the wiring order.
 */
export function configureApp(app: Hono, deps: AppDependencies): void {
  const { config, db, bus, logger, upgradeWebSocket } = deps;
  const originPolicy = { trustedOrigins: config.trustedOrigins };

  app.use("*", requestLogMiddleware(logger));

  // API and WS share the same origin/credential gate — one vocabulary, one
  // access policy (spec §12, cross-cutting rule 2).
  app.use("/api/*", originCheckMiddleware(originPolicy));
  app.use("/api/*", credentialMiddleware(config.credential));
  app.use("/ws", originCheckMiddleware(originPolicy));
  app.use("/ws", credentialMiddleware(config.credential));

  app.route("/api", healthRoutes(db));
  app.route("/api", logLevelRoutes(logger));

  mountWsRoute({ app, path: "/ws", upgradeWebSocket, bus, logger });

  // Single-origin serving (Epic 3.0, spec §12): whatever `apps/web` builds,
  // served from the same port as /api and /ws. If it hasn't been built yet
  // (Epic 3.0 lands separately, on the same timeline), API and WS still
  // work — only the page is unavailable, and that is reported, not silent.
  // Guarded to /api and /ws paths so an unmatched API route 404s as JSON
  // instead of falling through to the SPA's index.html.
  const renderer = serveRenderer({ rootDir: config.staticDir });
  if (renderer === null) {
    logger.warn("renderer not built; serving API/WS only", {
      staticDir: config.staticDir,
    });
  }
  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/api/") || c.req.path === "/ws") {
      await next();
      return;
    }
    if (renderer === null) {
      return c.json(
        {
          error: {
            code: "renderer_not_built",
            message: `no built renderer at ${config.staticDir} (see apps/web)`,
          },
        },
        503,
      );
    }
    return renderer(c, next);
  });

  app.notFound((c) =>
    c.json(
      { error: { code: "not_found", message: `no route for ${c.req.path}` } },
      404,
    ),
  );

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(err.toBody(), err.status as 400 | 401 | 403 | 404);
    }
    logger.error("unhandled error", { err: String(err) });
    return c.json(
      { error: { code: "internal_error", message: "internal server error" } },
      500,
    );
  });
}
