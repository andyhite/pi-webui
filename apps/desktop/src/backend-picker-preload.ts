/**
 * The bridge for the backend-picker window only (spec §12) — deliberately
 * separate from `preload.ts`, which is the main app window's bridge and
 * stays exactly as narrow as it already is (badge count only). This
 * window is a different surface with a different, still-narrow bridge:
 * list/switch/remove/test-and-remember, backed by IPC channels this file
 * shares with `backend-picker-window.ts` (the main-process side) the same
 * way `ipc-channels.ts` shares `BADGE_COUNT_CHANNEL` with `main.ts`.
 */

import { contextBridge, ipcRenderer } from "electron";

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

contextBridge.exposeInMainWorld("plotroomBackends", {
  list: (): Promise<BackendListResult> =>
    ipcRenderer.invoke(BACKEND_LIST_CHANNEL),
  switchTo: (id: string | null): Promise<void> =>
    ipcRenderer.invoke(BACKEND_SWITCH_CHANNEL, id),
  remove: (id: string): Promise<void> =>
    ipcRenderer.invoke(BACKEND_REMOVE_CHANNEL, id),
  testAndRemember: (
    input: BackendTestAndRememberInput,
  ): Promise<BackendTestAndRememberResult> =>
    ipcRenderer.invoke(BACKEND_TEST_AND_REMEMBER_CHANNEL, input),
});
