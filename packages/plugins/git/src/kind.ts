/**
 * The git workspace kind, as a plugin contribution (§3.4, §9.4, §10.1).
 *
 * This is the port the contract was shaped against: `checkConfig` / `provision` /
 * `runSetup` / `status` / `fingerprint` / `remove` over an opaque JSON config and
 * multi-root units. Three of §3.4's rules are mechanics here rather than intentions:
 *
 * - **An existing branch is never renamed or re-derived** — a local branch that
 *   exists is checked out as it is, and the fact is reported as a note.
 * - **A branch that exists remotely is taken from the remote**, so a checkout of
 *   someone else's branch has that branch's actual commits.
 * - **Workspace authentication is the host's.** Every command goes through `runGit`,
 *   whose environment is an allowlist of host configuration; the provisioned
 *   checkout's own git config is then read back and refused if anything credential
 *   shaped was written into it. This plugin declares no credential permission, so
 *   there is no token here to leak into a remote URL in the first place.
 *
 * Two things the contract asks a kind for that a kind cannot know, answered honestly
 * rather than plausibly:
 *
 * - **`readiness`** is derived by core from records — was it provisioned, did the
 *   declared setup step run — and a mechanism cannot see either. So this kind answers
 *   the only mechanism-level facts it has: `unprovisioned` when no root reads as a
 *   checkout, `ready` when they do. It never claims `setup-required` or `ready`
 *   *because* setup passed; that gate stays core's.
 * - **A removal refusal has no reason field** in the contract, only a message and
 *   `forcible`. The protections still refuse — the primary checkout and the default
 *   branch are never removable, and uncommitted work needs `force` — and each names
 *   itself in the message.
 */
import type {
  PluginCallContext,
  ProvisionOutcome,
  ProvisionRequest,
  RemovalOutcome,
  SetupAttemptResult,
  SetupRequest,
  UnitFingerprint,
  WorkspaceConfigCheck,
  WorkspaceFingerprint,
  WorkspaceKind,
  WorkspaceKindConfig,
  WorkspaceRef,
  WorkspaceStatus,
  WorkspaceUnitStatus,
} from "@plotroom/plugin-sdk";

import {
  parseGitConfig,
  resolveBranchName,
  type GitWorkspaceConfig,
} from "./config.js";
import {
  describeInvocation,
  findCredentialMaterial,
  gitFailureMessage,
  hostGitEnv,
  isHostAuthFailure,
  runGit,
  type GitContext,
  type GitOutcome,
} from "./exec.js";
import { readDefaultBranch } from "./reads.js";
import {
  describeError,
  readGitStatus,
  readUpstreamHead,
  unitFingerprintFrom,
  unitStatusFrom,
  unreadableFingerprint,
} from "./status.js";

export const GIT_WORKSPACE_KIND_ID = "git";
export const GIT_ROOT_KEY = "root";

export interface GitKindDeps {
  readonly git: GitContext;
  readonly clock: () => number;
  /** An existing directory for commands that create their own target (clone). */
  readonly scratchDirectory: string;
  /** Optional: an unmeasurable disk cost is reported as unknown, never as zero. */
  readonly diskUsage?: (path: string) => Promise<number | null>;
  /** Without it, removing a clone is refused rather than half-done. */
  readonly removeDirectory?: (path: string) => Promise<void>;
}

