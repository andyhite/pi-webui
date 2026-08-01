import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Server configuration (Epic 2.1, spec §11/§12).
 *
 * Settings storage (grouped, searchable, applied without restart) is Epic
 * 8.3's job. Until it lands, environment variables are the only source —
 * which is itself the §11 rule ("environment variables only supply
 * defaults"): {@link loadServerConfig} takes explicit overrides so the
 * eventual settings store has a seam to call into instead of env directly.
 */
export interface ServerConfig {
  /** Bind address. Loopback (§12) unless {@link allowNonLoopbackBind} is set. */
  readonly host: string;
  readonly port: number;
  /** Directory holding plotroom.db and blobs/ (AGENTS.md persistence notes). */
  readonly stateDir: string;
  /**
   * The operator credential (spec §12): optional while bound to loopback,
   * required to bind non-loopback. `null` means "not configured".
   */
  readonly credential: string | null;
  /**
   * Explicit opt-in to bind a non-loopback address. Never implied by setting
   * `host` alone — a typo in `host` must not silently expose the server.
   */
  readonly allowNonLoopbackBind: boolean;
  /**
   * Additional exact origins (e.g. `https://plotroom.example.com`) trusted
   * beyond loopback, for reverse-proxied or tunnelled non-loopback setups.
   */
  readonly trustedOrigins: readonly string[];
  /** Directory of the built renderer to serve single-origin (Epic 3.0). */
  readonly staticDir: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
}

export const DEFAULT_PORT = 4600;
export const DEFAULT_HOST = "127.0.0.1";

function defaultStateDir(): string {
  return join(homedir(), ".plotroom");
}

/** `apps/server/src/config.ts` -> `apps/web/dist`, the default dev layout. */
function defaultStaticDir(): string {
  return new URL("../../web/dist", import.meta.url).pathname;
}

function parseBoolean(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value === "1" || value.toLowerCase() === "true";
}

function parseOrigins(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function parseLogLevel(value: string | undefined): ServerConfig["logLevel"] {
  if (
    value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error"
  ) {
    return value;
  }
  return "info";
}

export interface ServerConfigOverrides {
  readonly host?: string;
  readonly port?: number;
  readonly stateDir?: string;
  readonly credential?: string | null;
  readonly allowNonLoopbackBind?: boolean;
  readonly trustedOrigins?: readonly string[];
  readonly staticDir?: string;
  readonly logLevel?: ServerConfig["logLevel"];
}

/**
 * Builds config from environment defaults, then applies explicit overrides —
 * the seam tests and (later) the settings store use instead of reading
 * `process.env` themselves.
 */
export function loadServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: ServerConfigOverrides = {},
): ServerConfig {
  const credentialFromEnv = env.PLOTROOM_CREDENTIAL?.trim();

  return {
    host: overrides.host ?? env.PLOTROOM_HOST ?? DEFAULT_HOST,
    port: overrides.port ?? Number(env.PLOTROOM_PORT ?? DEFAULT_PORT),
    stateDir: overrides.stateDir ?? env.PLOTROOM_STATE_DIR ?? defaultStateDir(),
    credential:
      overrides.credential !== undefined
        ? overrides.credential
        : credentialFromEnv && credentialFromEnv.length > 0
          ? credentialFromEnv
          : null,
    allowNonLoopbackBind:
      overrides.allowNonLoopbackBind ??
      parseBoolean(env.PLOTROOM_ALLOW_NON_LOOPBACK_BIND),
    trustedOrigins:
      overrides.trustedOrigins ?? parseOrigins(env.PLOTROOM_TRUSTED_ORIGINS),
    staticDir:
      overrides.staticDir ?? env.PLOTROOM_STATIC_DIR ?? defaultStaticDir(),
    logLevel: overrides.logLevel ?? parseLogLevel(env.PLOTROOM_LOG_LEVEL),
  };
}
