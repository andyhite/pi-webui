/**
 * The git reads every contribution in this plugin shares: which checkout to look
 * at, what the diff is against, what the recent commits are, what branches exist.
 *
 * ## The scope carries the checkout, because nothing else can
 *
 * A `ConceptProducer` is handed a `ReadRequest` of `{ scope, externalId }` and
 * nothing else — no workspace, no root, no workstream. The contract has no field for
 * one, so the checkout a git producer reads is part of its **scope**, which §9.1
 * already says is "runtime-configurable, in the source's own query language". This
 * plugin's query language is therefore `path=<checkout> [base=<ref>] [limit=<n>]`,
 * and the scoping declaration says so verbatim so the settings surface can show it.
 *
 * ## What the diff is against is stated, never guessed
 *
 * Diffing against `HEAD` shows nothing once a session commits — the common case and
 * the least useful answer — so the base is the merge-base with the configured base
 * ref where there is one, `HEAD` where there is not, and the answer says which. A
 * diff whose base is a guess is a wrong answer with no evidence (principle 7,
 * principle 12).
 */
import {
  gitFailureMessage,
  runGit,
  type GitContext,
  type GitOutcome,
} from "./exec.js";
import { describeError, type GitReadOutcome } from "./status.js";

export interface GitScope {
  readonly path: string;
  readonly baseRef: string | null;
  readonly limit: number;
}

export const DEFAULT_COMMIT_LIMIT = 20;
export const MAX_COMMIT_LIMIT = 200;

export const GIT_SCOPE_LANGUAGE = "git-workspace";
export const GIT_SCOPE_EXAMPLE = "path=/repos/app base=main limit=20";

export type GitScopeParse =
  | { readonly ok: true; readonly scope: GitScope }
  | { readonly ok: false; readonly why: string };

/**
 * `path=… base=… limit=…`, in that spirit: keys in any order, a bare value read as
 * the path so `/repos/app` alone works. An unparseable scope is refused with what it
 * should have said, never defaulted to the current directory.
 */
export function parseGitScope(scope: string | null): GitScopeParse {
  if (scope === null || scope.trim() === "") {
    return {
      ok: false,
      why: `this producer needs a scope naming the checkout to read, e.g. "${GIT_SCOPE_EXAMPLE}"`,
    };
  }
  let path: string | null = null;
  let baseRef: string | null = null;
  let limit = DEFAULT_COMMIT_LIMIT;

  for (const token of scope.trim().split(/\s+/u)) {
    const separator = token.indexOf("=");
    if (separator === -1) {
      path = path ?? token;
      continue;
    }
    const key = token.slice(0, separator);
    const value = token.slice(separator + 1);
    if (key === "path") {
      path = value;
    } else if (key === "base") {
      baseRef = value === "" ? null : value;
    } else if (key === "limit") {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return {
          ok: false,
          why: `limit must be a positive integer, not "${value}"`,
        };
      }
      limit = Math.min(parsed, MAX_COMMIT_LIMIT);
    } else {
      return {
        ok: false,
        why: `unknown scope key "${key}"; this producer reads "${GIT_SCOPE_EXAMPLE}"`,
      };
    }
  }

  if (path === null || path === "") {
    return {
      ok: false,
      why: `this producer needs a path in its scope, e.g. "${GIT_SCOPE_EXAMPLE}"`,
    };
  }
  return { ok: true, scope: { path, baseRef, limit } };
}

export interface DiffBase {
  readonly ref: string;
  readonly resolved: string | null;
  readonly description: string;
}

export interface DiffFile {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "renamed";
  readonly previousPath: string | null;
  readonly patchText: string;
}

export interface WorkspaceDiffRead {
  readonly path: string;
  readonly base: DiffBase;
  readonly files: readonly DiffFile[];
}

