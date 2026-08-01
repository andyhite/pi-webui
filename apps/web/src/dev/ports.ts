/**
 * The port/instance knob (spec §12, Epic 3.0): one setting, `PLOTROOM_PORT`,
 * drives both the Vite dev server's own port and the port its `/api`/`/ws`
 * proxy targets. In dev, Vite itself *is* the single origin the browser
 * talks to (§12's single-origin rule) — its own port is `PLOTROOM_PORT`
 * directly. The backend, when run alongside it in dev, cannot also bind
 * that same port, so the proxy target is derived one above it — still one
 * knob, not a second setting to remember.
 *
 * (This file is intentionally duplicated, not shared, with
 * `apps/desktop/src/config.ts` — a Vite config and an Electron main process
 * are two separate Node entry points with no shared config package yet.)
 */

export const DEFAULT_PLOTROOM_PORT = 4317;

export interface DevPorts {
  /** The port Vite's dev server itself binds — the browser's one origin. */
  readonly devServer: number;
  /** Where `/api` and `/ws` are proxied to in dev (the backend's own dev listener). */
  readonly proxyTarget: number;
}

export function resolveDevPorts(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DevPorts {
  const raw = env.PLOTROOM_PORT;
  const devServer =
    raw === undefined ? DEFAULT_PLOTROOM_PORT : requirePositiveInt(raw);
  return { devServer, proxyTarget: devServer + 1 };
}

function requirePositiveInt(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`PLOTROOM_PORT must be a positive integer, got ${raw}`);
  }
  return parsed;
}
