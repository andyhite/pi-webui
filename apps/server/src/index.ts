/**
 * @plotroom/server — the single owner of all state (spec §12).
 *
 * Hono over HTTP + WebSocket. Both clients — the Electron renderer and a
 * browser pointed at localhost — load the same web app and talk to this
 * server. When the backend is remote, workspaces and diffs refer to this
 * machine, not the operator's.
 */
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { openDatabase } from "@plotroom/db";
import { Hono } from "hono";
import { configureApp } from "./app.js";
import { checkBindPolicy } from "./security/bind-policy.js";
import { loadServerConfig } from "./config.js";
import { createEventBus } from "./events/bus.js";
import { Logger } from "./logging/logger.js";

export const SERVER_NAME = "plotroom-server";

export function startServer(config = loadServerConfig()) {
  const bindPolicy = checkBindPolicy({
    host: config.host,
    allowNonLoopbackBind: config.allowNonLoopbackBind,
    credential: config.credential,
  });
  if (!bindPolicy.ok) {
    throw new Error(bindPolicy.reason);
  }

  const logger = new Logger(config.logLevel);
  const db = openDatabase({ stateDir: config.stateDir });
  const bus = createEventBus();

  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  configureApp(app, { config, db, bus, logger, upgradeWebSocket });

  const server = serve({
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  });
  injectWebSocket(server);

  logger.info("server started", {
    host: config.host,
    port: config.port,
    stateDir: config.stateDir,
    nonLoopback: config.allowNonLoopbackBind,
  });

  return {
    app,
    db,
    bus,
    logger,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

// Top-level bootstrap only; everything else uses Logger. console.error is
// allowed by the lint config specifically for this kind of last-resort exit.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    startServer();
  } catch (err) {
    console.error(`${SERVER_NAME}: failed to start: ${String(err)}`);
    process.exit(1);
  }
}
