/**
 * The Electron main process (spec §12, Epic 3.0/8.4): connects this window
 * to whichever backend is active — spawn-or-attach to a local server by
 * default, or connect to a remembered remote one — then loads the single
 * origin URL. Never a second origin, never a hardcoded host: the URL this
 * window loads is always either `resolvePort`'s local address or a
 * remembered backend's own origin, never a literal mixing the two.
 *
 * The decision and orchestration logic for the local path lives in
 * `spawn-or-attach.ts` (unit-tested with a mocked probe/spawn); the remote
 * path's decision logic lives in `backend-connect.ts` and
 * `credential-injection.ts` (also unit-tested). This file only wires both
 * to real Electron/Node primitives (`app`, `BrowserWindow`, `session`,
 * `child_process`, `fetch`, `electron-updater`) and is not itself
 * unit-tested — see `spawn-or-attach.integration.test.ts` for the
 * real-server fallback this project uses for main-process glue.
 *
 * Beyond spawn-or-attach itself:
 *
 *   - a single-instance lock, so a second launch does not spawn a second
 *     server (or open a second connection to a remote one) for the same
 *     instance;
 *   - a child exit listener, so a locally spawned server that crashes
 *     after this process already attached to it surfaces as a visible
 *     error rather than a window that silently stops responding;
 *   - a remote connection that fails health goes to the same kind of
 *     visible error page, naming the reason and pointing at the backend
 *     picker rather than loading a page that will only fail every request
 *     silently once open;
 *   - a credential for a remote backend is injected into every request
 *     bound for that backend's origin at the network layer (main-process
 *     `session.webRequest`), never taught to the renderer — see
 *     `credential-injection.ts`'s doc comment for why.
 */

import { spawn as spawnChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { BrowserWindow, Menu, app, dialog, ipcMain, session } from "electron";
// `electron-updater` ships CJS with no static named exports Node's ESM
// interop can see (verified: `import { autoUpdater }` throws
// `SyntaxError: Named export 'autoUpdater' not found` at runtime, despite
// its own .d.ts advertising one) — import the default. Its `autoUpdater`
// is a *lazy getter* that constructs a real updater on first access and
// reaches for Electron's `app` module to do it (`app.getVersion()`) —
// destructuring it at module scope crashed `spawn-or-attach.integration.
// test.ts` (which imports this module's `healthProbe`/`spawnServer` under
// plain Vitest, no live Electron `app`) the moment this file loaded, before
// any test even ran. Accessed lazily inside `main()` instead, below.
import electronUpdaterPkg from "electron-updater";

import { applyBadgeCount } from "./badge.js";
import { checkRemoteBackendHealth } from "./backend-connect.js";
import type { FetchLike } from "./backend-connect.js";
import { openBackendPicker } from "./backend-picker-window.js";
import { resolvePort } from "./config.js";
import { buildInjectedHeaders, originMatches } from "./credential-injection.js";
import { activeBackend, loadDesktopConfig } from "./desktop-config.js";
import type { RemoteBackend } from "./desktop-config.js";
import { resolveDesktopConfigPath } from "./desktop-paths.js";
import { BADGE_COUNT_CHANNEL } from "./ipc-channels.js";
import { nodeConfigIo } from "./node-config-io.js";
import { createPollingWaiter, spawnOrAttach } from "./spawn-or-attach.js";
import type { HealthProbe, SpawnedProcess } from "./spawn-or-attach.js";
import {
  checkForUpdatesNow,
  configureUpdater,
  resolveUpdateCheckIntervalHours,
} from "./updater.js";
import type { AutoUpdaterLike, UpdatePrompter } from "./updater.js";

const PRELOAD_ENTRY = fileURLToPath(new URL("./preload.js", import.meta.url));

/**
 * Same layout assumption as the rest of the monorepo (AGENTS.md): sibling
 * apps under `apps/`. `apps/server` is Track A's; this only assumes its
 * compiled entry point exists at the conventional `dist/index.js` path.
 * The packaged layout (`electron-builder.yml`'s `extraResources`)
 * preserves the same sibling relationship one level up from inside
 * `resources/app.asar`, so this resolution needs no packaged-vs-dev branch
 * (documented in `docs/deployment.md`).
 */
const SERVER_ENTRY = fileURLToPath(
  new URL("../../server/dist/index.js", import.meta.url),
);

export function healthProbe(port: number): HealthProbe {
  return async () => {
    try {
      // The server's real health route (apps/server/src/routes/health.ts)
      // lives under /api, like everything else — never a bare /health.
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      return response.ok;
    } catch {
      return false;
    }
  };
}

/** The one message `apps/server/src/index.ts`'s bootstrap ever sends over IPC. */
interface ListeningMessage {
  readonly type: "listening";
  readonly host: string;
  readonly port: number;
}

function isListeningMessage(value: unknown): value is ListeningMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "listening" &&
    typeof (value as { host?: unknown }).host === "string" &&
    typeof (value as { port?: unknown }).port === "number"
  );
}

