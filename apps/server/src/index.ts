/**
 * @plotroom/server — the single owner of all state (spec §12).
 *
 * Hono over HTTP + WebSocket. Both clients — the Electron renderer and a
 * browser pointed at localhost — load the same web app and talk to this
 * server. When the backend is remote, workspaces and diffs refer to this
 * machine, not the operator's.
 */
import { existsSync } from "node:fs";
import { serve, type ServerType } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { openDatabase, SettingsStore, stateLayout } from "@plotroom/db";
import { Hono } from "hono";
import { configureApp } from "./app.js";
import { checkBindPolicy } from "./security/bind-policy.js";
import { loadServerConfig } from "./config.js";
import { createEventBus } from "./events/bus.js";
import { Logger } from "./logging/logger.js";
import {
  DEFAULT_LOG_BUFFER_CAPACITY,
  LogRingBuffer,
} from "./logging/ring-buffer.js";
import { createBufferedSink } from "./logging/sink.js";
import { applyStoredSettings } from "./settings/boot.js";

export const SERVER_NAME = "plotroom-server";

export function startServer(config = loadServerConfig()) {
  // A boot that is going to be refused should not leave a state directory
  // behind that it created only to refuse (§12: the state directory is the unit
  // of portability, and an empty one is a thing the operator now has to wonder
  // about). When there is no database file there can be no stored override of
  // `host`, `allowNonLoopbackBind` or `credential` — there is nowhere for one to
  // live — so the caller's own config *is* the effective config, and the bind
  // policy can answer now, before anything is created or migrated. An existing
  // state directory is a different question and is answered below, after its
  // overrides have been read: refusing a first boot early must never become
  // refusing a configured one on stale values.
  if (
    config.stateDir !== ":memory:" &&
    !existsSync(stateLayout(config.stateDir).databaseFile)
  ) {
    const firstBoot = checkBindPolicy({
      host: config.host,
      allowNonLoopbackBind: config.allowNonLoopbackBind,
      credential: config.credential,
    });
    if (!firstBoot.ok) throw new Error(firstBoot.reason);
  }

  // `stateDir` itself is never a stored setting (§12, `settings/catalog.ts`'s
  // own note): the override for every other key lives *inside* the store this
  // path locates, so the store must already be open, at this path, before
  // anything can ask it what else was overridden. Opened before the bind
  // check for the same reason — `checkBindPolicy` needs the *effective*
  // host/allowNonLoopbackBind/credential, which do not exist until the store
  // that might override them has been read.
  const db = openDatabase({ stateDir: config.stateDir });
  const bus = createEventBus();

  // Epic 2.1's deferred seam, filled: `config` is the caller's own defaults
  // (env, or a test's explicit overrides); persisted settings (Epic 8.3) are
  // layered onto them here, once, before anything reads a value from it. A
  // setting this store has no override for changes nothing — the env-derived
  // default still applies, exactly as §11 requires.
  const settingsStore = new SettingsStore(db);
  const { config: effectiveConfig, ignored: ignoredSettings } =
    applyStoredSettings(config, settingsStore.list());

  // The bind check reads the *effective* values — a stored `host`,
  // `allowNonLoopbackBind`, or `credential` override is exactly as visible
  // here as it is to the rest of the app (§12): a boot that bound non-loopback
  // because of a persisted credential this check never saw would be the
  // two-part opt-in silently answering to a value nobody checked.
  const bindPolicy = checkBindPolicy({
    host: effectiveConfig.host,
    allowNonLoopbackBind: effectiveConfig.allowNonLoopbackBind,
    credential: effectiveConfig.credential,
  });
  if (!bindPolicy.ok) {
    // Refused before a socket ever opens. Reaching here means the state
    // directory already existed (a first boot with a refusing config was
    // refused above, before anything was created), so the store this closes is
    // one that was already there — closed rather than left holding a WAL file
    // for a boot that never actually started.
    db.close();
    throw new Error(bindPolicy.reason);
  }

  // A bounded, queryable structured-log sink (§8, Epic 8.3's fill of Epic 2.1's
  // deferred "persisted structured-log sink" — in-process rather than
  // persisted, because the log is this run's operational record, not authored
  // state §15 governs). Every line still reaches stdout exactly as before; this
  // sink also keeps it queryable over `GET /api/logs`, and reports — once,
  // never per line — the moment the bound is first reached, so a live surface
  // learns it may be missing entries without a flood of one event per drop.
  const logs = new LogRingBuffer(DEFAULT_LOG_BUFFER_CAPACITY);
  const logger = new Logger(
    effectiveConfig.logLevel,
    createBufferedSink({
      logs,
      onFirstDrop: (notice) => {
        // The app's own observation, like every other derived event on this
        // stream: nobody gestured for the buffer to fill, so there is no
        // third author kind to invent for it (the same reasoning
        // `PluginService` states for a lifecycle event nobody asked for).
        bus.publish({
          entity: "log",
          verb: "created",
          drop: notice,
          author: { kind: "human" },
        });
      },
    }),
  );

  // Reported here rather than where they were skipped, because that happens
  // before there is a logger: an override this process is not running under is
  // named, never dropped quietly (a store written by an older build, or by
  // hand, is the case this exists for). At `error`, not `warn`, precisely
  // because the log level is itself configurable: a line the operator's own
  // `logLevel` could filter out is not a report, and "quietly" is the one thing
  // this must not be. The read says the same thing without a log at all — see
  // `ignoredSettings` below.
  for (const skipped of ignoredSettings) {
    logger.error("ignored a stored setting", { ...skipped });
  }

  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  const runtime = configureApp(app, {
    config: effectiveConfig,
    // `config` (unmodified by any stored override) is what a removed override
    // reverts to — the seam `SettingsService` calls "defaults".
    settingsDefaults: config,
    settingsStore,
    ignoredSettings: Object.fromEntries(
      ignoredSettings.map((skipped) => [skipped.key, skipped.reason]),
    ),
    logs,
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

  // §10.2's plugin platform, started beside recovery rather than before serving:
  // one worker per plugin has to load and say what it is, and a product that
  // waited for that to bind would be a product a broken plugin stops from
  // starting — the exact failure §10.2 rules out. `/api/plugins` answers honestly
  // meanwhile (an empty list, then `loading`, then whatever each turned out to be).
  const pluginsBooted = runtime.plugins.boot().catch((err: unknown) => {
    logger.error("the plugin platform failed to boot", { err: String(err) });
    return [];
  });

  /**
   * Binds `app.fetch` at `host`:`port` and resolves once `listen()` actually
   * succeeds — resolving from the socket's own address, never the arguments,
   * because port 0 means "whichever the OS has free" and only the socket knows
   * what it got. Rejects on a bind failure, which is otherwise an `error` event
   * nobody is listening to: the process dies with a raw stack far from the call
   * that caused it. That listener is detached the moment this settles — a
   * socket error *after* the bind (accept-time `EMFILE`, say) has nothing to do
   * with starting up, and delivering it to a settled promise would discard it
   * silently.
   */
  interface BoundListener {
    readonly server: ServerType;
    readonly host: string;
    readonly port: number;
  }

  // The executor form because this project's `lib` predates
  // `Promise.withResolvers` (`apps/server/src/runtime/omp.ts` states the same
  // reason).
  function attemptBind(host: string, port: number): Promise<BoundListener> {
    return new Promise((resolve, reject) => {
      const srv = serve({ fetch: app.fetch, port, hostname: host });
      const failed = (err: unknown) => {
        srv.off("listening", ready);
        reject(err);
      };
      const ready = () => {
        srv.off("error", failed);
        const address = srv.address();
        if (address === null || typeof address === "string") {
          reject(
            new Error(
              `${SERVER_NAME}: listening on ${String(address)}, which carries no port`,
            ),
          );
          return;
        }
        resolve({ server: srv, host: address.address, port: address.port });
      };
      srv.once("error", failed);
      if (srv.listening) ready();
      else srv.once("listening", ready);
    });
  }

  let boundServer: ServerType | undefined;

  /**
   * A stored `host` or `port` that is *legal* — it passed `checkBindPolicy`
   * and the catalog's bound — can still be unbindable on this machine: a port
   * already in use, an address this machine does not have (#87). No bound can
   * catch that ahead of time, only the failed `listen()` itself, which is why
   * this retries with the env-derived default rather than letting the process
   * exit on every subsequent boot. A failure on a value that was *not* a
   * stored override (nothing to fall back to beyond what the caller already
   * asked for) still propagates, exactly as before.
   */
  type OverriddenKey = "host" | "port";

  function errorCode(err: unknown): string {
    return err instanceof Error && "code" in err
      ? String((err as NodeJS.ErrnoException).code)
      : String(err);
  }

  const listening: Promise<{ host: string; port: number }> = (async () => {
    let bound;
    try {
      bound = await attemptBind(effectiveConfig.host, effectiveConfig.port);
    } catch (err) {
      const overridden = (["host", "port"] as const).filter(
        (key) => effectiveConfig[key] !== config[key],
      );
      if (overridden.length === 0) throw err;

      // Which subset of the *stored* overrides to try reverting, smallest
      // first: a combined failure with both `host` and `port` overridden
      // cannot be attributed to either from the OS error alone (one error,
      // two suspects), so this isolates the true cause by testing each on
      // its own before ever blaming both — marking a value ignored that a
      // smaller revert already proved innocent would be exactly the
      // dishonesty `ignoredReason`'s own contract (`settings/service.ts`)
      // exists to rule out.
      const revertAttempts: readonly OverriddenKey[][] =
        overridden.length === 1
          ? [overridden]
          : (() => {
              const [first, second] = overridden as [
                OverriddenKey,
                OverriddenKey,
              ];
              return [[first], [second], overridden];
            })();

      let lastErr: unknown = err;
      for (const revert of revertAttempts) {
        const host = revert.includes("host")
          ? config.host
          : effectiveConfig.host;
        const port = revert.includes("port")
          ? config.port
          : effectiveConfig.port;
        try {
          bound = await attemptBind(host, port);
        } catch (retryErr) {
          lastErr = retryErr;
          continue;
        }
        // `err`, not `retryErr`: the first attempt is what every reverted
        // key was actually judged against, so its code is what every
        // ignored reason below cites.
        const code = errorCode(err);
        for (const key of revert) {
          const stored = effectiveConfig[key];
          const fallback = config[key];
          const reason =
            key === "host"
              ? `stored host "${stored}" could not be bound (${code}); running "${fallback}" instead`
              : `stored port ${stored} could not be bound (${code}); running ${fallback} instead`;
          logger.error("ignored a stored setting", { key, reason });
          runtime.settings.markIgnored(key, reason);
        }
        break;
      }
      if (bound === undefined) throw lastErr;
    }

    boundServer = bound.server;
    injectWebSocket(boundServer);
    // Both from the socket, never from the config: under `port: 0` the
    // configured port is literally `0`, and a startup line that says so is
    // worse than no line. `address.address` is the same for `host` — a
    // hostname resolves, and what it resolved to is what is reachable.
    logger.info("server started", {
      host: bound.host,
      port: bound.port,
      // Never from `effectiveConfig`: stateDir cannot be a stored override
      // (see the note above `openDatabase`), so `config.stateDir` is the only
      // value this ever was or could be.
      stateDir: config.stateDir,
      nonLoopback: effectiveConfig.allowNonLoopbackBind,
    });
    return { host: bound.host, port: bound.port };
  })();

  return {
    app,
    db,
    bus,
    logger,
    /** Resolves once boot-time recovery has been recorded. */
    recovered,
    /** Resolves once every in-box and directory plugin has reported its health. */
    pluginsBooted,
    /**
     * Resolves with the address the socket actually bound — the only way to learn
     * it under `port: 0` — and rejects if the bind failed.
     */
    listening,
    plugins: runtime.plugins,
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
      runtime.integrationRefresh.stop();

      // Every plugin worker is disposed, and nothing on disk is touched: a plugin
      // came from a directory the operator owns (§10.2, principle 10).
      await pluginsBooted;
      await runtime.plugins.shutdown();

      // `boundServer` is only unset if the bind never succeeded at all (both
      // the stored value and the env-derived fallback were refused) — nothing
      // is listening, so there is nothing to close beyond the database.
      await listening.catch(() => {});
      // The executor form because this project's `lib` predates
      // `Promise.withResolvers` (`apps/server/src/runtime/omp.ts` states the
      // same reason).
      await new Promise<void>((resolve) => {
        if (boundServer) {
          boundServer.close(() => {
            db.close();
            resolve();
          });
        } else {
          db.close();
          resolve();
        }
      });
    },
  };
}

// Top-level bootstrap only; everything else uses Logger. console.error is
// allowed by the lint config specifically for this kind of last-resort exit.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    // A bind failure arrives after `startServer` has returned — the socket is
    // still connecting — so it needs its own report. Without this it is an
    // unhandled rejection: the same exit, minus the one line saying the port was
    // already taken.
    startServer()
      .listening.then((bound) => {
        // Reported over IPC to whatever spawned this process, if anything did
        // (`apps/desktop/src/main.ts`'s `spawnServer`) — `process.send` exists
        // only when the parent asked for an `"ipc"` stdio channel, so this is a
        // no-op everywhere else (a bare `node dist/index.js`, a test harness).
        // A stored `host`/`port` override can differ from what this process
        // was asked to bind (#87), and can even change which one of the two it
        // ended up on after falling back — the actual address is the one fact
        // only this process has, and the parent that assumed the port it chose
        // has no other way to learn it (#88).
        process.send?.({ type: "listening", ...bound });
      })
      .catch((err: unknown) => {
        console.error(`${SERVER_NAME}: failed to start: ${String(err)}`);
        process.exit(1);
      });
  } catch (err) {
    console.error(`${SERVER_NAME}: failed to start: ${String(err)}`);
    process.exit(1);
  }
}
