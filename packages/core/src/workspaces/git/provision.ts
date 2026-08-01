import type { DiskUsageProbe, MillisClock } from "../exec.js";
import type {
  ProvisionCost,
  ProvisionOutcome,
  ProvisionRequest,
  WorkspaceKindConfig,
} from "../kind.js";
import { resolveBranchName } from "./branch-template.js";
import {
  parseGitConfig,
  mirrorCacheKey,
  type GitWorkspaceConfig,
} from "./config.js";
import {
  describeInvocation,
  gitFailureMessage,
  isHostAuthFailure,
  runGit,
  type GitContext,
  type GitOutcome,
} from "./exec.js";
import { findCredentialMaterial } from "./host-auth.js";

/**
 * Git provisioning (§3.4, §3.5).
 *
 * Provisioning happens at **first run**, not at workstream creation, which is
 * why this is a plain operation the run path calls rather than a side effect of
 * creating anything.
 *
 * Three rules from the spec are mechanics here rather than intentions:
 *
 * - **An existing branch is never renamed or re-derived** — `resolveBranchName`
 *   returns it untouched, and a local branch that already exists is checked out
 *   rather than recreated.
 * - **A branch that exists remotely is taken from the remote**, so "a checkout
 *   of someone else's branch has that branch's actual commits".
 * - **Cost is reported** — the strategy used, whether shared storage was reused,
 *   how long it took, and what it put on disk (null when the host cannot say).
 */

export interface GitProvisionDeps {
  readonly git: GitContext;
  readonly clock: MillisClock;
  /**
   * An existing directory to run the commands that have no natural one in —
   * `clone` creates its target, so it cannot be run from inside it. The server
   * passes its state directory.
   */
  readonly scratchDirectory: string;
  /** Optional: an unmeasurable disk cost is reported as unknown, not as zero. */
  readonly diskUsage?: DiskUsageProbe;
}

interface Session {
  readonly log: string[];
  readonly notes: string[];
}

export async function provisionGitWorkspace(
  deps: GitProvisionDeps,
  request: ProvisionRequest & { readonly config: WorkspaceKindConfig },
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
  const session: Session = { log: [], notes: [] };

  const strategy =
    config.strategy === "auto"
      ? config.repositoryPath !== null
        ? "worktree"
        : "clone"
      : config.strategy;

  const result =
    strategy === "worktree"
      ? await provisionByWorktree(deps, config, session)
      : await provisionByClone(deps, config, session);

  if (!result.ok) return result.outcome;

  const credentialCheck = await verifyNoCredentialsWritten(
    deps.git,
    config.workspacePath,
    session,
  );
  if (credentialCheck !== null) {
    return {
      provisioned: false,
      failure: {
        reason: "mechanism_failed",
        message: credentialCheck,
        log: [...session.log],
      },
    };
  }

  const bytesOnDisk =
    deps.diskUsage === undefined
      ? null
      : await deps.diskUsage(config.workspacePath);

  const cost: ProvisionCost = {
    elapsedMillis: deps.clock() - started,
    bytesOnDisk,
    sharedCache: result.sharedCache,
    strategy,
  };

  return {
    provisioned: true,
    roots: [
      {
        key: "root",
        path: config.workspacePath,
        branch: result.branch,
        primaryCheckout: false,
      },
    ],
    cost,
    log: [...session.log],
    notes: [...session.notes],
  };
}

/**
 * What one provisioning mechanism produced: the branch it settled on and how it
 * reused shared storage, or the failure the caller reports verbatim.
 */
type MechanismResult =
  | {
      readonly ok: true;
      readonly branch: string;
      readonly sharedCache: ProvisionCost["sharedCache"];
    }
  | { readonly ok: false; readonly outcome: ProvisionOutcome };

