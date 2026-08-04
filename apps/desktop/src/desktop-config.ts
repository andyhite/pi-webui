/**
 * Desktop-owned configuration (spec §12, Epic 3.0's remote-backend
 * carry-over): what backend this instance talks to, the backends it
 * remembers, and the one updater setting the operator controls directly
 * (principle 2 — auto-*downloading* a found update needs an explicit
 * setting behind it, never a default; installing always asks regardless
 * of this setting — see `autoInstallUpdates`'s own doc comment).
 *
 * Deliberately not `apps/server`'s settings store (Epic 8.3, Track A/B's):
 * this is Electron-shell state that exists whether or not any server is
 * running yet — including "which backend to even attach to" — so it lives
 * in its own small file rather than waiting on a server to hold it.
 *
 * Pure logic here, IO injected (`ConfigIo`), so the mutation rules
 * (id-stable add/update, "removing the active one clears it") are testable
 * without touching a real filesystem — same shape as `spawn-or-attach.ts`.
 */

export interface RemoteBackend {
  readonly id: string;
  readonly label: string;
  /** Origin only (e.g. `https://plotroom.example.com`), no path. */
  readonly url: string;
  /** `null` means no credential remembered for this backend. */
  readonly credential: string | null;
}

export interface DesktopConfig {
  readonly backends: readonly RemoteBackend[];
  /**
   * `null` means "local" — spawn-or-attach against this machine's own
   * server, exactly as before this file existed. Any other value must name
   * a backend in `backends`.
   */
  readonly activeBackendId: string | null;
  /**
   * Explicit operator opt-in to auto-*download* a found update without
   * asking first (principle 2) — `updater.ts`'s `configureUpdater` reads
   * this to decide `autoDownload`. Defaults to `false`: a found update
   * instead raises a "download now?" prompt. This setting does **not**
   * cover installing: a downloaded update always asks again ("restart now
   * to install?") regardless of this setting, and installing silently on
   * quit is never wired at all — a second, stronger claim this batch does
   * not make on the operator's behalf.
   */
  readonly autoInstallUpdates: boolean;
}

export const EMPTY_DESKTOP_CONFIG: DesktopConfig = {
  backends: [],
  activeBackendId: null,
  autoInstallUpdates: false,
};

export interface ConfigIo {
  readonly readFile: (path: string) => string | null;
  readonly writeFile: (path: string, contents: string) => void;
}

function isRemoteBackend(value: unknown): value is RemoteBackend {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.label === "string" &&
    typeof record.url === "string" &&
    (record.credential === null || typeof record.credential === "string")
  );
}

/**
 * Parses whatever is on disk defensively — a corrupt or half-written file
 * (or one from a future version with fields this build does not know about)
 * degrades to the empty config rather than throwing and blocking launch.
 */
export function parseDesktopConfig(raw: string | null): DesktopConfig {
  if (raw === null) return EMPTY_DESKTOP_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const backends = Array.isArray(parsed.backends)
      ? parsed.backends.filter(isRemoteBackend)
      : [];
    const activeBackendId =
      typeof parsed.activeBackendId === "string"
        ? parsed.activeBackendId
        : null;
    return {
      backends,
      // An active id that no longer names a remembered backend (e.g. it was
      // removed by hand-editing the file) falls back to local rather than
      // pointing at nothing.
      activeBackendId: backends.some((b) => b.id === activeBackendId)
        ? activeBackendId
        : null,
      autoInstallUpdates: parsed.autoInstallUpdates === true,
    };
  } catch {
    return EMPTY_DESKTOP_CONFIG;
  }
}

export function serializeDesktopConfig(config: DesktopConfig): string {
  return JSON.stringify(config, null, 2);
}

export function loadDesktopConfig(io: ConfigIo, path: string): DesktopConfig {
  return parseDesktopConfig(io.readFile(path));
}

export function saveDesktopConfig(
  io: ConfigIo,
  path: string,
  config: DesktopConfig,
): void {
  io.writeFile(path, serializeDesktopConfig(config));
}

/** Adds a new backend or replaces one with the same id — never duplicates. */
export function upsertBackend(
  config: DesktopConfig,
  backend: RemoteBackend,
): DesktopConfig {
  const withoutExisting = config.backends.filter((b) => b.id !== backend.id);
  return { ...config, backends: [...withoutExisting, backend] };
}

/**
 * Removing the active backend falls back to local — "remove" must never
 * leave `activeBackendId` naming a backend that no longer exists.
 */
export function removeBackend(
  config: DesktopConfig,
  id: string,
): DesktopConfig {
  return {
    ...config,
    backends: config.backends.filter((b) => b.id !== id),
    activeBackendId:
      config.activeBackendId === id ? null : config.activeBackendId,
  };
}

/** `id: null` switches back to local. Refuses to switch to an unknown id. */
export function setActiveBackend(
  config: DesktopConfig,
  id: string | null,
): DesktopConfig {
  if (id !== null && !config.backends.some((b) => b.id === id)) {
    throw new Error(`no remembered backend with id ${id}`);
  }
  return { ...config, activeBackendId: id };
}

export function setAutoInstallUpdates(
  config: DesktopConfig,
  autoInstallUpdates: boolean,
): DesktopConfig {
  return { ...config, autoInstallUpdates };
}

export function activeBackend(config: DesktopConfig): RemoteBackend | null {
  if (config.activeBackendId === null) return null;
  return config.backends.find((b) => b.id === config.activeBackendId) ?? null;
}
