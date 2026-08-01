import type { WorkspaceFs } from "../fs.js";
import {
  GIT_WORKSPACE_KIND,
  type DiscoveredRepository,
  type DiscoveryRequest,
  type DiscoveryResult,
} from "../kind.js";
import { runGit, type GitContext } from "./exec.js";

/**
 * Repository discovery (§3.4, principle 6).
 *
 * "Configured search paths are scanned so repositories are found, not only
 * declared; a discovered repository is available but places nothing on the
 * canvas."
 *
 * Two properties make that enforced rather than promised:
 *
 * - This function returns `DiscoveredRepository` values and takes nothing that
 *   could place one — no workstream, no author, no store. It is physically
 *   unable to create a workspace. Placing goes through `attachRequest`, which
 *   requires both.
 * - Every git command it issues is checked against a read-only allowlist before
 *   it runs, so a scan cannot mutate a repository it merely looked at (and no
 *   network call is made, so scanning cannot spend or hang on auth).
 */

const READ_ONLY_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  "rev-parse": [],
  "symbolic-ref": [],
  config: ["--get", "--get-all", "--get-regexp", "--list"],
  remote: ["-v", "--verbose", "get-url"],
};

export type ReadOnlyCheck =
  | { readonly readOnly: true }
  | { readonly readOnly: false; readonly message: string };

/** The allowlist scanning is held to. Nothing else may be run by a scan. */
export function checkReadOnlyGit(args: readonly string[]): ReadOnlyCheck {
  const subcommand = args[0];
  if (subcommand === undefined || !(subcommand in READ_ONLY_SUBCOMMANDS)) {
    return {
      readOnly: false,
      message: `Discovery may only run read-only git commands; "${subcommand ?? ""}" is not one.`,
    };
  }
  const required = READ_ONLY_SUBCOMMANDS[subcommand] ?? [];
  if (required.length > 0 && !args.some((arg) => required.includes(arg))) {
    return {
      readOnly: false,
      message: `Discovery may only run "git ${subcommand}" with one of ${required.join(", ")}.`,
    };
  }
  return { readOnly: true };
}

async function readOnlyGit(
  context: GitContext,
  cwd: string,
  args: readonly string[],
): Promise<{ readonly exitCode: number; readonly stdout: string }> {
  const check = checkReadOnlyGit(args);
  if (!check.readOnly) {
    return { exitCode: 128, stdout: "" };
  }
  const outcome = await runGit(context, { cwd, args });
  return { exitCode: outcome.exitCode, stdout: outcome.stdout };
}

export interface GitDiscoveryDeps {
  readonly git: GitContext;
  readonly fs: WorkspaceFs;
}

export async function discoverGitRepositories(
  deps: GitDiscoveryDeps,
  request: DiscoveryRequest,
): Promise<DiscoveryResult> {
  const repositories: DiscoveredRepository[] = [];
  const unreadable: string[] = [];
  const seen = new Set<string>();

  for (const searchPath of request.searchPaths) {
    await scan(
      deps,
      searchPath,
      request.maxDepth,
      repositories,
      unreadable,
      seen,
    );
  }

  return { repositories, unreadable };
}

async function scan(
  deps: GitDiscoveryDeps,
  path: string,
  depthRemaining: number,
  repositories: DiscoveredRepository[],
  unreadable: string[],
  seen: Set<string>,
): Promise<void> {
  if (seen.has(path)) return;
  seen.add(path);

  let entries: readonly { name: string; directory: boolean }[];
  try {
    entries = await deps.fs.readDirectory(path);
  } catch (error) {
    unreadable.push(`${path}: ${describeError(error)}`);
    return;
  }

  if (entries.some((entry) => entry.name === ".git")) {
    repositories.push(await describeRepository(deps, path));
    return;
  }

  if (depthRemaining <= 0) return;

  for (const entry of entries) {
    if (!entry.directory) continue;
    if (entry.name.startsWith(".")) continue;
    await scan(
      deps,
      joinPath(path, entry.name),
      depthRemaining - 1,
      repositories,
      unreadable,
      seen,
    );
  }
}

async function describeRepository(
  deps: GitDiscoveryDeps,
  path: string,
): Promise<DiscoveredRepository> {
  const gitDir = await readOnlyGit(deps.git, path, ["rev-parse", "--git-dir"]);
  const commonDir = await readOnlyGit(deps.git, path, [
    "rev-parse",
    "--git-common-dir",
  ]);
  const head = await readOnlyGit(deps.git, path, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  const originHead = await readOnlyGit(deps.git, path, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  const configuredDefault = await readOnlyGit(deps.git, path, [
    "config",
    "--get",
    "init.defaultBranch",
  ]);
  const remotes = await readOnlyGit(deps.git, path, [
    "config",
    "--get-regexp",
    "^remote\\..*\\.url$",
  ]);

  const branch = head.exitCode === 0 ? head.stdout.trim() : "";

  return {
    kind: GIT_WORKSPACE_KIND,
    path,
    name: basename(path),
    defaultBranch: defaultBranchFrom(originHead, configuredDefault),
    currentBranch: branch === "" || branch === "HEAD" ? null : branch,
    remotes: parseRemotes(remotes.exitCode === 0 ? remotes.stdout : ""),
    /**
     * A linked worktree's git dir points inside the primary checkout's; equal
     * paths mean this *is* the primary checkout, which is protected (§3.4).
     */
    primaryCheckout:
      gitDir.exitCode === 0 &&
      commonDir.exitCode === 0 &&
      gitDir.stdout.trim() === commonDir.stdout.trim(),
  };
}

function defaultBranchFrom(
  originHead: { exitCode: number; stdout: string },
  configured: { exitCode: number; stdout: string },
): string | null {
  if (originHead.exitCode === 0) {
    const value = originHead.stdout.trim();
    const stripped = value.startsWith("origin/") ? value.slice(7) : value;
    if (stripped !== "") return stripped;
  }
  if (configured.exitCode === 0) {
    const value = configured.stdout.trim();
    if (value !== "") return value;
  }
  return null;
}

export function parseRemotes(
  configOutput: string,
): readonly { readonly name: string; readonly url: string }[] {
  const remotes: { name: string; url: string }[] = [];
  for (const line of configOutput.split(/\r?\n/u)) {
    const match = /^remote\.(.+)\.url\s+(.+)$/u.exec(line.trim());
    if (match === null) continue;
    remotes.push({ name: match[1] as string, url: match[2] as string });
  }
  return remotes;
}

function joinPath(parent: string, child: string): string {
  return `${parent.replace(/\/+$/u, "")}/${child}`;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