const statusOf = (letter: string): DiffFile["status"] | null => {
  if (letter.startsWith("R") || letter.startsWith("C")) {
    return "renamed";
  }
  switch (letter[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "M":
    case "T":
      return "modified";
    default:
      return null;
  }
};

export async function readWorkspaceDiff(
  context: GitContext,
  scope: GitScope,
): Promise<GitReadOutcome<WorkspaceDiffRead>> {
  const git = (...args: string[]): Promise<GitOutcome> =>
    runGit(context, { cwd: scope.path, args });

  let base: DiffBase | null;
  try {
    base = await resolveDiffBase(git, scope.baseRef);
  } catch (error) {
    return {
      read: false,
      message: `git could not be run in ${scope.path}: ${describeError(error)}`,
    };
  }
  if (base === null) {
    return {
      read: false,
      message: `git could not read the checkout at ${scope.path}, so no diff is reported for it`,
    };
  }

  const names = await git(
    "diff",
    "--name-status",
    "--find-renames",
    "-z",
    base.resolved ?? "HEAD",
  );
  if (names.exitCode !== 0) {
    return { read: false, message: gitFailureMessage(names) };
  }

  const files: DiffFile[] = [];
  for (const entry of parseNameStatus(names.stdout)) {
    const patch = await git(
      "diff",
      "--find-renames",
      base.resolved ?? "HEAD",
      "--",
      entry.previousPath ?? entry.path,
      ...(entry.previousPath === null ? [] : [entry.path]),
    );
    files.push({ ...entry, patchText: patch.stdout });
  }

  // Untracked files are changes too: a session that wrote a new file and has not
  // committed it has changed the workspace, and a diff that omitted it would be
  // quietly incomplete (principle 12).
  const untracked = await git(
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  );
  for (const path of untracked.stdout.split("\0").filter((one) => one !== "")) {
    const patch = await git("diff", "--no-index", "--", "/dev/null", path);
    files.push({
      path,
      status: "added",
      previousPath: null,
      patchText: patch.stdout,
    });
  }

  return {
    read: true,
    value: {
      path: scope.path,
      base,
      files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
    },
  };
}

async function resolveDiffBase(
  git: (...args: string[]) => Promise<GitOutcome>,
  configured: string | null,
): Promise<DiffBase | null> {
  const head = await git("rev-parse", "HEAD");
  if (head.exitCode !== 0) {
    return null;
  }
  if (configured !== null) {
    const mergeBase = await git("merge-base", configured, "HEAD");
    if (mergeBase.exitCode === 0) {
      return {
        ref: configured,
        resolved: mergeBase.stdout.trim(),
        description: `everything this workspace changed since it branched from ${configured}`,
      };
    }
  }
  return {
    ref: "HEAD",
    resolved: head.stdout.trim(),
    description:
      configured === null
        ? "uncommitted changes only: no base ref was named to compare against"
        : `uncommitted changes only: git could not resolve ${configured} in this checkout`,
  };
}

interface NameStatusEntry {
  readonly path: string;
  readonly status: DiffFile["status"];
  readonly previousPath: string | null;
}

/**
 * `--name-status -z` output: NUL-separated, and a rename spends *three* fields
 * (letter, old path, new path) where everything else spends two. Parsed rather than
 * split on lines because a path may legitimately contain anything but NUL.
 */
export function parseNameStatus(output: string): readonly NameStatusEntry[] {
  const fields = output.split("\0").filter((field) => field !== "");
  const entries: NameStatusEntry[] = [];

  let index = 0;
  while (index < fields.length) {
    const letter = fields[index] as string;
    const status = statusOf(letter);
    const renamed = letter.startsWith("R") || letter.startsWith("C");

    if (status === null) {
      // An unrecognized letter is skipped over rather than guessed at, and it takes
      // its operands with it so the rest of the list still parses.
      index += renamed ? 3 : 2;
      continue;
    }
    if (renamed) {
      const previousPath = fields[index + 1];
      const path = fields[index + 2];
      if (path !== undefined && previousPath !== undefined) {
        entries.push({ path, status, previousPath });
      }
      index += 3;
      continue;
    }
    const path = fields[index + 1];
    if (path !== undefined) {
      entries.push({ path, status, previousPath: null });
    }
    index += 2;
  }
  return entries;
}

export interface CommitRead {
  readonly sha: string;
  readonly shortSha: string;
  readonly author: string;
  readonly authoredAt: string;
  readonly subject: string;
  readonly body: string;
  readonly files: readonly string[];
}

/**
 * The record separator **leads** each commit rather than trailing it. With `-z` and
 * `--name-only`, git emits `<header>\0\n<path>\0<path>\0` and then the next header
 * with nothing between them: a trailing separator would put one commit's paths in the
 * next commit's record.
 */
const COMMIT_FORMAT = "%x1e%H%x1f%h%x1f%an <%ae>%x1f%aI%x1f%s%x1f%b";

/**
 * Recent commits, newest first. `--name-only` gives the touched paths, whole: a
 * commit that changed forty files reports forty (principle 12).
 */
export async function readCommits(
  context: GitContext,
  scope: GitScope,
  revision: string | null = null,
): Promise<GitReadOutcome<readonly CommitRead[]>> {
  const range =
    revision !== null
      ? [`${revision}^!`]
      : scope.baseRef !== null
        ? [`${scope.baseRef}..HEAD`]
        : [];
  let outcome: GitOutcome;
  try {
    outcome = await runGit(context, {
      cwd: scope.path,
      args: [
        "log",
        `--max-count=${scope.limit}`,
        `--format=${COMMIT_FORMAT}`,
        "--name-only",
        "-z",
        ...range,
      ],
    });
  } catch (error) {
    return {
      read: false,
      message: `git could not be run in ${scope.path}: ${describeError(error)}`,
    };
  }
  if (outcome.exitCode !== 0) {
    return { read: false, message: gitFailureMessage(outcome) };
  }
  return { read: true, value: parseCommitLog(outcome.stdout) };
}

/** `git log --format=%x1e… --name-only -z`, parsed. */
export function parseCommitLog(output: string): readonly CommitRead[] {
  const commits: CommitRead[] = [];
  for (const record of output.split("\x1e")) {
    if (record.trim() === "") {
      continue;
    }
    const [header, ...rest] = record.split("\0");
    const parts = (header ?? "").split("\x1f");
    const sha = parts[0] ?? "";
    if (sha === "") {
      continue;
    }
    commits.push({
      sha,
      shortSha: parts[1] ?? sha.slice(0, 8),
      author: parts[2] ?? "",
      authoredAt: parts[3] ?? "",
      subject: parts[4] ?? "",
      body: (parts[5] ?? "").trim(),
      // The first path arrives behind the newline git puts after the header.
      files: rest
        .map((path) => path.replace(/^\n/u, "").trim())
        .filter((path) => path !== ""),
    });
  }
  return commits;
}

export interface BranchRead {
  readonly name: string;
  readonly head: string;
  readonly upstream: string | null;
  readonly current: boolean;
}

/**
 * Every local branch. There is no `branch` concept kind — `CONCEPT_KINDS` is closed
 * (§3.1) — so branches reach the product as a tool answer and as a workspace unit's
 * `branch` field, never as objects on the graph.
 */
export async function readBranches(
  context: GitContext,
  path: string,
): Promise<GitReadOutcome<readonly BranchRead[]>> {
  let outcome: GitOutcome;
  try {
    outcome = await runGit(context, {
      cwd: path,
      args: [
        "for-each-ref",
        "--format=%(refname:short)%1f%(objectname)%1f%(upstream:short)%1f%(HEAD)",
        "refs/heads",
      ],
    });
  } catch (error) {
    return {
      read: false,
      message: `git could not be run in ${path}: ${describeError(error)}`,
    };
  }
  if (outcome.exitCode !== 0) {
    return { read: false, message: gitFailureMessage(outcome) };
  }
  const branches: BranchRead[] = [];
  for (const line of outcome.stdout.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const [name, head, upstream, marker] = line.split("\x1f");
    if (name === undefined || name === "") {
      continue;
    }
    branches.push({
      name,
      head: head ?? "",
      upstream: upstream === undefined || upstream === "" ? null : upstream,
      current: (marker ?? "").trim() === "*",
    });
  }
  return { read: true, value: branches };
}

/** The default branch, for removal protection (§3.4). Null when git cannot say. */
export async function readDefaultBranch(
  context: GitContext,
  path: string,
  remoteName: string,
): Promise<string | null> {
  const originHead = await runGit(context, {
    cwd: path,
    args: ["symbolic-ref", "--short", `refs/remotes/${remoteName}/HEAD`],
  });
  if (originHead.exitCode === 0) {
    const value = originHead.stdout.trim();
    const prefix = `${remoteName}/`;
    const stripped = value.startsWith(prefix)
      ? value.slice(prefix.length)
      : value;
    if (stripped !== "") {
      return stripped;
    }
  }
  const configured = await runGit(context, {
    cwd: path,
    args: ["config", "--get", "init.defaultBranch"],
  });
  if (configured.exitCode === 0 && configured.stdout.trim() !== "") {
    return configured.stdout.trim();
  }
  return null;
}
