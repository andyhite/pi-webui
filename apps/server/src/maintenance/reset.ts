import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WorkspaceKindRegistry } from "@plotroom/core";
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
  /**
   * Checkouts holding work that exists nowhere else (§12). Empty for a scope
   * that deletes no checkout — and empty is a *finding*, not a default: a
   * workspace whose status could not be read is listed with `unreadable` set
   * rather than left out as though it were clean.
   */
  readonly dirtyWorkspaces: readonly DirtyWorkspace[];
}

/** One checkout with something in it git does not have somewhere else. */
export interface DirtyWorkspace {
  readonly workspaceId: string;
  readonly workstreamId: string;
  readonly path: string;
  readonly branch: string | null;
  readonly uncommitted: readonly string[];
  readonly untracked: readonly string[];
  /** Commits this checkout has and its upstream does not; null when unknown. */
  readonly ahead: number | null;
  /**
   * True when this reset deletes the files. False means only the record is
   * forgotten — an attached checkout outside the workspaces directory keeps its
   * files, and saying otherwise would be a scarier claim than the truth.
   */
  readonly filesDeleted: boolean;
  /** Why the status could not be read; null when it was read (§3.4). */
  readonly unreadable: string | null;
  readonly what: string;
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

/**
 * Which provisioned checkouts hold work that only exists there (§12, §3.4).
 *
 * Read-only: this asks the workspace kind for live status, the same read the
 * workspace card uses, and touches nothing. A kind that cannot answer produces
 * an entry saying so — "we could not look" and "there is nothing there" are
 * different sentences, and only one of them is safe to act on.
 */
async function dirtyWorkspaces(
  maintenance: Maintenance,
  kinds: WorkspaceKindRegistry,
  config: ServerConfig,
  scope: ResetScope,
): Promise<DirtyWorkspace[]> {
  if (scope === "arrangement") return [];

  const workspacesDir = resolve(config.workspace.directory);
  const dirty: DirtyWorkspace[] = [];

  for (const workspace of maintenance.provisionedWorkspaceRecords()) {
    const lookup = kinds.require(workspace.kind);
    const inside = workspace.roots.some((root) =>
      resolve(root.path).startsWith(`${workspacesDir}/`),
    );

    const describe = (
      extra: Omit<
        DirtyWorkspace,
        "workspaceId" | "workstreamId" | "filesDeleted" | "what"
      >,
    ): DirtyWorkspace => ({
      workspaceId: workspace.id,
      workstreamId: workspace.workstreamId,
      filesDeleted: inside,
      what: inside
        ? "this checkout is deleted, and what is in it goes with it"
        : "this checkout is outside the workspaces directory, so its files stay; PlotRoom forgets it and provisions a new one",
      ...extra,
    });

    if (!lookup.available) {
      dirty.push(
        describe({
          path: workspace.roots[0]?.path ?? "unknown",
          branch: null,
          uncommitted: [],
          untracked: [],
          ahead: null,
          unreadable: lookup.refusal.message,
        }),
      );
      continue;
    }

    let status;
    try {
      status = await lookup.kind.status(workspace);
    } catch (error) {
      dirty.push(
        describe({
          path: workspace.roots[0]?.path ?? "unknown",
          branch: null,
          uncommitted: [],
          untracked: [],
          ahead: null,
          unreadable: error instanceof Error ? error.message : String(error),
        }),
      );
      continue;
    }

    for (const unit of status.units) {
      const hasWork =
        unit.uncommitted.length > 0 ||
        unit.untracked.length > 0 ||
        (unit.ahead ?? 0) > 0;
      if (!hasWork) continue;

      dirty.push(
        describe({
          path: unit.path,
          branch: unit.branch,
          uncommitted: unit.uncommitted,
          untracked: unit.untracked,
          ahead: unit.ahead,
          unreadable: null,
        }),
      );
    }

    // The mechanism could not be read at all: reported, never taken as clean.
    if (status.unavailable !== null) {
      dirty.push(
        describe({
          path: workspace.roots[0]?.path ?? "unknown",
          branch: null,
          uncommitted: [],
          untracked: [],
          ahead: null,
          unreadable: status.unavailable,
        }),
      );
    }
  }

  return dirty;
}

/**
 * The plan (§12). Async because the honest version of "what will this remove"
 * includes asking the checkouts whether they are holding anything, which means
 * talking to git.
 */
export async function planReset(
  maintenance: Maintenance,
  kinds: WorkspaceKindRegistry,
  config: ServerConfig,
  scope: ResetScope,
): Promise<FullResetPlan> {
  const plan = maintenance.resetPlan(scope);
  const dirty = await dirtyWorkspaces(maintenance, kinds, config, scope);

  return {
    ...plan,
    // Named individually, above the general warning: "three workspaces will be
    // deleted" is a fact an operator can dismiss; "this branch has two commits
    // you have not pushed" is one they cannot.
    removes: [...plan.removes, ...dirty.map(describeDirty)],
    paths: pathsForScope(scope, resetPaths(config)),
    dirtyWorkspaces: dirty,
  };
}

function describeDirty(workspace: DirtyWorkspace): string {
  if (workspace.unreadable !== null) {
    return `${workspace.path} could not be read (${workspace.unreadable}), so whether it holds unsaved work is unknown — check it before confirming`;
  }

  const held = [
    workspace.uncommitted.length > 0
      ? `${workspace.uncommitted.length} uncommitted ${workspace.uncommitted.length === 1 ? "change" : "changes"}`
      : null,
    workspace.untracked.length > 0
      ? `${workspace.untracked.length} untracked ${workspace.untracked.length === 1 ? "file" : "files"}`
      : null,
    (workspace.ahead ?? 0) > 0
      ? `${workspace.ahead} unpushed ${workspace.ahead === 1 ? "commit" : "commits"}`
      : null,
  ].filter((part): part is string => part !== null);

  const where =
    workspace.branch === null
      ? workspace.path
      : `${workspace.path} (${workspace.branch})`;

  return `${where} holds ${held.join(", ")} — ${workspace.what}`;
}

/**
 * Execute a reset. Directories go after the rows, so a failure part-way leaves
 * the store consistent with what it says about itself rather than pointing at
 * checkouts that are gone.
 *
 * A provisioned checkout is the operator's own git working tree, and §3.4's
 * removal protections govern the *managed* removal of one workspace. This is the
 * explicit factory-reset verb instead — which is why the plan names every
 * directory that goes, and every checkout holding work that exists nowhere else,
 * before anything is deleted.
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
