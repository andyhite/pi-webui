import {
  checkBound,
  CONCURRENCY_LIMIT_BOUND,
  DEFAULT_RUNTIME_ADAPTER,
  INTERVAL_SECONDS_BOUND,
  PORT_BOUND,
  type NumericBound,
} from "../config.js";
import { LOG_LEVELS } from "../logging/logger.js";

/**
 * The settings catalog (§11, §8, Epic 8.3): every configurable value, grouped
 * and searchable, and — the part the spec is explicit about — an honest
 * statement of whether writing it takes effect without a restart.
 *
 * This is code, not rows: `SettingsStore` (`@plotroom/db`) holds only the
 * current *value* for whatever key an operator overrode; the shape of a
 * setting — its group, its type, whether it applies live — lives here,
 * exactly the relationship `plugin_disablements` has to the plugin registry
 * and `plugin_grants` has to a permission's declared shape.
 *
 * `path` addresses the field on `ServerConfig` (and `ServerConfigOverrides`)
 * this setting corresponds to, so one generic get/set-by-path does the
 * reading and the boot-time merge, rather than a bespoke accessor per key.
 */
export type SettingType = "string" | "number" | "boolean" | "enum" | "string[]";

export interface SettingDefinition {
  readonly key: string;
  readonly group: string;
  readonly label: string;
  readonly description: string;
  readonly type: SettingType;
  readonly enumValues?: readonly string[];
  /**
   * For a `number`, what it has to be — the same `NumericBound` the environment
   * parser in `config.ts` applies, pointed at rather than restated, so a write
   * through this surface cannot store a value a boot would have refused
   * (`SettingsService` enforces it; `applyStoredSettings` skips a stored value
   * that violates it).
   */
  readonly bound?: NumericBound;
  readonly path: readonly string[];
  /** The environment variable this setting's default comes from, if any. */
  readonly envVar: string | null;
  /** Never echoed in a read (the credential's own value, in particular). */
  readonly sensitive?: boolean;
  /**
   * §11: "applied without restart" — true only where a real mechanism exists
   * to apply it (`SettingsService`'s `liveAppliers`, checked against this flag
   * at construction so the two cannot drift). False is not a placeholder: it
   * names, in `restartReason`, exactly what is fixed once the process is past
   * it — a socket already bound, a database file already open, a registry
   * already built from what was configured at boot.
   */
  readonly appliesWithoutRestart: boolean;
  readonly restartReason?: string;
  /** Session tools must never write this (principle 1); enforced in the route. */
  readonly humanOnly: boolean;
}