export function spawnServer(
  port: number,
  onUnexpectedExit: (code: number | null) => void,
): SpawnedProcess {
  const child = spawnChildProcess(process.execPath, [SERVER_ENTRY], {
    // A fourth, `"ipc"` channel beside the three inherited ones: stdout/
    // stderr keep going straight to this process's own (unchanged from
    // before #88), and the extra channel is the only way to learn which
    // address the child actually bound — a stored override can move it
    // (#87), and `port` below is only ever a *request*, never a guarantee.
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    env: {
      ...process.env,
      PLOTROOM_PORT: String(port),
      // `process.execPath` is the Electron binary itself, not a separate
      // bundled Node runtime (there is none in a packaged app) — this is
      // the documented Electron trick for running a plain script with it:
      // with the flag set, the binary behaves as `node`, never opening a
      // GUI. Harmless when this process is itself already plain Node (dev
      // via `vitest`/ts-node, where `process.execPath` already is `node`).
      ELECTRON_RUN_AS_NODE: "1",
    },
  });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("failed to spawn the local server: no pid");
  }

  // The executor form because this project's `lib` predates
  // `Promise.withResolvers` (`apps/server/src/runtime/omp.ts` states the
  // same reason).
  const listening = new Promise<{ host: string; port: number }>(
    (resolve, reject) => {
      const onMessage = (message: unknown) => {
        if (!isListeningMessage(message)) return;
        child.off("message", onMessage);
        resolve({ host: message.host, port: message.port });
      };
      child.on("message", onMessage);
      child.once("exit", (code) => {
        child.off("message", onMessage);
        reject(
          new Error(
            `the local server exited (code ${String(code)}) before reporting the address it bound`,
          ),
        );
      });
    },
  );

  let expectedShutdown = false;
  child.on("exit", (code) => {
    if (!expectedShutdown) onUnexpectedExit(code);
  });

  return {
    pid,
    listening,
    kill: () =>
      new Promise<void>((resolve) => {
        expectedShutdown = true;
        // Already exited (e.g. it crashed before this was called) — no
        // second "exit" event is coming, so resolve directly rather than
        // waiting on one that will never fire.
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.kill();
      }),
  };
}

/** Shown in place of the app when the server we spawned crashes underneath it. */
function crashPage(code: number | null): string {
  const message = `the local server exited unexpectedly (code ${String(code)}). Restart PlotRoom to try again.`;
  return `data:text/html,${encodeURIComponent(`<pre>${message}</pre>`)}`;
}

/** Shown when a remembered remote backend fails its health/credential check. */
function connectionFailedPage(backend: RemoteBackend, reason: string): string {
  const message =
    `could not connect to "${backend.label}" (${backend.url}): ${reason}\n\n` +
    "Use the Backends menu to fix the credential or switch to a different backend.";
  return `data:text/html,${encodeURIComponent(`<pre>${message}</pre>`)}`;
}

interface Connection {
  readonly url: string;
  readonly remoteBackend: RemoteBackend | null;
  stop(): void;
}

/**
 * Decides and establishes what this launch connects to: local
 * spawn-or-attach (§3.0), or a remembered remote backend (§12) — the one
 * place this decision is made, so nothing downstream has to ask "which
 * backend?" a second way.
 */
async function connectToActiveBackend(
  port: number,
  fetchImpl: FetchLike,
  onLocalServerCrash: (code: number | null) => void,
): Promise<
  | { readonly ok: true; readonly connection: Connection }
  | {
      readonly ok: false;
      readonly backend: RemoteBackend;
      readonly reason: string;
    }
> {
  const configPath = resolveDesktopConfigPath(app.getPath("userData"));
  const config = loadDesktopConfig(nodeConfigIo, configPath);
  const backend = activeBackend(config);

  if (backend === null) {
    const handle = await spawnOrAttach({
      port,
      probeFor: healthProbe,
      spawn: () => spawnServer(port, onLocalServerCrash),
      waitUntilHealthy: createPollingWaiter(250),
    });
    // The port this loads is whichever one `spawnOrAttach` actually
    // confirmed healthy — `handle.result.port`, never the caller's own
    // `port` — because a stored override can move it after spawn (#87), and
    // an attach can only ever have found something at the resolved `port`
    // in the first place (#88).
    return {
      ok: true,
      connection: {
        url: `http://127.0.0.1:${handle.result.port}/`,
        remoteBackend: null,
        stop: () => handle.stop(),
      },
    };
  }

  const health = await checkRemoteBackendHealth(
    { url: backend.url, credential: backend.credential },
    fetchImpl,
  );
  if (!health.ok) {
    return { ok: false, backend, reason: health.reason };
  }
  return {
    ok: true,
    connection: { url: backend.url, remoteBackend: backend, stop: () => {} },
  };
}

/**
 * Rewrites every outgoing request bound for `backend`'s origin to carry its
 * credential — the mechanism `credential-injection.ts` describes. A no-op
 * when the backend has no remembered credential (an operator's choice; the
 * backend's own bind policy is what actually enforces §12, not this app).
 */