export function createGitWorkspaceKind(
  deps: GitKindDeps,
  permissions: readonly string[],
): WorkspaceKind {
  const git = deps.git;

  return {
    id: GIT_WORKSPACE_KIND_ID,
    label: "Git repository",
    permissions,

    checkConfig(config: WorkspaceKindConfig): WorkspaceConfigCheck {
      const parsed = parseGitConfig(config);
      return parsed.valid
        ? { valid: true }
        : { valid: false, refusal: parsed.refusal };
    },

    async provision(
      request: ProvisionRequest,
      context: PluginCallContext,
    ): Promise<ProvisionOutcome> {
      const parsed = parseGitConfig(request.config);
      if (!parsed.valid) {
        return {
          provisioned: false,
          failure: {
            reason: "invalid_config",
            message: parsed.refusal.message,
            log: [],
          },
        };
      }
      const config = parsed.config;
      const started = deps.clock();
      const log: string[] = [];
      const notes: string[] = [];
      const branch = resolveBranchName(config, String(request.workspaceId));
      context.log(`provisioning ${config.workspacePath} on ${branch}`);

      const strategy =
        config.strategy === "auto"
          ? config.repositoryPath !== null
            ? "worktree"
            : "clone"
          : config.strategy;

      const created =
        strategy === "worktree"
          ? await provisionByWorktree(deps, config, branch, log, notes)
          : await provisionByClone(deps, config, branch, log, notes);
      if (created !== null) {
        return created;
      }

      const written = await readLocalConfig(git, config.workspacePath);
      const findings = findCredentialMaterial(written);
      if (findings.length > 0) {
        return {
          provisioned: false,
          failure: {
            reason: "mechanism_failed",
            message:
              `The provisioned workspace's own git configuration contains ` +
              `${findings.map((finding) => finding.detail).join(", ")}; ` +
              `workspace git uses the host's own authentication (§3.4).`,
            log: [...log],
          },
        };
      }

      const bytesOnDisk =
        deps.diskUsage === undefined
          ? null
          : await deps.diskUsage(config.workspacePath);

      return {
        provisioned: true,
        roots: [{ rootKey: GIT_ROOT_KEY, path: config.workspacePath }],
        cost: {
          elapsedMillis: deps.clock() - started,
          bytesOnDisk,
          // A worktree shares the checkout's object store, which is the cheapest
          // reuse git offers; a clone reuses nothing.
          sharedCache: strategy === "worktree" ? "hit" : "miss",
          strategy,
        },
        log: [...log],
        notes: [...notes],
      };
    },

    async runSetup(
      request: SetupRequest,
      context: PluginCallContext,
    ): Promise<SetupAttemptResult> {
      const root = request.workspace.roots[0];
      if (root === undefined) {
        return {
          ok: false,
          exitCode: null,
          output: "The workspace has no provisioned root to run setup in.",
          finishedAt: deps.clock(),
        };
      }
      const cwd =
        request.workingSubdirectory === ""
          ? root.path
          : `${root.path.replace(/\/+$/u, "")}/${request.workingSubdirectory}`;
      context.log(`running setup: ${request.program} (in ${cwd})`);

      try {
        const result = await git.exec({
          program: request.program,
          args: request.args,
          cwd,
          // The setup step runs with the host's environment too: a workspace is
          // exactly where an app credential must not appear (§3.4).
          env: hostGitEnv(git.hostEnvironment),
        });
        return {
          ok: result.exitCode === 0,
          exitCode: result.exitCode,
          // Kept whole: setup output is inspectable and never shortened
          // (principle 12).
          output: [result.stdout, result.stderr]
            .filter((s) => s !== "")
            .join(""),
          finishedAt: deps.clock(),
        };
      } catch (error) {
        return {
          ok: false,
          exitCode: null,
          output: `${request.program} could not be started: ${describeError(error)}`,
          finishedAt: deps.clock(),
        };
      }
    },

    async status(workspace: WorkspaceRef): Promise<WorkspaceStatus> {
      const units: WorkspaceUnitStatus[] = [];
      const unavailable: string[] = [];

      for (const root of workspace.roots) {
        const read = await readGitStatus(git, root.path);
        if (!read.read) {
          unavailable.push(`${root.path}: ${read.message}`);
          continue;
        }
        units.push(unitStatusFrom(root.rootKey, root.path, read.value));
      }

      return {
        observedAt: deps.clock(),
        // Mechanism-level only; the readiness gate is core's (see this file's note).
        readiness:
          workspace.roots.length === 0
            ? "unprovisioned"
            : units.length === 0
              ? "provision-failed"
              : "ready",
        units,
        unavailable: unavailable.length === 0 ? null : unavailable.join("; "),
      };
    },

    async fingerprint(workspace: WorkspaceRef): Promise<WorkspaceFingerprint> {
      const units: UnitFingerprint[] = [];
      for (const root of workspace.roots) {
        const read = await readGitStatus(git, root.path);
        if (!read.read) {
          // Observed, never inferred (principle 7): a root that could not be read
          // reports itself unreadable rather than clean.
          units.push(unreadableFingerprint(root.rootKey, read.message));
          continue;
        }
        const upstreamHead = await readUpstreamHead(
          git,
          root.path,
          read.value.upstream,
        );
        units.push(unitFingerprintFrom(root.rootKey, read.value, upstreamHead));
      }
      return { observedAt: deps.clock(), units };
    },

    async remove(
      workspace: WorkspaceRef,
      options: { readonly force: boolean },
    ): Promise<RemovalOutcome> {
      const root = workspace.roots[0];
      if (root === undefined) {
        return {
          removed: true,
          log: ["Nothing to remove: no provisioned root."],
        };
      }

      const read = await readGitStatus(git, root.path);
      if (!read.read) {
        return {
          removed: false,
          refusal: { message: read.message, forcible: false },
        };
      }
      const status = unitStatusFrom(root.rootKey, root.path, read.value);
      const parsed = parseGitConfig(workspace.config);
      const remoteName = parsed.valid ? parsed.config.remoteName : "origin";
      const clonedByThisKind =
        parsed.valid &&
        parsed.config.remoteUrl !== null &&
        parsed.config.workspacePath.replace(/\/+$/u, "") ===
          root.path.replace(/\/+$/u, "");

      const mainCheckout = await resolveMainCheckout(git, root.path);
      // The primary checkout is never removable (§3.4) — and the contract's
      // `WorkspaceRoot` carries no `primaryCheckout` flag for a kind to check, so
      // the kind refuses anything it cannot show it made: a linked worktree it can
      // detach, or a clone its own configuration names. An adopted checkout is
      // therefore never deleted by mistake, which is the safe side of the gap.
      if (mainCheckout === null && !clonedByThisKind) {
        return {
          removed: false,
          refusal: {
            message:
              `${root.path} is a checkout this workspace kind did not provision ` +
              `(it is no linked worktree, and its configuration names no remote it was cloned from). ` +
              `A repository's primary checkout is never removable (§3.4).`,
            forcible: false,
          },
        };
      }
      if (mainCheckout === null && deps.removeDirectory === undefined) {
        return {
          removed: false,
          refusal: {
            message:
              "This workspace is a clone, and the host supplied no way to delete a directory.",
            forcible: false,
          },
        };
      }
      const defaultBranch = await readDefaultBranch(git, root.path, remoteName);
      if (status.branch !== null && status.branch === defaultBranch) {
        return {
          removed: false,
          refusal: {
            message: `${status.branch} is this repository's default branch, which is never removable (§3.4).`,
            forcible: false,
          },
        };
      }
      const dirty = status.uncommitted.length + status.untracked.length;
      if (dirty > 0 && !options.force) {
        return {
          removed: false,
          refusal: {
            message: `${root.path} has ${dirty} uncommitted change${dirty === 1 ? "" : "s"}; removing it would lose them. Force-remove to override (§3.4).`,
            forcible: true,
          },
        };
      }

      const log: string[] = [];
      if (mainCheckout !== null) {
        const args = ["worktree", "remove", root.path];
        if (options.force) {
          args.push("--force");
        }
        const removed = await runGit(git, { cwd: mainCheckout, args });
        log.push(describeInvocation(removed));
        if (removed.exitCode !== 0) {
          return {
            removed: false,
            refusal: {
              message: gitFailureMessage(removed),
              forcible: false,
            },
          };
        }
        return { removed: true, log };
      }

      const removeDirectory = deps.removeDirectory;
      if (removeDirectory === undefined) {
        return {
          removed: false,
          refusal: {
            message:
              "This workspace is a clone, and the host supplied no way to delete a directory.",
            forcible: false,
          },
        };
      }
      try {
        await removeDirectory(root.path);
        log.push(`removed ${root.path}`);
        return { removed: true, log };
      } catch (error) {
        return {
          removed: false,
          refusal: {
            message: `${root.path} could not be deleted: ${describeError(error)}`,
            forcible: false,
          },
        };
      }
    },
  };
}

