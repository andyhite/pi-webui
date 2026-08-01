/**
 * The port/instance knob (spec §12, Epic 3.0): one setting, `PLOTROOM_PORT`,
 * drives both where the dev proxy targets the backend and Vite's own dev
 * server port. `PLOTROOM_PORT` is the *server's* port — the exact env var
 * `apps/server/src/config.ts` reads for its own `port` — so the proxy
 * target is that value directly, and Vite's own dev port (which cannot
 * also bind it, since both processes run at once in dev) is derived one
 * above it. `DEFAULT_PLOTROOM_PORT` must match `apps/server`'s
 * `DEFAULT_PORT` (4600) so that running both with no env var set talks to
 * the same instance by default.
 *
 * (This file is intentionally duplicated, not shared, with
 * `apps/desktop/src/config.ts` — a Vite config and an Electron main process
 * are two separate Node entry points with no shared config package yet.)
 */

// Must match apps/server/src/config.ts's DEFAULT_PORT (Track A's file, not
// importable here: @plotroom/server declares no package "exports"/"main").
export const DEFAULT_PLOTROOM_PORT = 4600;

export interface DevPorts {
  /** The port Vite's dev server itself binds — the browser's one origin. */
  readonly devServer: number;
  /** Where `/api` and `/ws` are proxied to — the backend's own port. */
  readonly proxyTarget: number;
}

export function resolveDevPorts(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DevPorts {
  const raw = env.PLOTROOM_PORT;
  const proxyTarget =
    raw === undefined ? DEFAULT_PLOTROOM_PORT : requirePositiveInt(raw);
  return { proxyTarget, devServer: proxyTarget + 1 };
}

function requirePositiveInt(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`PLOTROOM_PORT must be a positive integer, got ${raw}`);
  }
  return parsed;
}
