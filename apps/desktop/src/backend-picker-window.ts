/**
 * Main-process half of the backend picker (spec §12, Epic 3.0's
 * carry-over): opens the desktop-owned window, answers its IPC calls
 * against the on-disk `DesktopConfig`, and probes a candidate backend's
 * health before ever remembering it — "test connection and remember" is
 * one gesture, never a credential saved blind.
 *
 * Switching backends (including back to local) relaunches the app rather
 * than tearing down and rebuilding the main window's session/webRequest
 * wiring in place: `main.ts`'s startup sequence (probe/spawn-or-attach
 * locally, or health-check + header-inject + load remotely) already
 * decides everything correctly from `DesktopConfig` at launch, so relaunch
 * reuses that one decision path instead of a second, live version of it —
 * fewer states to get right, at the cost of the operator's window
 * reopening. The picker window itself does not persist across the
 * relaunch; there is nothing in it that needs to.
 */

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { BrowserWindow, app, ipcMain } from "electron";

import { checkRemoteBackendHealth } from "./backend-connect.js";
import type { FetchLike } from "./backend-connect.js";
import {
  BACKEND_LIST_CHANNEL,
  BACKEND_REMOVE_CHANNEL,
  BACKEND_SWITCH_CHANNEL,
  BACKEND_TEST_AND_REMEMBER_CHANNEL,
} from "./backend-picker-channels.js";
import type {
  BackendListResult,
  BackendTestAndRememberInput,
  BackendTestAndRememberResult,
} from "./backend-picker-channels.js";
import {
  activeBackend,
  loadDesktopConfig,
  removeBackend,
  saveDesktopConfig,
  setActiveBackend,
  upsertBackend,
} from "./desktop-config.js";
import type { ConfigIo, DesktopConfig } from "./desktop-config.js";

const PICKER_HTML = fileURLToPath(
  new URL("./backend-picker.html", import.meta.url),
);
const PICKER_PRELOAD = fileURLToPath(
  new URL("./backend-picker-preload.js", import.meta.url),
);

export interface BackendPickerDeps {
  readonly io: ConfigIo;
  readonly configPath: string;
  readonly fetchImpl: FetchLike;
}

let handlersRegistered = false;

/**
 * Registers the IPC handlers once per process. Idempotent because
 * `openBackendPicker` may be called more than once per run (the operator
 * can open the picker, close it, and reopen it) and `ipcMain.handle`
 * throws on a duplicate registration.
 */
function registerHandlers(deps: BackendPickerDeps): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  const readConfig = (): DesktopConfig =>
    loadDesktopConfig(deps.io, deps.configPath);
  const writeConfig = (config: DesktopConfig): void =>
    saveDesktopConfig(deps.io, deps.configPath, config);

  ipcMain.handle(BACKEND_LIST_CHANNEL, (): BackendListResult => {
    const config = readConfig();
    return { backends: config.backends, active: activeBackend(config) };
  });

  ipcMain.handle(BACKEND_SWITCH_CHANNEL, (_event, id: string | null): void => {
    writeConfig(setActiveBackend(readConfig(), id));
    app.relaunch();
    app.exit();
  });

  ipcMain.handle(BACKEND_REMOVE_CHANNEL, (_event, id: string): void => {
    writeConfig(removeBackend(readConfig(), id));
  });

  ipcMain.handle(
    BACKEND_TEST_AND_REMEMBER_CHANNEL,
    async (
      _event,
      input: BackendTestAndRememberInput,
    ): Promise<BackendTestAndRememberResult> => {
      const health = await checkRemoteBackendHealth(
        { url: input.url, credential: input.credential },
        deps.fetchImpl,
      );
      if (!health.ok) return health;

      writeConfig(
        upsertBackend(readConfig(), {
          id: randomUUID(),
          label: input.label,
          url: input.url,
          credential: input.credential,
        }),
      );
      return { ok: true };
    },
  );
}

export function openBackendPicker(deps: BackendPickerDeps): BrowserWindow {
  registerHandlers(deps);

  const window = new BrowserWindow({
    width: 560,
    height: 640,
    title: "PlotRoom — Backends",
    webPreferences: { preload: PICKER_PRELOAD },
  });
  void window.loadFile(PICKER_HTML);
  return window;
}
