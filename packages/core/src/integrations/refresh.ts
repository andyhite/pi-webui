import type { IntegrationRefreshMode } from "./types.js";

/**
 * The refresh-scheduling predicate (§9.1, principle 2).
 *
 * "Scheduled reads only, never scheduled runs — refresh changes state and costs
 * nothing, changes surface as drift." This is the whole rule: a pure function
 * from a declared mode and elapsed time to a yes/no about whether a **read** is
 * due. It cannot start anything, because it returns a boolean rather than doing
 * anything with it — the caller (`apps/server/src/integrations/refresh-job.ts`)
 * is the one scheduled read, and it never reaches for the run or session
 * machinery at all (it is not even given a reference to it).
 *
 * - `"on-demand"` is never due on a schedule. Manual refresh is always available
 *   through a different path (the on-demand endpoints), which is what "manual
 *   refresh always available per integration and per object" (§9.1) means for a
 *   mode that otherwise never ticks.
 * - `"interval"` is due when nothing has been read yet, or enough seconds have
 *   elapsed since the last read.
 * - `"observed"` is never due on a schedule either: the plugin pushes through the
 *   host callback seam, and a schedule that also polled an observed producer
 *   would be a second, competing notion of "when".
 */
export function isIntervalRefreshDue(
  mode: IntegrationRefreshMode,
  lastRefreshAt: number | null,
  now: number,
): boolean {
  if (mode.kind !== "interval") return false;
  if (lastRefreshAt === null) return true;
  return now - lastRefreshAt >= mode.seconds;
}

/** One line describing when a mode next runs, for the connect/settings surface. */
export function describeRefreshMode(mode: IntegrationRefreshMode): string {
  switch (mode.kind) {
    case "on-demand":
      return "on demand only — refresh it manually";
    case "interval":
      return `every ${mode.seconds} seconds`;
    case "observed":
      return `whenever ${mode.what} is observed`;
  }
}
