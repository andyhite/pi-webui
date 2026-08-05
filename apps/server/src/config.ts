import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BRANCH_TEMPLATE } from "@plotroom/core";
import { IN_BOX_PLUGINS, type InBoxPluginEntry } from "./plugins/in-box.js";

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
  /**
   * Seconds between version-compaction sweeps (§15-3, Epic 2.3). Zero disables
   * the schedule; the endpoint still works, because "never automatically" and
   * "never" are different answers.
   */
  readonly compactionIntervalSeconds: number;
  /**
   * How many sessions may run at once (§4.1's configurable global limit).
   * Initiation beyond it queues; queuing is admission of already-initiated work,
   * never a decision about whether it runs.
   */
  readonly concurrencyLimit: number;
  /**
   * Seconds between re-derivations of the attention queue (§7). Zero disables
   * the schedule; the derivation still runs on every observed change and on
   * every read, so disabling it costs punctuality rather than the queue.
   */
  readonly attentionTickSeconds: number;
  /**
   * Seconds between integration refresh ticks (§9.1, Epic 7.2). Every tick is a
   * scheduled **read**, never a run (principle 2): it checks which connected
   * integrations declare an interval mode and are due, and re-reads only those.
   * Zero disables the schedule; on-demand refresh (per integration and per
   * object) stays available regardless.
   */
  readonly integrationTickSeconds: number;
  /**
   * §10.2's configured plugins directory: one subdirectory per plugin, scanned on
   * demand — at boot and on an operator gesture — and **never on a timer**
   * (principle 2). Null means none is configured, which is the ordinary case: the
   * in-box plugins need no directory. A plugin's id comes from its manifest, never
   * from the directory name the operator can rename.
   */
  readonly pluginsDirectory: string | null;
  /**
   * Which plugins ship **in the box** (§10.2's first distribution channel).
   *
   * Configuration rather than a hard-coded call list so the set is data — Jira
   * joins it by gaining a line in {@link IN_BOX_PLUGINS} — and so a test can boot a
   * server with fixtures, or with none at all, instead of three worker threads it
   * has no assertion about. There is no environment variable for it: which plugins
   * the app ships is a property of the build, not of the machine it runs on.
   */
  readonly pluginsInBox: readonly InBoxPluginEntry[];
}

export interface RuntimeConfig {
  /**
   * The adapter id. `pi-coding-agent` is adapter v1; `scripted` replays a
   * declared script and is opt-in, so a default install cannot run one.
   */
  readonly adapterId: string;
  /** The pi binary, for hosts that keep it somewhere other than `PATH`. */
  readonly piProgram: string;
  /**
   * The whole executable to run as the session host, when the operator has one
   * — a `bun build --compile` binary in a packaged install (issue #92). Set, it
   * is run alone; unset, the session host is this build's own entry, run by
   * `sessionHostBun`.
   */
  readonly sessionHostProgram: string | null;
  /**
   * The Bun program that runs the bundled session-host entry. `apps/session-host`
   * is the one package in the repo that needs Bun (issue #78 keeps the server on
   * Node), so this is how a host with Bun somewhere other than `PATH` says where.
   */
  readonly sessionHostBun: string;
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
  readonly compactionIntervalSeconds?: number;
  readonly concurrencyLimit?: number;
  readonly attentionTickSeconds?: number;
  readonly integrationTickSeconds?: number;
  readonly pluginsDirectory?: string | null;
  readonly pluginsInBox?: readonly InBoxPluginEntry[];
}

export const DEFAULT_RUNTIME_ADAPTER = "pi-coding-agent";

/**
 * Six hours: often enough that the store does not grow unbounded between
 * restarts, rare enough that the sweep is never what the operator notices.
 */
export const DEFAULT_COMPACTION_INTERVAL_SECONDS = 6 * 60 * 60;

/**
 * Four concurrent sessions, decided.
 *
 * §4.1 says the limit is configurable and says nothing about its value, so this is
 * a default rather than a rule. Four is chosen so the queue is a path the product
 * actually takes on an ordinary board rather than an unreachable branch: a fleet
 * gesture over a handful of commands queues, is visible, and is cancellable on the
 * first day of use. It is also survivable on one laptop against one provider's
 * rate limits, which a much higher number is not.
 *
 * Zero is refused rather than treated as "unlimited": a limit of none is spelled
 * by setting it high, and a typo that silently removed the bound would be the one
 * failure the limit exists to prevent. That refusal is
 * {@link CONCURRENCY_LIMIT_BOUND}, stated once so the environment variable and
 * the settings write cannot disagree about it.
 */
