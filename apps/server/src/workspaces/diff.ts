import {
  primaryRoot,
  runGit,
  type CommandExec,
  type GitContext,
  type Workspace,
} from "@plotroom/core";

/**
 * The workspace diff read (§11: "a workspace's changes — file tree and patches,
 * read-only").
 *
 * Read-only in the strong sense: every invocation below is a git *read*, and the
 * module has no verb that writes. It goes through `runGit`, which takes no
 * environment argument and builds the child's from the host allowlist — so a diff
 * read cannot become the one place an app credential reaches a workspace (§3.4's
 * host-auth invariant).
 *
 * **What "changes" means is stated, not assumed.** Diffing against `HEAD` shows
 * nothing once a session commits, which is the common case and the least useful
 * answer; diffing against the branch point shows the work. So the base is the
 * merge-base with the configured base ref where there is one, `HEAD` where there
 * is not, and the response says which — a diff whose base is a guess is a wrong
 * answer with no evidence (principle 7, principle 12).
 *
 * A workspace nothing has provisioned is reported as unprovisioned rather than as
 * an empty diff: "not ready" and "no changes" are different facts, and §3.4 says
 * the reason is visible.
 */
/**
 * The four statuses the panel renders, declared here rather than imported.
 *
 * `packages/ui` owns its own `DiffFileStatus` for the view; the wire shape is the
 * contract between them, and a server that imported the renderer's types would
 * have the dependency backwards. The two are kept the same by review and by the
 * panel consuming this endpoint — which is the same arrangement every other
 * response on this API has.
 */
export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffHunk {
  readonly header: string;
  readonly lines: readonly string[];
}

export interface DiffFile {
  readonly path: string;
  readonly status: DiffFileStatus;
  /** Set for a rename or copy: where this file's content came from. */
  readonly previousPath?: string;
  readonly hunks?: readonly DiffHunk[];
  readonly patchText?: string;
}

export type WorkspaceDiffState =
  | "ready"
  /** No workspace record at all: nothing has run in this workstream yet (§3.4). */
  | "no-workspace"
  /** A record with no checkout: provisioning happens at first run (§3.4, §3.5). */
  | "unprovisioned"
  /** The mechanism could not be read. Reported, never rendered as "no changes". */
  | "unreadable";

export interface WorkspaceDiff {
  readonly workspaceId: string | null;
  readonly state: WorkspaceDiffState;
  /** Why, when the state is not `ready`. Null when it is. */
  readonly reason: string | null;
  /** What the patches are relative to, and how that was decided. */
  readonly base: {
    readonly ref: string;
    readonly resolved: string | null;
    readonly description: string;
  } | null;
  readonly files: readonly DiffFile[];
}

export interface WorkspaceDiffDeps {
  readonly exec: CommandExec;
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
  readonly gitProgram?: string;
}

/** git's own status letters, mapped to the panel's four. */
function statusOf(letter: string): DiffFileStatus | null {
  if (letter.startsWith("R")) return "renamed";
  if (letter.startsWith("C")) return "renamed";
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
}

export async function readWorkspaceDiff(
  deps: WorkspaceDiffDeps,
  workspace: Workspace | null,
): Promise<WorkspaceDiff> {
  if (workspace === null) {
    return {
      workspaceId: null,
      state: "no-workspace",
      reason:
        "this workstream has no workspace yet; the first run provisions one (§3.4)",
      base: null,
      files: [],
    };
  }

  const root = primaryRoot(workspace);
  if (root === null || workspace.provisionedAt === null) {
    return {
      workspaceId: workspace.id,
      state: "unprovisioned",
      reason:
        "the workspace record exists but nothing is checked out; provisioning happens at first run (§3.4)",
      base: null,
      files: [],
    };
  }

  const context: GitContext = {
    exec: deps.exec,
    hostEnvironment: deps.hostEnvironment,
    ...(deps.gitProgram === undefined ? {} : { gitProgram: deps.gitProgram }),
  };
  const git = (...args: string[]) => runGit(context, { cwd: root.path, args });

  const base = await resolveBase(git, workspace);
  if (base === null) {
    return {
      workspaceId: workspace.id,
      state: "unreadable",
      reason: "git could not read this checkout, so no diff is reported for it",
      base: null,
      files: [],
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
    return {
      workspaceId: workspace.id,
      state: "unreadable",
      reason: `git diff failed in this checkout: ${names.stderr.trim()}`,
      base,
      files: [],
    };
  }

  const files: DiffFile[] = [];

  for (const entry of parseNameStatus(names.stdout)) {
    const patch = await git(
      "diff",
      "--find-renames",
      base.resolved ?? "HEAD",
      "--",
      entry.previousPath ?? entry.path,
      ...(entry.previousPath === undefined ? [] : [entry.path]),
    );

    files.push({
      path: entry.path,
      status: entry.status,
      ...(entry.previousPath === undefined
        ? {}
        : { previousPath: entry.previousPath }),
      // Both shapes: the panel renders pre-split hunks where they exist and the
      // whole patch where they do not, so a producer is never forced through one
      // parser (`packages/ui`'s own note on `DiffFile`).
      patchText: patch.stdout,
      hunks: splitHunks(patch.stdout),
    });
  }

  // Untracked files are changes too — a session that wrote a new file and has not
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
      patchText: patch.stdout,
      hunks: splitHunks(patch.stdout),
    });
  }

  return {
    workspaceId: workspace.id,
    state: "ready",
    reason: null,
    base,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/**
 * What the diff is against.
 *
 * The configured base ref's merge-base with HEAD, where the ref exists: that is
 * the branch point, so the diff is "everything this workspace's work changed",
 * committed or not. Where there is no base ref, or git cannot resolve it, `HEAD`
 * is used and said so — falling back silently would make a diff mean two
 * different things depending on configuration nobody can see from the answer.
 */
async function resolveBase(
  git: (...args: string[]) => ReturnType<typeof runGit>,
  workspace: Workspace,
): Promise<WorkspaceDiff["base"]> {
  const head = await git("rev-parse", "HEAD");
  if (head.exitCode !== 0) return null;

  const configured = workspace.config["baseRef"];
  if (typeof configured === "string" && configured.length > 0) {
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
      typeof configured === "string" && configured.length > 0
        ? `uncommitted changes only: git could not resolve ${configured} in this checkout`
        : "uncommitted changes only: this workspace declares no base ref to compare against",
  };
}

interface NameStatusEntry {
  readonly path: string;
  readonly status: DiffFileStatus;
  readonly previousPath?: string;
}

/**
 * `--name-status -z` output: NUL-separated, and a rename spends *three* fields
 * (letter, old path, new path) where everything else spends two. Parsed rather
 * than split on lines because a path may legitimately contain anything but NUL.
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
      // An unrecognized letter is skipped over rather than guessed at, and it
      // takes its operands with it so the rest of the list still parses.
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
    if (path !== undefined) entries.push({ path, status });
    index += 2;
  }

  return entries;
}

/** Split a unified patch into its hunks; the preamble is not one. */
export function splitHunks(patch: string): readonly DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: { header: string; lines: string[] } | null = null;

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      if (current !== null) hunks.push(current);
      current = { header: line, lines: [] };
      continue;
    }
    if (current !== null) current.lines.push(line);
  }

  if (current !== null) hunks.push(current);
  return hunks;
}