export const SETTINGS_CATALOG: readonly SettingDefinition[] = [
  // ---------------------------------------------------------------- network
  {
    key: "host",
    group: "Network",
    label: "Bind address",
    description: "The network address the server listens on.",
    type: "string",
    path: ["host"],
    envVar: "PLOTROOM_HOST",
    appliesWithoutRestart: false,
    restartReason:
      "the server is already bound to an address; changing this takes effect on the next start",
    humanOnly: true,
  },
  {
    key: "port",
    group: "Network",
    label: "Port",
    description: "The port the server listens on.",
    type: "number",
    // The one setting a bad stored value can make the product *unbootable*
    // with no in-app way back (a stored port beats the environment variable,
    // and deleting the row needs a running server), so it is bounded on every
    // path rather than trusted.
    bound: PORT_BOUND,
    path: ["port"],
    envVar: "PLOTROOM_PORT",
    appliesWithoutRestart: false,
    restartReason:
      "the server is already listening on this port; changing this takes effect on the next start",
    humanOnly: true,
  },
  {
    key: "allowNonLoopbackBind",
    group: "Network",
    label: "Allow non-loopback bind",
    description:
      "Explicit opt-in to bind a non-loopback address (§12); never implied by the bind address alone.",
    type: "boolean",
    path: ["allowNonLoopbackBind"],
    envVar: "PLOTROOM_ALLOW_NON_LOOPBACK_BIND",
    appliesWithoutRestart: false,
    restartReason:
      "bind policy is enforced once, before the socket opens; changing this takes effect on the next start",
    humanOnly: true,
  },
  // --------------------------------------------------------------- security
  {
    key: "trustedOrigins",
    group: "Security",
    label: "Trusted origins",
    description:
      "Origins trusted beyond loopback, for reverse-proxied or tunnelled setups (§12).",
    type: "string[]",
    path: ["trustedOrigins"],
    envVar: "PLOTROOM_TRUSTED_ORIGINS",
    appliesWithoutRestart: true,
    humanOnly: true,
  },
  {
    key: "credential",
    group: "Security",
    label: "Operator credential",
    description:
      "The shared secret required for non-local access (§12); optional while bound to loopback.",
    type: "string",
    path: ["credential"],
    envVar: "PLOTROOM_CREDENTIAL",
    sensitive: true,
    appliesWithoutRestart: true,
    humanOnly: true,
  },
  // --------------------------------------------------------------- storage
  //
  // `stateDir` is deliberately **not** a setting. The override for every other
  // key here lives inside the very store `stateDir` locates (`plotroom.db`,
  // inside `PLOTROOM_STATE_DIR`) — a stored value cannot relocate the store
  // that holds it, the way a note cannot tell you which drawer it is in from
  // inside a different drawer. Persisting one anyway would either be read from
  // the store at the *old* path (so it could never actually move anything) or,
  // worse, read the override before locating the store by it — a chicken-and-
  // egg §12 has no answer for. It stays env/flag only (`PLOTROOM_STATE_DIR`),
  // exactly as §12's "stored together, backupable, movable" already assumes:
  // moving the store is an operator act on the directory itself, never a
  // write through the app that is supposed to already know where it is.
  // ----------------------------------------------------------- application
  {
    key: "staticDir",
    group: "Application",
    label: "Renderer directory",
    description: "The built renderer served single-origin alongside the API.",
    type: "string",
    path: ["staticDir"],
    envVar: "PLOTROOM_STATIC_DIR",
    appliesWithoutRestart: false,
    restartReason:
      "the renderer path is resolved once at boot; changing this takes effect on the next start",
    humanOnly: true,
  },
  // ------------------------------------------------------------------ logs
  {
    key: "logLevel",
    group: "Logging",
    label: "Log level",
    description: "The minimum level written to the structured log (§8).",
    type: "enum",
    enumValues: LOG_LEVELS,
    path: ["logLevel"],
    envVar: "PLOTROOM_LOG_LEVEL",
    appliesWithoutRestart: true,
    // The existing `/api/log-level` tool-catalog endpoint (`packages/core`'s
    // session tools) already gates *both* verbs to the operator, not only the
    // write — this generic settings surface matches that precedent rather than
    // opening a second, looser door onto the same value.
    humanOnly: true,
  },
  // ------------------------------------------------------------------- runs
  {
    key: "concurrencyLimit",
    group: "Runs",
    label: "Concurrency limit",
    description:
      "How many sessions may run at once (§4.1). Initiation beyond it queues; it never refuses.",
    type: "number",
    // Zero is refused here exactly as `PLOTROOM_CONCURRENCY_LIMIT` refuses it:
    // a limit of none is spelled by setting it high, and a stored zero would
    // refuse every admission for ever.
    bound: CONCURRENCY_LIMIT_BOUND,
    path: ["concurrencyLimit"],
    envVar: "PLOTROOM_CONCURRENCY_LIMIT",
    appliesWithoutRestart: true,
    humanOnly: true,
  },
  // ------------------------------------------------------------- maintenance
  {
    key: "compactionIntervalSeconds",
    group: "Maintenance",
    label: "Compaction interval (seconds)",
    description:
      "Seconds between version-compaction sweeps (§15-3). Zero disables the schedule; the on-demand sweep stays available.",
    type: "number",
    bound: INTERVAL_SECONDS_BOUND,
    path: ["compactionIntervalSeconds"],
    envVar: "PLOTROOM_COMPACTION_INTERVAL_SECONDS",
    appliesWithoutRestart: true,
    humanOnly: true,
  },
  // -------------------------------------------------------------- attention
  {
    key: "attentionTickSeconds",
    group: "Attention",
    label: "Attention tick (seconds)",
    description:
      "Seconds between re-derivations of the attention queue (§7). The queue still re-derives on every observed change; this only affects the two clock-only facts.",
    type: "number",
    bound: INTERVAL_SECONDS_BOUND,
    path: ["attentionTickSeconds"],
    envVar: "PLOTROOM_ATTENTION_TICK_SECONDS",
    appliesWithoutRestart: true,
    humanOnly: true,
  },
  // ----------------------------------------------------------- integrations
  {
    key: "integrationTickSeconds",
    group: "Integrations",
    label: "Integration refresh tick (seconds)",
    description:
      "Seconds between scheduled-refresh checks (§9.1). On-demand refresh stays available regardless.",
    type: "number",
    bound: INTERVAL_SECONDS_BOUND,
    path: ["integrationTickSeconds"],
    envVar: "PLOTROOM_INTEGRATION_TICK_SECONDS",
    appliesWithoutRestart: true,
    humanOnly: true,
  },
  // ---------------------------------------------------------------- plugins
  {
    key: "pluginsDirectory",
    group: "Plugins",
    label: "Plugins directory",
    description:
      "A directory of installable plugins, scanned on demand (§10.2).",
    type: "string",
    path: ["pluginsDirectory"],
    envVar: "PLOTROOM_PLUGINS_DIR",
    appliesWithoutRestart: false,
    restartReason:
      "plugins are scanned once at boot; there is no rescan gesture yet, so changing this takes effect on the next start",
    humanOnly: true,
  },
  // ---------------------------------------------------------------- runtime
  {
    key: "runtime.adapterId",
    group: "Runtime",
    label: "Session runtime adapter",
    description: `Which adapter runs new sessions (decision 0001). Default: ${DEFAULT_RUNTIME_ADAPTER}.`,
    type: "string",
    path: ["runtime", "adapterId"],
    envVar: "PLOTROOM_RUNTIME",
    appliesWithoutRestart: false,
    restartReason:
      "the runtime registry is built once at boot from this value; changing this takes effect on the next start",
    humanOnly: true,
  },
  {
    key: "runtime.piProgram",
    group: "Runtime",
    label: "pi binary",
    description:
      "The pi binary, for hosts that keep it somewhere other than PATH.",
    type: "string",
    path: ["runtime", "piProgram"],
    envVar: "PLOTROOM_PI_PROGRAM",
    appliesWithoutRestart: false,
    restartReason:
      "the runtime registry is built once at boot from this value; changing this takes effect on the next start",
    humanOnly: true,
  },
  // -------------------------------------------------------------- workspaces
  {
    key: "workspace.kind",
    group: "Workspaces",
    label: "Workspace kind",
    description: "Which workspace mechanism provisions new workstreams (§3.4).",
    type: "string",
    path: ["workspace", "kind"],
    envVar: "PLOTROOM_WORKSPACE_KIND",
    appliesWithoutRestart: false,
    restartReason:
      "read from the server's boot configuration when a workspace is provisioned; changing this takes effect on the next start",
    humanOnly: true,
  },
  {
    key: "workspace.repositoryPath",
    group: "Workspaces",
    label: "Repository path",
    description:
      "An existing checkout to branch from, shared via git worktree.",
    type: "string",
    path: ["workspace", "repositoryPath"],
    envVar: "PLOTROOM_WORKSPACE_REPO",
    appliesWithoutRestart: false,
    restartReason:
      "read from the server's boot configuration when a workspace is provisioned; changing this takes effect on the next start",
    humanOnly: true,
  },
  {
    key: "workspace.remoteUrl",
    group: "Workspaces",
    label: "Remote URL",
    description: "Cloned from when there is no local checkout to share.",
    type: "string",
    path: ["workspace", "remoteUrl"],
    envVar: "PLOTROOM_WORKSPACE_REMOTE",
    appliesWithoutRestart: false,
    restartReason:
      "read from the server's boot configuration when a workspace is provisioned; changing this takes effect on the next start",
    humanOnly: true,
  },
  {
    key: "workspace.branchTemplate",
    group: "Workspaces",
    label: "Branch template",
    description: "The branch-name template new workspaces provision under.",
    type: "string",
    path: ["workspace", "branchTemplate"],
    envVar: "PLOTROOM_WORKSPACE_BRANCH_TEMPLATE",
    appliesWithoutRestart: false,
    restartReason:
      "read from the server's boot configuration when a workspace is provisioned; changing this takes effect on the next start",
    humanOnly: true,
  },
  {
    key: "workspace.baseRef",
    group: "Workspaces",
    label: "Base ref",
    description:
      "The ref new branches are cut from, when not the remote default.",
    type: "string",
    path: ["workspace", "baseRef"],
    envVar: "PLOTROOM_WORKSPACE_BASE_REF",
    appliesWithoutRestart: false,
    restartReason:
      "read from the server's boot configuration when a workspace is provisioned; changing this takes effect on the next start",
    humanOnly: true,
  },
] as const;

