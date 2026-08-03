/**
 * Live status and fingerprints, read from git (§3.4).
 *
 * "Current branch, uncommitted changes, ahead/behind — kept current so a change made
 * by any session *or by a terminal* is reflected everywhere it is shown." Nothing
 * here caches: every function asks git and reports what git said, and a read that
 * failed reports that it failed rather than falling back to a previous answer
 * (principle 7).
 *
 * `WorkspaceUnitStatus` and `UnitFingerprint` are the contract's, so this module is
 * the port's translation layer and nothing else. One field of core's own status has
 * no home in the contract — `detached` — so a detached checkout is reported the only
 * way the contract allows, as a null branch.
 */
import { createHash } from "node:crypto";

import type {
  UnitFingerprint,
  WorkspaceUnitStatus,
} from "@plotroom/plugin-sdk";

import {
  gitFailureMessage,
  runGit,
  type GitContext,
  type GitOutcome,
} from "./exec.js";

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
      if (key === "branch.oid") {
        head = value === "(initial)" ? null : value;
      }
      if (key === "branch.head") {
        detached = value === "(detached)";
        branch = detached ? null : value;
      }
      if (key === "branch.upstream") {
        upstream = value;
      }
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
  let outcome: GitOutcome;
  try {
    outcome = await runGit(context, {
      cwd,
      args: [
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=all",
        "-z",
      ],
    });
  } catch (error) {
    // A checkout that is not there at all is unreadable, not clean.
    return {
      read: false,
      message: `git could not be run in ${cwd}: ${describeError(error)}`,
    };
  }
  if (outcome.exitCode !== 0) {
    return { read: false, message: gitFailureMessage(outcome) };
  }
  return { read: true, value: parsePorcelainV2(outcome.stdout) };
}

/** Live status for one root, in the contract's vocabulary. */
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
 * The comparable snapshot divergence is derived from (§3.4, §4.3). The digest covers
 * the status code and both sides of a rename, so "moved files" — one of §3.4's named
 * divergences — changes it. The verdict is core's; a kind reports facts.
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
    unreadable: null,
  };
}

/** A root git could not be read: reported as unreadable, never as clean. */
export function unreadableFingerprint(
  rootKey: string,
  why: string,
): UnitFingerprint {
  return {
    rootKey,
    head: null,
    branch: null,
    upstream: null,
    upstreamHead: null,
    dirtyDigest: "",
    dirtyCount: 0,
    unreadable: why,
  };
}

/** Order-independent, so the same dirty set always digests the same way. */
export function digestPaths(lines: readonly string[]): string {
  const hash = createHash("sha256");
  for (const line of [...lines].sort()) {
    hash.update(line);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 32);
}

/** The upstream's own commit, so an upstream that moved is detectable (§3.4). */
export async function readUpstreamHead(
  context: GitContext,
  cwd: string,
  upstream: string | null,
): Promise<string | null> {
  if (upstream === null) {
    return null;
  }
  const outcome = await runGit(context, {
    cwd,
    args: ["rev-parse", "--verify", "--quiet", `${upstream}^{commit}`],
  });
  if (outcome.exitCode !== 0) {
    return null;
  }
  const head = outcome.stdout.trim();
  return head === "" ? null : head;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
