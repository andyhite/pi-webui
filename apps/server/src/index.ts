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
  const runtime = configureApp(app, {
    config,
    db,
    bus,
    logger,
    upgradeWebSocket,
  });

  // Recovery before anything is served, for whatever the last process could not
  // tidy because it died rather than shut down: a session that was in flight is
  // recorded as **interrupted** — not stopped, not failed — so nobody is ever
  // shown a session the product believes is running (principle 11; resuming one
  // is a gesture, never automatic), and an initiation key claimed but never
  // settled is freed, since no attempt can still be holding it (principle 9).
  //
  // Then the queue is reconciled against what those sessions actually did and
  // drained once. Both halves are needed and neither is a timer: an entry the
  // queue thinks is running has an outcome nothing applied, so its batch would
  // stay "running" forever; and an entry that was *waiting* was already initiated
  // by somebody's gesture, which a restart does not un-initiate. Admitting it is
  // §4.1's "the system is only deciding *when*, never *whether*" — refusing to
  // would mean a restart silently dropped work somebody asked for.
  const recovered = (async () => {
    const recovery = await runtime.runs.recoverFromRestart(
      "the server restarted while this session was in flight",
    );
    await runtime.queue.recoverAfterRestart();
    return recovery;
  })();

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
    /** Resolves once boot-time recovery has been recorded. */
    recovered,
    hub: runtime.hub,
    runs: runtime.runs,
    queue: runtime.queue,
    close: async () => {
      await recovered;

      // First: the queue stops listening. A shutdown ends every live session, and
      // a queue still subscribed would read those ends as slots freeing and try to
      // admit the next run against a database that is closing (§4.1's queue is
      // admission, and there is nothing to admit into a server that is going
      // away).
      runtime.stopQueue();
      runtime.stopSteering();
      // Same reason for the attention derivation: those same ends would be
      // re-derived into a queue nobody is reading, against a closing database —
      // and an outbound route would try to tell somebody about it (§7.3).
      runtime.stopAttention();
      runtime.stopNotifications();
      runtime.attentionTick.stop();
      await runtime.notifications.drain();

      // A graceful close does not orphan a runtime: every live session is
      // recorded as **interrupted** here and its process terminated, rather than
      // left spending money against a workspace nothing is watching until the
      // next boot notices. Next-boot marking stays for the crash case, where
      // this never runs (principle 11, from both sides).
      await runtime.runs.shutdown(
        "the server shut down while this session was in flight",
      );

      // Nothing depends on a sweep having run, so shutting the schedule down is
      // just tidiness; leaving a timer behind would keep a test process alive.
      runtime.compaction.stop();

      await new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
      });
    },
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