export const DEFAULT_CONCURRENCY_LIMIT = 4;

/**
 * What a configurable number has to be, stated once.
 *
 * Two paths set the same numbers — an environment variable at boot and a
 * settings write at runtime (§11) — and a bound only the first one applied is a
 * bound the second walks around: a stored `concurrencyLimit` of `0` was accepted
 * by the settings route, persisted, and then refused every admission for ever,
 * which is the exact failure the limit exists to prevent. So the rule is data
 * here rather than a condition in two parsers: `config.ts` parsers check it,
 * the settings catalog points its numeric entries at it, and boot skips a stored
 * value that violates it (principle 8 — the rule has one statement).
 *
 * `overrides` is deliberately *not* checked against these: it is the programmatic
 * seam a test or an embedding caller passes values through directly, not a
 * surface an operator reaches. The two paths an operator has — the environment
 * and a settings write — are the ones a bound has to hold on.
 *
 * `requirement` is written to complete the sentence "X must be …", so the
 * environment variable's message and the settings route's refusal say the same
 * thing about the same number without either restating it.
 */
export interface NumericBound {
  readonly min: number;
  /** Inclusive, where an upper bound is a real limit rather than taste. */
  readonly max?: number;
  readonly integer: boolean;
  readonly requirement: string;
}

export const CONCURRENCY_LIMIT_BOUND: NumericBound = {
  min: 1,
  // Deliberately no maximum: "a limit of none is spelled by setting it high".
  integer: true,
  requirement: "a whole number of sessions, at least 1",
};

/**
 * Every interval in this file: zero is legal and means "no schedule", which is
 * why this bound admits it (see `DEFAULT_COMPACTION_INTERVAL_SECONDS`) — a
 * negative one is a typo, and a job that never ran because of one would be the
 * quiet failure §12 is about.
 *
 * The maximum is not taste either. Every interval becomes `setInterval(cb,
 * seconds * 1000)`, and Node clamps a delay past 2^31-1 ms to **1 ms** — so a
 * number an operator meant as "practically never" would run the job every
 * millisecond, which is the same quiet failure with the sign flipped. 2_147_483
 * seconds (~24.8 days) is the largest interval that survives the multiplication.
 */
export const INTERVAL_SECONDS_BOUND: NumericBound = {
  min: 0,
  max: 2_147_483,
  integer: false,
  requirement: "a non-negative number of seconds, at most 2147483",
};

/**
 * The bound every port that arrives as *configuration* is held to — the
 * environment variable and the stored setting.
 *
 * Zero is **refused** there, unlike in most port parsers: it means "let the OS
 * pick", and a product nobody can find is worse than one that refused the value.
 * A stored `0` bound an ephemeral port and left the desktop probing 4600 for
 * ever — recoverable only by reading `ss -ltnp` or editing the database by hand.
 * The startup line now names the port the socket actually bound rather than the
 * configured one, so a `0` would at least be *findable*; the desktop still could
 * not attach to it, which is the reason that stands.
 *
 * **`port: 0` in a `ServerConfigOverrides` is legal, and load-bearing.** A caller
 * inside this process reads `startServer(...).listening` and is told what it got,
 * so nothing is unfindable — that is how every in-process test harness boots,
 * because probing for a free port and binding it second is a race. Overrides are
 * a programmatic argument rather than input to be validated, which is why they do
 * not pass through here at all; `parsePort` is the environment path.
 *
 * That is the shape of every rule here: a stored port beats the environment
 * variable, `serve()` refuses what it cannot use, and the settings API that
 * would delete the row needs a running server. `apps/desktop/src/config.ts`
 * states the same rule for its own `PLOTROOM_PORT`, because Electron's main
 * cannot import this package (the same reason `DEFAULT_PLOTROOM_PORT` is
 * duplicated there) — the two are kept in step by hand.
 */
export const PORT_BOUND: NumericBound = {
  min: 1,
  max: 65_535,
  integer: true,
  requirement: "a whole port number from 1 to 65535",
};

/**
 * Why `value` is not allowed, as the tail of "X must be …", or `null` when it is
 * allowed. Callers supply the subject, because only they know whether they are
 * refusing an environment variable or a settings key.
 */
export function checkBound(bound: NumericBound, value: number): string | null {
  if (bound.integer ? !Number.isInteger(value) : !Number.isFinite(value)) {
    return bound.requirement;
  }
  if (value < bound.min) return bound.requirement;
  if (bound.max !== undefined && value > bound.max) return bound.requirement;
  return null;
}

