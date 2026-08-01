import type { UnitFingerprint, WorkspaceFingerprint } from "../divergence.js";
import type {
  CommandExec,
  DiskUsageProbe,
  EpochMillis,
  MillisClock,
} from "../exec.js";
import type { WorkspaceFs } from "../fs.js";
import { newSetupAttemptId } from "../ids.js";
import {
  GIT_WORKSPACE_KIND,
  type DiscoveryRequest,
  type DiscoveryResult,
  type ProvisionOutcome,
  type ProvisionRequest,
  type RemovalOptions,
  type RemovalOutcome,
  type WorkspaceConfigCheck,
  type WorkspaceKind,
  type WorkspaceKindConfig,
  type WorkspaceStatus,
  type WorkspaceUnitStatus,
} from "../kind.js";
import { checkRemoval } from "../lifecycle.js";
import type { ResolvedSetup, SetupAttempt } from "../readiness.js";
import type { Workspace, WorkspaceRoot } from "../workspace.js";
import { parseGitConfig } from "./config.js";
import { discoverGitRepositories } from "./discovery.js";
import {
  describeInvocation,
  gitFailureMessage,
  runGit,
  type GitContext,
} from "./exec.js";
import { hostGitEnv } from "./host-auth.js";
import { provisionGitWorkspace } from "./provision.js";
import {
  probeHeadReachable,
  readGitStatus,
  readUpstreamHead,
  unitFingerprintFrom,
  unitStatusFrom,
} from "./status.js";

/**
 * The git workspace kind (§3.4) — the first implementation of the kind
 * contract, and the one every later kind is shaped against.
 *
 * It supplies mechanism only. The boundary, the readiness gate, the removal
 * protections, and the divergence verdict are the product's, in the modules
 * above this one; this file calls them rather than restating them.
 */

export interface GitKindDeps {
  readonly exec: CommandExec;
  readonly fs: WorkspaceFs;
  readonly clock: MillisClock;
  /** The host's environment, allowlisted before any command sees it (§3.4). */
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
  /** An existing directory for commands that create their own target. */
  readonly scratchDirectory: string;
  readonly gitProgram?: string;
  readonly diskUsage?: DiskUsageProbe;
  /**
   * Removing a cloned workspace is a directory deletion, which the domain
   * describes and the host performs. Without it, removing a clone is refused
   * rather than half-done.
   */
  readonly removeDirectory?: (path: string) => Promise<void>;
}