async function provisionByWorktree(
  deps: GitProvisionDeps,
  config: GitWorkspaceConfig,
  session: Session,
): Promise<MechanismResult> {
  const source = config.repositoryPath;
  if (source === null) {
    return mechanismFailure(
      "invalid_config",
      "No repository path to branch from.",
      session,
    );
  }

  const named = resolveBranchName(
    config.branch,
    config.branchTemplate,
    config.branchInputs,
  );
  if (!named.named) {
    return mechanismFailure("invalid_config", named.refusal.message, session);
  }
  const branch = named.branch;
  if (!named.derived) {
    session.notes.push(
      `Branch ${branch} was already chosen for this workspace and was taken as it is.`,
    );
  }

  const localExists = await refExists(
    deps.git,
    source,
    `refs/heads/${branch}`,
    session,
  );

  if (localExists) {
    session.notes.push(
      `Branch ${branch} already exists locally; it was checked out, not recreated.`,
    );
    const added = await git(
      deps,
      source,
      ["worktree", "add", config.workspacePath, branch],
      session,
    );
    if (added.exitCode !== 0) return gitMechanismFailure(added, session);
    return { ok: true, branch, sharedCache: "hit" };
  }

  const remoteBranch = `${config.remoteName}/${branch}`;
  const hasRemote = await refExists(
    deps.git,
    source,
    `refs/remotes/${remoteBranch}`,
    session,
  );

  if (!hasRemote && (await remoteConfigured(deps, source, config, session))) {
    const fetched = await git(
      deps,
      source,
      [
        "fetch",
        config.remoteName,
        `refs/heads/${branch}:refs/remotes/${remoteBranch}`,
      ],
      session,
    );
    if (fetched.exitCode !== 0 && isHostAuthFailure(fetched)) {
      return gitMechanismFailure(fetched, session, "host_auth");
    }
  }

  const remoteExists = await refExists(
    deps.git,
    source,
    `refs/remotes/${remoteBranch}`,
    session,
  );

  if (remoteExists) {
    session.notes.push(
      `Branch ${branch} exists on ${config.remoteName}; the workspace has that branch's actual commits.`,
    );
    const added = await git(
      deps,
      source,
      [
        "worktree",
        "add",
        "--track",
        "-b",
        branch,
        config.workspacePath,
        remoteBranch,
      ],
      session,
    );
    if (added.exitCode !== 0) return gitMechanismFailure(added, session);
    return { ok: true, branch, sharedCache: "hit" };
  }

  const base = await resolveBaseRef(deps, source, config, session);
  const added = await git(
    deps,
    source,
    base === null
      ? ["worktree", "add", "-b", branch, config.workspacePath]
      : ["worktree", "add", "-b", branch, config.workspacePath, base],
    session,
  );
  if (added.exitCode !== 0) return gitMechanismFailure(added, session);
  session.notes.push(
    `Branch ${branch} is new, started from ${base ?? "the checkout's current HEAD"}.`,
  );
  return { ok: true, branch, sharedCache: "hit" };
}

async function provisionByClone(
  deps: GitProvisionDeps,
  config: GitWorkspaceConfig,
  session: Session,
): Promise<MechanismResult> {
  const remoteUrl = config.remoteUrl;
  if (remoteUrl === null) {
    return mechanismFailure(
      "invalid_config",
      "No remote URL to clone from.",
      session,
    );
  }

  let sharedCache: ProvisionCost["sharedCache"] = "unavailable";
  let mirrorPath: string | null = null;

  if (config.cacheDir !== null) {
    mirrorPath = `${config.cacheDir.replace(/\/+$/u, "")}/${mirrorCacheKey(remoteUrl)}`;
    const probe = await git(
      deps,
      deps.scratchDirectory,
      ["-C", mirrorPath, "rev-parse", "--is-bare-repository"],
      session,
    );
    if (probe.exitCode === 0 && probe.stdout.trim() === "true") {
      sharedCache = "hit";
      const updated = await git(
        deps,
        mirrorPath,
        ["remote", "update", "--prune"],
        session,
      );
      if (updated.exitCode !== 0 && isHostAuthFailure(updated)) {
        return gitMechanismFailure(updated, session, "host_auth");
      }
    } else {
      sharedCache = "miss";
      const mirrored = await git(
        deps,
        deps.scratchDirectory,
        ["clone", "--mirror", remoteUrl, mirrorPath],
        session,
      );
      if (mirrored.exitCode !== 0) {
        if (isHostAuthFailure(mirrored))
          return gitMechanismFailure(mirrored, session, "host_auth");
        mirrorPath = null;
        sharedCache = "unavailable";
        session.notes.push(
          "The shared mirror cache could not be populated; provisioning continued without it.",
        );
      }
    }
  }

  const cloneArgs =
    mirrorPath === null
      ? ["clone", remoteUrl, config.workspacePath]
      : [
          "clone",
          "--reference-if-able",
          mirrorPath,
          "--dissociate",
          remoteUrl,
          config.workspacePath,
        ];

  const cloned = await git(deps, deps.scratchDirectory, cloneArgs, session);
  if (cloned.exitCode !== 0) {
    return gitMechanismFailure(
      cloned,
      session,
      isHostAuthFailure(cloned) ? "host_auth" : "mechanism_failed",
    );
  }

  const named = resolveBranchName(
    config.branch,
    config.branchTemplate,
    config.branchInputs,
  );
  if (!named.named) {
    return mechanismFailure("invalid_config", named.refusal.message, session);
  }
  const branch = named.branch;

  const remoteBranch = `${config.remoteName}/${branch}`;
  const remoteExists = await refExists(
    deps.git,
    config.workspacePath,
    `refs/remotes/${remoteBranch}`,
    session,
  );

  if (remoteExists) {
    session.notes.push(
      `Branch ${branch} exists on ${config.remoteName}; the workspace has that branch's actual commits.`,
    );
    const checkedOut = await git(
      deps,
      config.workspacePath,
      ["checkout", "--track", remoteBranch],
      session,
    );
    if (checkedOut.exitCode !== 0)
      return gitMechanismFailure(checkedOut, session);
    return { ok: true, branch, sharedCache };
  }

  const base = config.baseRef;
  const created = await git(
    deps,
    config.workspacePath,
    base === null
      ? ["checkout", "-b", branch]
      : ["checkout", "-b", branch, base],
    session,
  );
  if (created.exitCode !== 0) return gitMechanismFailure(created, session);
  session.notes.push(
    `Branch ${branch} is new, started from ${base ?? "the clone's default branch"}.`,
  );
  return { ok: true, branch, sharedCache };
}

