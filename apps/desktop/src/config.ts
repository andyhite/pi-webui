/**
 * The port/instance knob (spec §12, Epic 3.0): one setting drives which
 * PlotRoom instance this is. `PLOTROOM_PORT` is the single origin's port —
 * in production, the Hono server binds it directly; in dev, the Vite dev
 * server binds it and proxies `/api`/`/ws` to the backend's own dev-mode
 * listener (see `apps/web/vite.config.ts`, which resolves the same env var
 * the same way — duplicated rather than shared, since a Vite config and an
 * Electron main process are two separate Node entry points with no shared
 * config package yet).
 */

export const DEFAULT_PLOTROOM_PORT = 4317;

export function resolvePort(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.PLOTROOM_PORT;
  if (raw === undefined) return DEFAULT_PLOTROOM_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`PLOTROOM_PORT must be a positive integer, got ${raw}`);
  }
  return parsed;
}