/**
 * Thirty seconds between attention re-derivations.
 *
 * The queue is recomputed whenever something is observed to change, so this tick
 * only exists for the two facts that are made true by time alone: a health
 * threshold coming due (§7.2) and a snooze elapsing (§4.5). Half a minute is
 * short enough that "no output for ten minutes" is reported at roughly ten
 * minutes rather than whenever something else happened, and long enough that
 * re-deriving is never what the machine is doing.
 *
 * It is a scheduled **read** and initiates nothing (principle 2) — see
 * `attention/tick.ts`, where that stance is stated in full.
 */
export const DEFAULT_ATTENTION_TICK_SECONDS = 30;

/**
 * Thirty seconds between integration refresh ticks (§9.1).
 *
 * The same order of magnitude as the attention tick, for the same reason: often
 * enough that an interval-mode integration's declared seconds are honored
 * promptly, rare enough that checking "is anything due" is never what the
 * process is doing. Individual integrations still control their own cadence
 * through their declared `seconds`; this only bounds how often that check runs.
 */
export const DEFAULT_INTEGRATION_TICK_SECONDS = 30;

function parseSeconds(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  // A malformed interval is reported, not silently treated as "off": a job that
  // never runs because of a typo is exactly the kind of quiet failure §12 is
  // about. The variable is named in the message, because two settings share this
  // parser and a message naming the wrong one sends the operator hunting.
  const wrong = checkBound(INTERVAL_SECONDS_BOUND, parsed);
  if (wrong !== null) {
    throw new Error(`${name} must be ${wrong} (got ${value})`);
  }
  return parsed;
}

function parseConcurrency(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  const wrong = checkBound(CONCURRENCY_LIMIT_BOUND, parsed);
  if (wrong !== null) {
    throw new Error(
      `PLOTROOM_CONCURRENCY_LIMIT must be ${wrong} (got ${value})`,
    );
  }
  return parsed;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_PORT;
  const parsed = Number(value);
  // Previously `Number(...)` with nothing after it, so `PLOTROOM_PORT=abc`
  // became `NaN` and the failure surfaced from inside `serve()`. The desktop's
  // own `resolvePort` has always refused this; the server says the same thing.
  const wrong = checkBound(PORT_BOUND, parsed);
  if (wrong !== null) {
    throw new Error(`PLOTROOM_PORT must be ${wrong} (got ${value})`);
  }
  return parsed;
}

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
    port: overrides.port ?? parsePort(env.PLOTROOM_PORT),
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
    compactionIntervalSeconds:
      overrides.compactionIntervalSeconds ??
      parseSeconds(
        "PLOTROOM_COMPACTION_INTERVAL_SECONDS",
        env.PLOTROOM_COMPACTION_INTERVAL_SECONDS,
        DEFAULT_COMPACTION_INTERVAL_SECONDS,
      ),
    concurrencyLimit:
      overrides.concurrencyLimit ??
      parseConcurrency(
        env.PLOTROOM_CONCURRENCY_LIMIT,
        DEFAULT_CONCURRENCY_LIMIT,
      ),
    attentionTickSeconds:
      overrides.attentionTickSeconds ??
      parseSeconds(
        "PLOTROOM_ATTENTION_TICK_SECONDS",
        env.PLOTROOM_ATTENTION_TICK_SECONDS,
        DEFAULT_ATTENTION_TICK_SECONDS,
      ),
    integrationTickSeconds:
      overrides.integrationTickSeconds ??
      parseSeconds(
        "PLOTROOM_INTEGRATION_TICK_SECONDS",
        env.PLOTROOM_INTEGRATION_TICK_SECONDS,
        DEFAULT_INTEGRATION_TICK_SECONDS,
      ),
    pluginsInBox: overrides.pluginsInBox ?? IN_BOX_PLUGINS,
    pluginsDirectory:
      overrides.pluginsDirectory !== undefined
        ? overrides.pluginsDirectory
        : (env.PLOTROOM_PLUGINS_DIR ?? null),
    runtime: {
      adapterId:
        overrides.runtime?.adapterId ??
        env.PLOTROOM_RUNTIME ??
        DEFAULT_RUNTIME_ADAPTER,
      piProgram:
        overrides.runtime?.piProgram ?? env.PLOTROOM_PI_PROGRAM ?? "pi",
      sessionHostProgram:
        overrides.runtime?.sessionHostProgram !== undefined
          ? overrides.runtime.sessionHostProgram
          : (env.PLOTROOM_SESSION_HOST ?? null),
      sessionHostBun:
        overrides.runtime?.sessionHostBun ??
        env.PLOTROOM_SESSION_HOST_BUN ??
        "bun",
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
