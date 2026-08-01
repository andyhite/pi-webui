import { resolve } from "node:path";
import type { RepositoryId, Workspace } from "@plotroom/core";

/**
 * Which repositories a workspace stands in (§6.5's `BroadcastMember`).
 *
 * `@plotroom/core` states the rule a broadcast scope is judged by and deliberately
 * does not own this join: "the graph and the workspace records know which
 * repository and workspace a session stands in". This is that join, and the plan
 * flags it as the one loose input — "a wrong `repositoryIds` join would widen what
 * a session may declare" — so it is worth being explicit about what a repository
 * *is* here.
 *
 * **A repository's identity is its configured source, not a generated id.** A
 * worktree and the checkout it was branched from are the same repository, which is
 * exactly the fact "everyone in this repository" (§6.5) is about: a session that
 * rebased in its own worktree is reporting on state every other worktree of that
 * repository shares. Deriving the id from the workspace's own configuration means
 * two workspaces agree on it without a registry table, and `senderSharesScope`
 * gets membership that is true rather than assigned.
 *
 * The local path is preferred over the remote when both are configured, because
 * the local checkout is what the worktrees actually share; the remote is the
 * fallback for a workspace cloned with no local source. A workspace with neither
 * stands in **no** repository — an empty list rather than a made-up id, so a
 * session in it can declare no repository scope at all (principle 7: absent
 * membership is not membership).
 */
export function repositoryIdsOf(workspace: Workspace): readonly RepositoryId[] {
  const ids = new Set<RepositoryId>();

  const local = workspace.config["repositoryPath"];
  if (typeof local === "string" && local.length > 0) {
    // Resolved, so `/repo` and `/repo/` and a relative spelling of the same
    // checkout are one repository rather than three.
    ids.add(`repo:${resolve(local)}` as RepositoryId);
  }

  const remote = workspace.config["remoteUrl"];
  if (ids.size === 0 && typeof remote === "string" && remote.length > 0) {
    ids.add(`repo:${remote}` as RepositoryId);
  }

  return [...ids];
}
