import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BRANCH_TEMPLATE } from "@plotroom/core";

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
  /** Which session runtime runs work (decision 0001, Epic 4.1). */
  readonly runtime: RuntimeConfig;
  /** How the first run provisions a workspace (§3.4, Epic 4.3). */
  readonly workspace: WorkspaceConfig;
}

export interface RuntimeConfig {
  /**
   * The adapter id. `pi-coding-agent` is adapter v1; `scripted` replays a
   * declared script and is opt-in, so a default install cannot run one.
   */
  readonly adapterId: string;
  /** The pi binary, for hosts that keep it somewhere other than `PATH`. */
  readonly piProgram: string;
  /** A script file the scripted runtime replays when a launch supplies none. */
  readonly scriptPath: string | null;
}

/**
 * Where a workspace comes from at first run. There is no discovery UI yet
 * (§3.4's scan is Epic 4.3's, its surface is later), so the repository to branch
 * from is configured; a run with none configured is refused with that reason
 * rather than run somewhere arbitrary.
 */
export interface WorkspaceConfig {
  readonly kind: string;
  /** An existing checkout to branch from, shared via `git worktree`. */
  readonly repositoryPath: string | null;
  /** Cloned from when there is no local checkout to share. */
  readonly remoteUrl: string | null;
  /** Where provisioned workspaces live; one directory per workstream. */
  readonly directory: string;
  readonly branchTemplate: string;
  readonly baseRef: string | null;
  /**
   * The settings-override half of §3.4's setup declaration. The in-repository
   * reader is Track C's deferral, so this is the only source for now — and it
   * is the one that wins where both exist.
   */
  readonly setup: WorkspaceSetupConfig | null;
}

export interface WorkspaceSetupConfig {
  readonly program: string;
  readonly args: readonly string[];
  readonly workingSubdirectory: string;
  readonly label: string;
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
  readonly runtime?: Partial<RuntimeConfig>;
  readonly workspace?: Partial<WorkspaceConfig>;
}

export const DEFAULT_RUNTIME_ADAPTER = "pi-coding-agent";

function parseSetup(value: string | undefined): WorkspaceSetupConfig | null {
  if (!value) return null;

  // Malformed configuration is reported, never guessed at: a setup step that
  // silently did not run would let a not-ready workspace look ready (§3.4).
  const raw: unknown = JSON.parse(value);
  if (typeof raw !== "object" || raw === null) {
    throw new Error("PLOTROOM_WORKSPACE_SETUP must be a JSON object");
  }

  const record = raw as Record<string, unknown>;
  const program = record["program"];
  if (typeof program !== "string" || program.length === 0) {
    throw new Error("PLOTROOM_WORKSPACE_SETUP needs a program");
  }

  const args = Array.isArray(record["args"])
    ? record["args"].filter((one): one is string => typeof one === "string")
    : [];

  return {
    program,
    args,
    workingSubdirectory:
      typeof record["workingSubdirectory"] === "string"
        ? record["workingSubdirectory"]
        : "",
    label:
      typeof record["label"] === "string" ? record["label"] : "workspace setup",
  };
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
    runtime: {
      adapterId:
        overrides.runtime?.adapterId ??
        env.PLOTROOM_RUNTIME ??
        DEFAULT_RUNTIME_ADAPTER,
      piProgram:
        overrides.runtime?.piProgram ?? env.PLOTROOM_PI_PROGRAM ?? "pi",
      scriptPath:
        overrides.runtime?.scriptPath !== undefined
          ? overrides.runtime.scriptPath
          : (env.PLOTROOM_RUNTIME_SCRIPT ?? null),
    },
    workspace: {
      kind: overrides.workspace?.kind ?? env.PLOTROOM_WORKSPACE_KIND ?? "git",
      repositoryPath:
        overrides.workspace?.repositoryPath !== undefined
          ? overrides.workspace.repositoryPath
          : (env.PLOTROOM_WORKSPACE_REPO ?? null),
      remoteUrl:
        overrides.workspace?.remoteUrl !== undefined
          ? overrides.workspace.remoteUrl
          : (env.PLOTROOM_WORKSPACE_REMOTE ?? null),
      directory:
        overrides.workspace?.directory ??
        env.PLOTROOM_WORKSPACE_DIR ??
        join(
          overrides.stateDir ?? env.PLOTROOM_STATE_DIR ?? defaultStateDir(),
          "workspaces",
        ),
      branchTemplate:
        overrides.workspace?.branchTemplate ??
        env.PLOTROOM_WORKSPACE_BRANCH_TEMPLATE ??
        DEFAULT_BRANCH_TEMPLATE,
      baseRef:
        overrides.workspace?.baseRef !== undefined
          ? overrides.workspace.baseRef
          : (env.PLOTROOM_WORKSPACE_BASE_REF ?? null),
      setup:
        overrides.workspace?.setup !== undefined
          ? overrides.workspace.setup
          : parseSetup(env.PLOTROOM_WORKSPACE_SETUP),
    },
  };
}
