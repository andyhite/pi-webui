import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Maintenance, ResetPlan, ResetScope } from "@plotroom/db";
import type { ServerConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";

/**
 * Reset and cleanup (§12, Epic 2.3): "each stating what it removes first".
 *
 * `@plotroom/db`'s `Maintenance` owns the store's half; this owns the half that
 * lives on disk outside it — provisioned workspaces, the shared git cache, the
 * generated runtime extension — because those paths are the server's
 * configuration, not the schema's.
 *
 * The two halves are always reported together. An operator asked to confirm a
 * reset needs one answer, not two lists that each omit what the other does.
 */
export interface ResetPaths {
  /** Provisioned workspaces (§3.4): derived, and re-provisioned at the next run. */
  readonly workspacesDir: string;
  /** The shared git mirror cache: makes provisioning cheap, never correct. */
  readonly gitCacheDir: string;
  /** The generated pi permission gate, rewritten on every start. */
  readonly runtimeDir: string;
}

export interface FullResetPlan extends ResetPlan {
  /** Directories that would go, with whether they exist right now. */
  readonly paths: readonly {
    readonly path: string;
    readonly what: string;
    readonly exists: boolean;
  }[];
}

export interface FullResetResult {
  readonly scope: ResetScope;
  readonly removed: Readonly<Record<string, number>>;
  readonly removedPaths: readonly string[];
}

export function resetPaths(config: ServerConfig): ResetPaths {
  return {
    workspacesDir: config.workspace.directory,
    gitCacheDir: join(config.stateDir, "git-cache"),
    runtimeDir: join(config.stateDir, "runtime"),
  };
}

/**
 * What a scope would remove on disk. `arrangement` touches no path at all —
 * saying so explicitly is the point, since "reset" reads alarmingly and this one
 * is the harmless one.
 */
export function pathsForScope(
  scope: ResetScope,
  paths: ResetPaths,
): FullResetPlan["paths"] {
  if (scope === "arrangement") return [];

  const derived = [
    {
      path: paths.workspacesDir,
      what: "provisioned workspaces; the next run provisions again",
      exists: existsSync(paths.workspacesDir),
    },
    {
      path: paths.gitCacheDir,
      what: "the shared git mirror cache; provisioning is slower without it",
      exists: existsSync(paths.gitCacheDir),
    },
    {
      path: paths.runtimeDir,
      what: "the generated runtime extension; rewritten at every start",
      exists: existsSync(paths.runtimeDir),
    },
  ];

  return derived;
}

export function planReset(
  maintenance: Maintenance,
  config: ServerConfig,
  scope: ResetScope,
): FullResetPlan {
  const plan = maintenance.resetPlan(scope);
  return { ...plan, paths: pathsForScope(scope, resetPaths(config)) };
}

/**
 * Execute a reset. Directories go after the rows, so a failure part-way leaves
 * the store consistent with what it says about itself rather than pointing at
 * checkouts that are gone.
 *
 * Uncommitted work in a provisioned workspace is the operator's own git working
 * tree; §3.4's removal protections are about *managed* removal of one workspace,
 * and this is the explicit factory-reset verb — which is why the plan says
 * exactly which directories go before anything is deleted.
 */
export function executeReset(
  maintenance: Maintenance,
  config: ServerConfig,
  scope: ResetScope,
  logger: Logger,
): FullResetResult {
  const result = maintenance.reset(scope);
  const removedPaths: string[] = [];

  for (const entry of pathsForScope(scope, resetPaths(config))) {
    if (!entry.exists) continue;
    rmSync(entry.path, { recursive: true, force: true });
    removedPaths.push(entry.path);
  }

  logger.warn("reset executed", {
    scope,
    removed: result.removed,
    removedPaths,
  });

  return { scope, removed: result.removed, removedPaths };
}