/* ------------------------------------------------------------- provisioning */

/** Returns a failure outcome, or null when the checkout was created. */
async function provisionByWorktree(
  deps: GitKindDeps,
  config: GitWorkspaceConfig,
  branch: string,
  log: string[],
  notes: string[],
): Promise<ProvisionOutcome | null> {
  const git = deps.git;
  const repository = config.repositoryPath as string;

  const localBranch = await runGit(git, {
    cwd: repository,
    args: ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
  });
  log.push(describeInvocation(localBranch));

  if (localBranch.exitCode === 0) {
    notes.push(
      `${branch} already exists in ${repository}; taken as it is, never renamed or re-derived (§3.4).`,
    );
    const added = await runGit(git, {
      cwd: repository,
      args: ["worktree", "add", config.workspacePath, branch],
    });
    log.push(describeInvocation(added));
    return added.exitCode === 0 ? null : failure(added, log);
  }

  const remote = await runGit(git, {
    cwd: repository,
    args: ["ls-remote", "--heads", config.remoteName, branch],
  });
  log.push(describeInvocation(remote));

  if (remote.exitCode === 0 && remote.stdout.trim() !== "") {
    // A branch that exists remotely is taken from the remote, so the checkout has
    // that branch's actual commits (§3.4).
    notes.push(
      `${branch} exists on ${config.remoteName}; taken from the remote so it has that branch's actual commits (§3.4).`,
    );
    const fetched = await runGit(git, {
      cwd: repository,
      args: ["fetch", config.remoteName, branch],
    });
    log.push(describeInvocation(fetched));
    if (fetched.exitCode !== 0) {
      return failure(fetched, log);
    }
    const added = await runGit(git, {
      cwd: repository,
      args: [
        "worktree",
        "add",
        "--track",
        "-b",
        branch,
        config.workspacePath,
        `${config.remoteName}/${branch}`,
      ],
    });
    log.push(describeInvocation(added));
    return added.exitCode === 0 ? null : failure(added, log);
  }

  const startPoint = config.baseRef ?? "HEAD";
  const added = await runGit(git, {
    cwd: repository,
    args: ["worktree", "add", "-b", branch, config.workspacePath, startPoint],
  });
  log.push(describeInvocation(added));
  if (added.exitCode !== 0) {
    return failure(added, log);
  }
  notes.push(`${branch} was created from ${startPoint}.`);
  return null;
}

