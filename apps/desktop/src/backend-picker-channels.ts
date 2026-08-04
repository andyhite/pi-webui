/**
 * IPC channel names and payload shapes shared between
 * `backend-picker-preload.ts` (renderer side) and `backend-picker-window.ts`
 * (main-process side) — same split as `ipc-channels.ts`/`preload.ts`/
 * `main.ts` for the badge bridge, kept separate because this is a different
 * window with a different, still-narrow bridge.
 */

import type { RemoteBackend } from "./desktop-config.js";

export const BACKEND_LIST_CHANNEL = "plotroom-backends:list";
export const BACKEND_SWITCH_CHANNEL = "plotroom-backends:switch";
export const BACKEND_REMOVE_CHANNEL = "plotroom-backends:remove";
export const BACKEND_TEST_AND_REMEMBER_CHANNEL =
  "plotroom-backends:test-and-remember";

export interface BackendListResult {
  readonly backends: readonly RemoteBackend[];
  readonly active: RemoteBackend | null;
}

export interface BackendTestAndRememberInput {
  readonly label: string;
  readonly url: string;
  readonly credential: string | null;
}

export type BackendTestAndRememberResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };
