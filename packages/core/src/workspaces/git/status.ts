import { digestPaths, type UnitFingerprint } from "../divergence.js";
import type { WorkspaceUnitStatus } from "../kind.js";
import { gitFailureMessage, runGit, type GitContext } from "./exec.js";

/**
 * Live status and fingerprints, read from git (§3.4).
 *
 * "Current branch, uncommitted changes, ahead/behind — kept current so a change
 * made by any session *or by a terminal* is reflected everywhere it is shown."
 *
 * Nothing here caches. Every function asks git and reports what git said,
 * because the whole point is that a change the product did not make is still
 * visible. A read that fails reports that it failed; it never falls back to a
 * previous answer (principle 7).
 */

export interface GitStatusEntry {
  /** The two-letter XY code from porcelain v2, or `?` / `!` for the rest. */
  readonly code: string;
  readonly path: string;
  /** Where a renamed or copied path came from, so moved files are visible. */
  readonly origPath: string | null;
  readonly kind: "tracked" | "unmerged" | "untracked" | "ignored";
}

export interface GitStatusRead {
  readonly branch: string | null;
  readonly detached: boolean;
  readonly head: string | null;
  readonly upstream: string | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly entries: readonly GitStatusEntry[];
}

/** `git status --porcelain=v2 --branch --untracked-files=all -z`, parsed. */
export function parsePorcelainV2(output: string): GitStatusRead {
  const fields = output.split("\0").filter((field) => field !== "");
  const entries: GitStatusEntry[] = [];
  let branch: string | null = null;
  let detached = false;
  let head: string | null = null;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] as string;

    if (field.startsWith("# ")) {
      const [key, ...rest] = field.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") head = value === "(initial)" ? null : value;
      if (key === "branch.head") {
        detached = value === "(detached)";
        branch = detached ? null : value;
      }
      if (key === "branch.upstream") upstream = value;
      if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/u.exec(value);
        if (match !== null) {
          ahead = Number(match[1]);
          behind = Number(match[2]);
        }
      }
      continue;
    }

    if (field.startsWith("1 ")) {
      const parts = field.split(" ");
      entries.push({
        code: parts[1] ?? "??",
        path: parts.slice(8).join(" "),
        origPath: null,
        kind: "tracked",
      });
      continue;
    }

    if (field.startsWith("2 ")) {
      const parts = field.split(" ");
      const origPath = fields[index + 1] ?? null;
      index += 1;
      entries.push({
        code: parts[1] ?? "??",
        path: parts.slice(9).join(" "),
        origPath,
        kind: "tracked",
      });
      continue;
    }

    if (field.startsWith("u ")) {
      const parts = field.split(" ");
      entries.push({
        code: parts[1] ?? "UU",
        path: parts.slice(10).join(" "),
        origPath: null,
        kind: "unmerged",
      });
      continue;
    }

    if (field.startsWith("? ")) {
      entries.push({
        code: "?",
        path: field.slice(2),
        origPath: null,
        kind: "untracked",
      });
      continue;
    }

    if (field.startsWith("! ")) {
      entries.push({
        code: "!",
        path: field.slice(2),
        origPath: null,
        kind: "ignored",
      });
    }
  }

  return { branch, detached, head, upstream, ahead, behind, entries };
}

export type GitReadOutcome<T> =
  | { readonly read: true; readonly value: T }
  | { readonly read: false; readonly message: string };

export async function readGitStatus(
  context: GitContext,
  cwd: string,
): Promise<GitReadOutcome<GitStatusRead>> {
  const outcome = await runGit(context, {
    cwd,
    args: [
      "status",
      "--porcelain=v2",
      "--branch",
      "--untracked-files=all",
      "-z",
    ],
  });
  if (outcome.exitCode !== 0) {
    return { read: false, message: gitFailureMessage(outcome) };
  }
  return { read: true, value: parsePorcelainV2(outcome.stdout) };
}

/** Live status for one root, in the product's vocabulary (§3.4). */
export function unitStatusFrom(
  rootKey: string,
  path: string,
  read: GitStatusRead,
): WorkspaceUnitStatus {
  return {
    rootKey,
    path,
    branch: read.branch,
    head: read.head,
    detached: read.detached,
    upstream: read.upstream,
    ahead: read.ahead,
    behind: read.behind,
    uncommitted: read.entries
      .filter((entry) => entry.kind === "tracked" || entry.kind === "unmerged")
      .map((entry) => entry.path),
    untracked: read.entries
      .filter((entry) => entry.kind === "untracked")
      .map((entry) => entry.path),
  };
}

/**
 * The comparable snapshot. The digest covers the status code and both sides of
 * a rename, so "moved files" — one of §3.4's named divergences — changes it.
 */
export function unitFingerprintFrom(
  rootKey: string,
  read: GitStatusRead,
  upstreamHead: string | null,
): UnitFingerprint {
  const dirty = read.entries
    .filter((entry) => entry.kind !== "ignored")
    .map((entry) =>
      entry.origPath === null
        ? `${entry.code}:${entry.path}`
        : `${entry.code}:${entry.origPath}->${entry.path}`,
    );
  return {
    rootKey,
    head: read.head,
    branch: read.branch,
    upstream: read.upstream,
    upstreamHead,
    dirtyDigest: digestPaths(dirty),
    dirtyCount: dirty.length,
  };
}

/** The upstream's own commit, so an upstream that moved is detectable (§3.4). */
export async function readUpstreamHead(
  context: GitContext,
  cwd: string,
  upstream: string | null,
): Promise<string | null> {
  if (upstream === null) return null;
  const outcome = await runGit(context, {
    cwd,
    args: ["rev-parse", "--verify", "--quiet", `${upstream}^{commit}`],
  });
  if (outcome.exitCode !== 0) return null;
  const head = outcome.stdout.trim();
  return head === "" ? null : head;
}

/**
 * Is the commit a session worked from still in this history? False is a rewrite
 * — a rebase or an amend; unknown (absent from the map) is reported as unknown,
 * never as "fine".
 */
export async function probeHeadReachable(
  context: GitContext,
  cwd: string,
  priorHead: string,
): Promise<boolean | null> {
  const outcome = await runGit(context, {
    cwd,
    args: ["merge-base", "--is-ancestor", priorHead, "HEAD"],
  });
  if (outcome.exitCode === 0) return true;
  if (outcome.exitCode === 1) return false;
  return null;
}