export function createGitWorkspaceKind(deps: GitKindDeps): WorkspaceKind {
  const git: GitContext = {
    exec: deps.exec,
    hostEnvironment: deps.hostEnvironment,
    ...(deps.gitProgram === undefined ? {} : { gitProgram: deps.gitProgram }),
  };

  return {
    name: GIT_WORKSPACE_KIND,

    checkConfig(config: WorkspaceKindConfig): WorkspaceConfigCheck {
      const parsed = parseGitConfig(config);
      return parsed.valid
        ? { valid: true }
        : { valid: false, refusal: parsed.refusal };
    },

    provision(request: ProvisionRequest): Promise<ProvisionOutcome> {
      return provisionGitWorkspace(
        {
          git,
          clock: deps.clock,
          scratchDirectory: deps.scratchDirectory,
          ...(deps.diskUsage === undefined
            ? {}
            : { diskUsage: deps.diskUsage }),
        },
        request,
      );
    },

    async runSetup(
      workspace: Workspace,
      setup: ResolvedSetup,
      startedAt: EpochMillis,
    ): Promise<SetupAttempt> {
      const root = workspace.roots[0];
      const attemptId = newSetupAttemptId();
      if (root === undefined) {
        return {
          id: attemptId,
          setup,
          startedAt,
          finishedAt: deps.clock(),
          outcome: "failed",
          exitCode: null,
          stdout: "",
          stderr: "",
          failure: "The workspace has no provisioned root to run setup in.",
        };
      }

      const cwd =
        setup.workingSubdirectory === ""
          ? root.path
          : `${root.path.replace(/\/+$/u, "")}/${setup.workingSubdirectory}`;

      try {
        const result = await deps.exec({
          program: setup.program,
          args: setup.args,
          cwd,
          // The setup step runs with the host's environment too: a workspace is
          // exactly where an app credential must not appear (§3.4).
          env: hostGitEnv(deps.hostEnvironment),
        });
        return {
          id: attemptId,
          setup,
          startedAt,
          finishedAt: deps.clock(),
          outcome: result.exitCode === 0 ? "succeeded" : "failed",
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          failure: null,
        };
      } catch (error) {
        return {
          id: attemptId,
          setup,
          startedAt,
          finishedAt: deps.clock(),
          outcome: "failed",
          exitCode: null,
          stdout: "",
          stderr: "",
          failure: `${setup.label} could not be started: ${describeError(error)}`,
        };
      }
    },

    async status(workspace: Workspace): Promise<WorkspaceStatus> {
      const units: WorkspaceUnitStatus[] = [];
      const unavailable: string[] = [];

      for (const root of workspace.roots) {
        const read = await readGitStatus(git, root.path);
        if (!read.read) {
          unavailable.push(`${root.path}: ${read.message}`);
          continue;
        }
        units.push(unitStatusFrom(root.key, root.path, read.value));
      }

      return {
        workspaceId: workspace.id,
        kind: GIT_WORKSPACE_KIND,
        observedAt: deps.clock(),
        units,
        unavailable: unavailable.length === 0 ? null : unavailable.join("; "),
      };
    },

    async fingerprint(workspace: Workspace): Promise<WorkspaceFingerprint> {
      const units: UnitFingerprint[] = [];
      for (const root of workspace.roots) {
        const read = await readGitStatus(git, root.path);
        if (!read.read) continue;
        const upstreamHead = await readUpstreamHead(
          git,
          root.path,
          read.value.upstream,
        );
        units.push(unitFingerprintFrom(root.key, read.value, upstreamHead));
      }
      return {
        kind: GIT_WORKSPACE_KIND,
        observedAt: deps.clock(),
        units,
      };
    },

    async probeAncestry(
      workspace: Workspace,
      priorHeads: ReadonlyMap<string, string>,
    ): Promise<ReadonlyMap<string, boolean>> {
      const reachable = new Map<string, boolean>();
      for (const root of workspace.roots) {
        const priorHead = priorHeads.get(root.key);
        if (priorHead === undefined) continue;
        const answer = await probeHeadReachable(git, root.path, priorHead);
        if (answer !== null) reachable.set(root.key, answer);
      }
      return reachable;
    },

    async remove(
      workspace: Workspace,
      options: RemovalOptions,
    ): Promise<RemovalOutcome> {
      const root = workspace.roots[0];
      if (root === undefined) {
        return {
          removed: true,
          log: ["Nothing to remove: no provisioned root."],
        };
      }

      const log: string[] = [];
      const read = await readGitStatus(git, root.path);
      if (!read.read) {
        return {
          removed: false,
          refusal: {
            reason: "mechanism_failed",
            message: read.message,
            forcible: false,
          },
        };
      }

      const status = unitStatusFrom(root.key, root.path, read.value);
      const defaultBranch = await readDefaultBranch(git, root.path);
      const check = checkRemoval(
        {
          root,
          currentBranch: status.branch,
          defaultBranch,
          uncommittedCount: status.uncommitted.length + status.untracked.length,
        },
        options,
      );
      if (!check.allowed) return { removed: false, refusal: check.refusal };

      const mainCheckout = await resolveMainCheckout(git, root.path);
      if (mainCheckout !== null) {
        const args = ["worktree", "remove", root.path];
        if (options.force) args.push("--force");
        const removed = await runGit(git, { cwd: mainCheckout, args });
        log.push(describeInvocation(removed));
        if (removed.exitCode !== 0) {
          return {
            removed: false,
            refusal: {
              reason: "mechanism_failed",
              message: gitFailureMessage(removed),
              forcible: false,
            },
          };
        }
        return { removed: true, log };
      }

      if (deps.removeDirectory === undefined) {
        return {
          removed: false,
          refusal: {
            reason: "mechanism_failed",
            message:
              "This workspace is a clone, and the host supplied no way to delete a directory.",
            forcible: false,
          },
        };
      }

      try {
        await deps.removeDirectory(root.path);
        log.push(`removed ${root.path}`);
        return { removed: true, log };
      } catch (error) {
        return {
          removed: false,
          refusal: {
            reason: "mechanism_failed",
            message: `${root.path} could not be deleted: ${describeError(error)}`,
            forcible: false,
          },
        };
      }
    },

    discover(request: DiscoveryRequest): Promise<DiscoveryResult> {
      return discoverGitRepositories({ git, fs: deps.fs }, request);
    },
  };
}

/**
 * The checkout a linked worktree belongs to, or null when this is a standalone
 * clone. `git worktree remove` is run from there, never from inside the
 * directory being removed.
 */
async function resolveMainCheckout(
  context: GitContext,
  path: string,
): Promise<string | null> {
  const gitDir = await runGit(context, {
    cwd: path,
    args: ["rev-parse", "--path-format=absolute", "--git-dir"],
  });
  const commonDir = await runGit(context, {
    cwd: path,
    args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  });
  if (gitDir.exitCode !== 0 || commonDir.exitCode !== 0) return null;

  const own = gitDir.stdout.trim();
  const common = commonDir.stdout.trim();
  if (own === common || common === "") return null;

  return common.replace(/\/\.git\/?$/u, "");
}

export async function readDefaultBranch(
  context: GitContext,
  path: string,
): Promise<string | null> {
  const originHead = await runGit(context, {
    cwd: path,
    args: ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
  });
  if (originHead.exitCode === 0) {
    const value = originHead.stdout.trim();
    const stripped = value.startsWith("origin/") ? value.slice(7) : value;
    if (stripped !== "") return stripped;
  }

  const configured = await runGit(context, {
    cwd: path,
    args: ["config", "--get", "init.defaultBranch"],
  });
  if (configured.exitCode === 0) {
    const value = configured.stdout.trim();
    if (value !== "") return value;
  }

  return null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function primaryRoot(workspace: Workspace): WorkspaceRoot | null {
  return workspace.roots[0] ?? null;
}