export function findSetting(key: string): SettingDefinition | undefined {
  return SETTINGS_CATALOG.find((entry) => entry.key === key);
}

/**
 * Why `value` is not a legal value for `entry`, as the tail of "X must be …", or
 * `null` when it is legal.
 *
 * The one place a settings value is judged. Two callers need the same answer for
 * different reasons — the route refuses a **write** with it, and boot refuses to
 * apply a **stored** value with it — and a stored value only the write path
 * checked is one an older build (or a hand-edited store) walks straight past:
 * that is how a `concurrencyLimit` of `0` survived restarts, and how a stored
 * `"abc"` would have been handed to the queue as its limit.
 */
export function checkSettingValue(
  entry: SettingDefinition,
  value: unknown,
): string | null {
  switch (entry.type) {
    case "string":
      // Null is a value here, not an absence: a credential that is not set.
      return value === null || typeof value === "string"
        ? null
        : "a string or null";
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return "a finite number";
      }
      return entry.bound === undefined ? null : checkBound(entry.bound, value);
    }
    case "boolean":
      return typeof value === "boolean" ? null : "a boolean";
    case "enum":
      return typeof value === "string" && entry.enumValues?.includes(value)
        ? null
        : `one of: ${(entry.enumValues ?? []).join(", ")}`;
    case "string[]":
      return Array.isArray(value) &&
        value.every((item): item is string => typeof item === "string")
        ? null
        : "an array of strings";
  }
}

/** Reads `path` off any nested object, returning `undefined` short of the leaf. */
export function readPath(source: unknown, path: readonly string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Writes `value` at `path` into a plain object tree, building intermediates. */
export function writePath(
  target: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  let current: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i] as string;
    const next = current[segment];
    if (next === null || typeof next !== "object") {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  const last = path.at(-1);
  if (last !== undefined) current[last] = value;
}
