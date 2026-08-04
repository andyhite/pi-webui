/**
 * IPC channel names and payload shapes shared between
 * `backend-picker-preload.ts` (renderer side) and `backend-picker-window.ts`
 * (main-process side) — same split as `ipc-channels.ts`/`preload.ts`/
 * `main.ts` for the badge bridge, kept separate because this is a different
 * window with a different, still-narrow bridge.
 */

export const BACKEND_LIST_CHANNEL = "plotroom-backends:list";
export const BACKEND_SWITCH_CHANNEL = "plotroom-backends:switch";
export const BACKEND_REMOVE_CHANNEL = "plotroom-backends:remove";
export const BACKEND_TEST_AND_REMEMBER_CHANNEL =
  "plotroom-backends:test-and-remember";

/**
 * What the picker's own page is allowed to see about a remembered backend
 * — never its `credential` (`desktop-config.ts`'s `RemoteBackend` has one).
 * The picker's own UI only ever renders/keys off `id`/`label`/`url`
 * (`backend-picker.js`), and there is no reason for a plaintext secret to
 * cross into the renderer at all just to answer a list request — it never
 * needs to be redisplayed, only tested-and-remembered once on entry.
 */
export interface PickerBackendSummary {
  readonly id: string;
  readonly label: string;
  readonly url: string;
}

export interface BackendListResult {
  readonly backends: readonly PickerBackendSummary[];
  readonly active: PickerBackendSummary | null;
}

export interface BackendTestAndRememberInput {
  readonly label: string;
  readonly url: string;
  readonly credential: string | null;
}

export type BackendTestAndRememberResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };
