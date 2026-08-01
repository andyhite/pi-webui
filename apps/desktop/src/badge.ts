/**
 * The application badge (spec §7, §11): "one derivation, many surfaces" —
 * the app badge/dock count is this process's own rendering of the exact
 * same attention count the renderer already derives (`@plotroom/ui`'s
 * `deriveBadgeCount`). This file only applies it to Electron's own API,
 * which is main-process-only (`app.setBadgeCount`) — the renderer cannot
 * call it directly, which is why `preload.ts` bridges one IPC channel for
 * exactly this.
 *
 * `setBadgeCount` is unsupported on Windows (Electron documents Linux/macOS
 * only); `applyBadgeCount` checks for the method rather than the platform
 * string, so a future Electron that adds Windows support picks it up for
 * free and a test can fake "unsupported" without faking `process.platform`.
 */

export interface BadgeCapableApp {
  setBadgeCount?: (count: number) => boolean;
}

export interface ApplyBadgeCountResult {
  readonly applied: boolean;
  readonly count: number;
}

/** Never negative — `deriveBadgeCount`'s own contract, re-stated at this seam so a caller cannot bypass it by calling this directly with a raw count. */
export function clampBadgeCount(count: number): number {
  return Math.max(0, Math.trunc(count));
}

export function applyBadgeCount(
  app: BadgeCapableApp,
  count: number,
): ApplyBadgeCountResult {
  const clamped = clampBadgeCount(count);
  if (typeof app.setBadgeCount !== "function") {
    return { applied: false, count: clamped };
  }
  app.setBadgeCount(clamped);
  return { applied: true, count: clamped };
}