async function provisionByClone(
  deps: GitKindDeps,
  config: GitWorkspaceConfig,
  branch: string,
  log: string[],
  notes: string[],
): Promise<ProvisionOutcome | null> {
  const git = deps.git;
  const cloned = await runGit(git, {
    cwd: deps.scratchDirectory,
    args: [
      "clone",
      "--origin",
      config.remoteName,
      config.remoteUrl as string,
      config.workspacePath,
    ],
  });
  log.push(describeInvocation(cloned));
  if (cloned.exitCode !== 0) {
    return failure(cloned, log);
  }

  const existing = await runGit(git, {
    cwd: config.workspacePath,
    args: [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/${config.remoteName}/${branch}`,
    ],
  });
  log.push(describeInvocation(existing));

  const checkout =
    existing.exitCode === 0
      ? await runGit(git, {
          cwd: config.workspacePath,
          args: ["checkout", "--track", `${config.remoteName}/${branch}`],
        })
      : await runGit(git, {
          cwd: config.workspacePath,
          args: [
            "checkout",
            "-b",
            branch,
            ...(config.baseRef === null ? [] : [config.baseRef]),
          ],
        });
  log.push(describeInvocation(checkout));
  if (checkout.exitCode !== 0) {
    return failure(checkout, log);
  }
  notes.push(
    existing.exitCode === 0
      ? `${branch} exists on ${config.remoteName}; taken from the remote (§3.4).`
      : `${branch} was created in the fresh clone.`,
  );
  return null;
}

/** git's own error text, classified into the contract's typed failure reasons. */
function failure(
  outcome: GitOutcome,
  log: readonly string[],
): ProvisionOutcome {
  const occupied =
    /already exists|not an empty directory|destination path .* exists/iu.test(
      outcome.stderr,
    );
  return {
    provisioned: false,
    failure: {
      reason: isHostAuthFailure(outcome)
        ? "host_auth"
        : occupied
          ? "occupied"
          : "mechanism_failed",
      message: gitFailureMessage(outcome),
      log: [...log],
    },
  };
}

async function readLocalConfig(
  context: GitContext,
  path: string,
): Promise<string> {
  const outcome = await runGit(context, {
    cwd: path,
    args: ["config", "--local", "--list"],
  });
  return outcome.exitCode === 0 ? outcome.stdout : "";
}

/**
 * The checkout a linked worktree belongs to, or null when this is a standalone
 * clone. `git worktree remove` is run from there, never from inside the directory
 * being removed.
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
  if (gitDir.exitCode !== 0 || commonDir.exitCode !== 0) {
    return null;
  }
  const own = gitDir.stdout.trim();
  const common = commonDir.stdout.trim();
  if (own === common || common === "") {
    return null;
  }
  return common.replace(/\/\.git\/?$/u, "");
}
