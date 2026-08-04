/**
 * Where this process keeps its own state (spec §12): `DesktopConfig`
 * (remembered backends, the auto-install setting) lives beside Electron's
 * own `userData` — separate from `PLOTROOM_STATE_DIR` (the *server's*
 * portable store, `~/.plotroom` by default), because this file exists and
 * matters even when the active backend is remote and no local server ever
 * starts.
 */

export function resolveDesktopConfigPath(
  userDataDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const dir = env.PLOTROOM_DESKTOP_CONFIG_DIR ?? userDataDir;
  return `${dir}/desktop-config.json`;
}
