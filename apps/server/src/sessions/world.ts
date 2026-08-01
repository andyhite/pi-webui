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
 *
 * ## What this deliberately under-includes, and why that is the safe direction
 *
 * Identity is the *configured source string*, resolved. So two things that are one
 * repository to a human are two here:
 *
 * - **two clones of one remote at different local paths**, because each worktree set
 *   shares only its own clone — a rebase in one is not material state the other's
 *   sessions are standing in, which is what the scope is about;
 * - **the same checkout reached by different spellings** a `resolve` cannot
 *   reconcile: a symlinked path, a bind mount, a case-differing path on a
 *   case-insensitive filesystem;
 * - **a local path and a remote URL for the same repository**, when one workspace
 *   was branched locally and another cloned.
 *
 * Every one of those under-includes: a broadcast reaches fewer sessions than a human
 * might expect, and a session may find it cannot declare a scope it feels part of.
 * That is the direction to be wrong in. Over-including would let a session declare a
 * scope covering sessions it shares nothing with — "a foreign workspace with one
 * session in it is a recipient list of exactly one", which is precisely the recipient
 * list §6.5 refuses to let a session write. `GET /api/broadcast-world` exposes what
 * this resolved to, so an under-inclusion is visible rather than mysterious.
 *
 * Narrowing it needs a repository identity the mechanism itself can answer for —
 * git's own `rev-parse --git-common-dir`, say, or the first commit's sha — which is a
 * kind-level question (§10.1) and not something this join may decide alone.
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