function installCredentialInjection(backend: RemoteBackend): void {
  if (backend.credential === null || backend.credential.length === 0) return;
  const origin = new URL(backend.url).origin;
  const credential = backend.credential;

  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["<all_urls>"] },
    (details, callback) => {
      if (!originMatches(details.url, origin)) {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }
      callback({
        requestHeaders: buildInjectedHeaders(
          details.requestHeaders,
          credential,
        ),
      });
    },
  );
}

function buildMenu(
  onOpenBackendPicker: () => void,
  onCheckForUpdates: () => void,
): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "PlotRoom",
      submenu: [
        { label: "Connect to Backend…", click: onOpenBackendPicker },
        { label: "Check for Updates…", click: onCheckForUpdates },
        { type: "separator" },
        { role: "quit" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function dialogPrompter(): UpdatePrompter {
  return {
    async confirmDownload(info) {
      const result = await dialog.showMessageBox({
        type: "info",
        message: `PlotRoom ${info.version} is available.`,
        detail: "Download it now? Nothing installs until you say so.",
        buttons: ["Download", "Not now"],
        defaultId: 0,
        cancelId: 1,
      });
      return result.response === 0;
    },
    async confirmInstall(info) {
      const result = await dialog.showMessageBox({
        type: "info",
        message: `PlotRoom ${info.version} has downloaded.`,
        detail: "Restart now to install? You can also do this later.",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1,
      });
      return result.response === 0;
    },
    notifyError(error) {
      // Deliberately no dialog for a failed *check* — offline, or no feed
      // configured yet (docs/deployment.md), is not an operator-facing
      // error, only a log line (`configureUpdater`'s own logger.warn).
      void error;
    },
  };
}

async function main(): Promise<void> {
  // One connection per instance: a second launch attaches to nothing new
  // and connects nothing new — it just quits, leaving the first instance's
  // window as the one true window (spec §12's single-origin rule extends
  // to "one process talks to one backend", not just "one origin").
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  await app.whenReady();

  // Lazy on purpose (see the import's own comment): this is the first
  // access, well after `app` is real and ready.
  const autoUpdater = electronUpdaterPkg.autoUpdater;

  const port = resolvePort();
  let window: BrowserWindow | null = null;

  const result = await connectToActiveBackend(
    port,
    fetch as unknown as FetchLike,
    (code) => {
      // The server we spawned crashed after we already confirmed it
      // healthy — surface it rather than leaving an unresponsive window.
      if (window) {
        void window.loadURL(crashPage(code));
      } else {
        app.quit();
      }
    },
  );

  let stopConnection: () => void = () => {};
  let loadUrl: string;

  if (result.ok) {
    stopConnection = result.connection.stop;
    if (result.connection.remoteBackend) {
      installCredentialInjection(result.connection.remoteBackend);
    }
    loadUrl = result.connection.url;
  } else {
    loadUrl = connectionFailedPage(result.backend, result.reason);
  }

  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.on("window-all-closed", () => {
    // Shutdown stops only what this process itself owns (§12): the local
    // server it spawned. An attached local server, or a remote backend,
    // belongs to whoever started it and outlives this window.
    stopConnection();
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => stopConnection());

  // The one derivation, one more surface (§7): the renderer derives its own
  // fresh attention count and asks this process to apply it — the only
  // thing exposed across the bridge (`preload.ts`), because `app.
  // setBadgeCount` has no renderer-side equivalent at all.
  ipcMain.on(BADGE_COUNT_CHANNEL, (_event, count: unknown) => {
    applyBadgeCount(app, typeof count === "number" ? count : 0);
  });

  const configPath = resolveDesktopConfigPath(app.getPath("userData"));
  buildMenu(
    () =>
      openBackendPicker({
        io: nodeConfigIo,
        configPath,
        fetchImpl: fetch as unknown as FetchLike,
      }),
    () => void checkForUpdatesNow(autoUpdater as unknown as AutoUpdaterLike),
  );

  // Update checks (spec §12, principle 2): a scheduled read, never an
  // install with nobody behind it — `configureUpdater`'s own doc comment
  // states the consent rule for each of the three gestures.
  const desktopConfig = loadDesktopConfig(nodeConfigIo, configPath);
  configureUpdater({
    autoUpdater: autoUpdater as unknown as AutoUpdaterLike,
    prompter: dialogPrompter(),
    autoInstallUpdates: desktopConfig.autoInstallUpdates,
    logger: { warn: (msg) => console.warn(`[updater] ${msg}`) },
  });
  void checkForUpdatesNow(autoUpdater as unknown as AutoUpdaterLike);
  const intervalHours = resolveUpdateCheckIntervalHours();
  if (intervalHours > 0) {
    setInterval(
      () => void checkForUpdatesNow(autoUpdater as unknown as AutoUpdaterLike),
      intervalHours * 60 * 60 * 1000,
    );
  }

  window = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: { preload: PRELOAD_ENTRY },
  });
  // The one single-origin URL (§12) — either the local port the health
  // probe just confirmed is serving, or a remembered remote backend's own
  // origin, never a literal mixing the two.
  await window.loadURL(loadUrl);
}

if (process.env.NODE_ENV !== "test") {
  void main();
}
