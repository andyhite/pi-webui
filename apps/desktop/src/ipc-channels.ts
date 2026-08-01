/**
 * IPC channel names, shared between `main.ts` and `preload.ts` without
 * either importing the other's side effects (`preload.ts` calls
 * `contextBridge.exposeInMainWorld` at module load, which throws outside a
 * preload context — so `main.ts` names the channel from here, never from
 * `preload.ts` directly).
 */
export const BADGE_COUNT_CHANNEL = "plotroom:badge-count";