/**
 * After provisioning, the workspace's own git configuration is read back and
 * checked. Nothing in this package can write a credential into it — but a check
 * that runs is worth more than a rule that is only true by inspection, and this
 * is also what catches a *repository* that ships one in a committed config.
 */
export async function verifyNoCredentialsWritten(
  context: GitContext,
  workspacePath: string,
  session: Session,
): Promise<string | null> {
  const listed = await runGit(context, {
    cwd: workspacePath,
    args: ["config", "--local", "--list"],
  });
  session.log.push(describeInvocation(listed));
  if (listed.exitCode !== 0) return null;

  const findings = findCredentialMaterial(listed.stdout);
  if (findings.length === 0) return null;

  return `The provisioned workspace's git configuration contains ${findings
    .map((finding) => finding.detail)
    .join(
      ", ",
    )}; workspace git uses the host's own authentication (§3.4). Offending entries: ${findings
    .map((finding) => finding.line)
    .join("; ")}`;
}

async function git(
  deps: GitProvisionDeps,
  cwd: string,
  args: readonly string[],
  session: Session,
): Promise<GitOutcome> {
  const outcome = await runGit(deps.git, { cwd, args });
  session.log.push(describeInvocation(outcome));
  return outcome;
}

async function refExists(
  context: GitContext,
  cwd: string,
  ref: string,
  session: Session,
): Promise<boolean> {
  const outcome = await runGit(context, {
    cwd,
    args: ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
  });
  session.log.push(describeInvocation(outcome));
  return outcome.exitCode === 0;
}

async function remoteConfigured(
  deps: GitProvisionDeps,
  cwd: string,
  config: GitWorkspaceConfig,
  session: Session,
): Promise<boolean> {
  const outcome = await git(
    deps,
    cwd,
    ["config", "--get", `remote.${config.remoteName}.url`],
    session,
  );
  return outcome.exitCode === 0 && outcome.stdout.trim() !== "";
}

async function resolveBaseRef(
  deps: GitProvisionDeps,
  cwd: string,
  config: GitWorkspaceConfig,
  session: Session,
): Promise<string | null> {
  if (config.baseRef !== null) return config.baseRef;
  const head = await git(
    deps,
    cwd,
    ["symbolic-ref", "--short", `refs/remotes/${config.remoteName}/HEAD`],
    session,
  );
  if (head.exitCode === 0) {
    const value = head.stdout.trim();
    if (value !== "") return value;
  }
  return null;
}

function mechanismFailure(
  reason: "invalid_config" | "mechanism_failed" | "host_auth" | "occupied",
  message: string,
  session: Session,
): MechanismResult {
  return { ok: false, outcome: failure(reason, message, session) };
}

function gitMechanismFailure(
  outcome: GitOutcome,
  session: Session,
  reason: "mechanism_failed" | "host_auth" = "mechanism_failed",
): MechanismResult {
  return { ok: false, outcome: gitFailure(outcome, session, reason) };
}

function failure(
  reason: "invalid_config" | "mechanism_failed" | "host_auth" | "occupied",
  message: string,
  session: Session,
): ProvisionOutcome {
  return {
    provisioned: false,
    failure: { reason, message, log: [...session.log] },
  };
}

function gitFailure(
  outcome: GitOutcome,
  session: Session,
  reason: "mechanism_failed" | "host_auth" = "mechanism_failed",
): ProvisionOutcome {
  const resolved =
    reason === "host_auth" || isHostAuthFailure(outcome) ? "host_auth" : reason;
  const message =
    resolved === "host_auth"
      ? `The host's own git and SSH configuration could not authenticate this operation (§3.4). ${gitFailureMessage(outcome)}`
      : gitFailureMessage(outcome);
  return failure(resolved, message, session);
}
