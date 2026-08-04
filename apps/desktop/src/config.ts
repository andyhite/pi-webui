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

// Must match `apps/server/src/config.ts`'s `DEFAULT_PORT` (Track A's file,
// not importable here: @plotroom/server declares no package "exports"/
// "main", so there is nothing to import this constant from). Duplicated on
// purpose — keep the two literals in sync if either changes.
export const DEFAULT_PLOTROOM_PORT = 4600;

export function resolvePort(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.PLOTROOM_PORT;
  if (raw === undefined) return DEFAULT_PLOTROOM_PORT;
  const parsed = Number(raw);
  // The same rule the server states as `PORT_BOUND` (`apps/server/src/config.ts`),
  // restated because Electron's main cannot import that package — the same reason
  // `DEFAULT_PLOTROOM_PORT` is duplicated above. Keep the two in step: a desktop
  // that accepted a port the server refuses would spawn a backend that dies at
  // boot, and one that refused a port the server accepts could never attach.
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(
      `PLOTROOM_PORT must be a whole port number from 1 to 65535, got ${raw}`,
    );
  }
  return parsed;
}
