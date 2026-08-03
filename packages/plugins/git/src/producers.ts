/**
 * Concept producers for the two git concepts §3.1 already has: **diff** ("the
 * current uncommitted state of a workspace") and **commit** ("a recorded change").
 *
 * Three rules of §3.1 and §9.1 are the shape of this file:
 *
 * - **Concepts are present or absent, never degraded.** A read that could not run
 *   returns no object and names itself in `unavailable`; it never returns a
 *   half-filled diff.
 * - **Identity survives.** A commit's external id is its sha, so a re-read
 *   reconciles rather than duplicating; a workspace's diff is identified by the
 *   checkout it is the diff of.
 * - **Scheduled reads are fine; scheduled runs are not** (principle 2). Both
 *   producers refresh `on-demand`: git tells nobody when a file changes, and a
 *   producer that polled a checkout every minute would spend the operator's disk
 *   bandwidth to discover a fact the panel could ask for.
 *
 * There is deliberately **no branch producer**: `CONCEPT_KINDS` is closed (§3.1) and
 * has no branch member, so branches reach the product through the workspace kind's
 * status and through `git_branches`, never as objects on the graph.
 */
import type {
  ConceptProducer,
  PluginCallContext,
  ProducedObject,
  ReadRequest,
  ReadResult,
} from "@plotroom/plugin-sdk";

import type { GitContext } from "./exec.js";
import {
  GIT_SCOPE_EXAMPLE,
  GIT_SCOPE_LANGUAGE,
  parseGitScope,
  readCommits,
  readWorkspaceDiff,
  type CommitRead,
  type WorkspaceDiffRead,
} from "./reads.js";

export const DIFF_PRODUCER_ID = "workspace-diff";
export const COMMIT_PRODUCER_ID = "workspace-commits";

const DIFF_ID_PREFIX = "git:diff:";
const COMMIT_ID_PREFIX = "git:commit:";

export const diffExternalId = (path: string): string =>
  `${DIFF_ID_PREFIX}${path}`;
export const commitExternalId = (sha: string): string =>
  `${COMMIT_ID_PREFIX}${sha}`;

/** The workspace's uncommitted state, as one `diff` object per checkout (§3.1). */
export function createDiffProducer(
  context: GitContext,
  permissions: readonly string[],
): ConceptProducer {
  return {
    id: DIFF_PRODUCER_ID,
    kinds: ["diff"],
    refresh: { kind: "on-demand" },
    scoping: { language: GIT_SCOPE_LANGUAGE, example: GIT_SCOPE_EXAMPLE },
    permissions,
    async read(
      request: ReadRequest,
      call: PluginCallContext,
    ): Promise<ReadResult> {
      const scope = parseGitScope(request.scope);
      if (!scope.ok) {
        return {
          objects: [],
          unavailable: [
            { externalId: request.externalId ?? "(no scope)", why: scope.why },
          ],
        };
      }
      call.log(`reading the diff in ${scope.scope.path}`);
      const read = await readWorkspaceDiff(context, scope.scope);
      if (!read.read) {
        return {
          objects: [],
          unavailable: [
            {
              externalId: diffExternalId(scope.scope.path),
              why: read.message,
            },
          ],
        };
      }
      return { objects: [diffObject(read.value)], unavailable: [] };
    },
  };
}

export function diffObject(read: WorkspaceDiffRead): ProducedObject {
  const changed = read.files.length;
  const summary =
    changed === 0
      ? `no changes in ${read.path}`
      : `${changed} file${changed === 1 ? "" : "s"} changed in ${read.path}`;
  const body = [
    `# Workspace changes (${read.path})`,
    "",
    `Base: ${read.base.ref}${read.base.resolved === null ? "" : ` (${read.base.resolved})`}`,
    read.base.description,
    "",
    ...read.files.map((file) =>
      file.previousPath === null
        ? `- ${file.status}: ${file.path}`
        : `- ${file.status}: ${file.previousPath} → ${file.path}`,
    ),
    "",
    ...read.files.map((file) => file.patchText),
  ].join("\n");

  return {
    kind: "diff",
    externalId: diffExternalId(read.path),
    title: summary,
    renderings: {
      card: summary,
      // The base is part of the summary, because a diff whose base is invisible
      // means two different things depending on configuration nobody can see.
      summary: `${summary} — ${read.base.description}`,
      agentContent: body,
    },
  };
}

/** Recorded changes, newest first, identified by sha (§3.1). */
export function createCommitProducer(
  context: GitContext,
  permissions: readonly string[],
): ConceptProducer {
  return {
    id: COMMIT_PRODUCER_ID,
    kinds: ["commit"],
    refresh: { kind: "on-demand" },
    scoping: { language: GIT_SCOPE_LANGUAGE, example: GIT_SCOPE_EXAMPLE },
    permissions,
    async read(
      request: ReadRequest,
      call: PluginCallContext,
    ): Promise<ReadResult> {
      const scope = parseGitScope(request.scope);
      if (!scope.ok) {
        return {
          objects: [],
          unavailable: [
            { externalId: request.externalId ?? "(no scope)", why: scope.why },
          ],
        };
      }
      // A per-object refresh names one commit; the scope still names the checkout,
      // because a `ReadRequest` carries no workspace for it to come from.
      const revision =
        request.externalId === null
          ? null
          : request.externalId.startsWith(COMMIT_ID_PREFIX)
            ? request.externalId.slice(COMMIT_ID_PREFIX.length)
            : request.externalId;
      call.log(
        `reading ${revision ?? `up to ${scope.scope.limit} commits`} in ${scope.scope.path}`,
      );
      const read = await readCommits(context, scope.scope, revision);
      if (!read.read) {
        return {
          objects: [],
          unavailable: [
            {
              externalId:
                revision === null
                  ? diffExternalId(scope.scope.path)
                  : commitExternalId(revision),
              why: read.message,
            },
          ],
        };
      }
      return {
        objects: read.value.map(commitObject),
        unavailable: [],
      };
    },
  };
}

export function commitObject(commit: CommitRead): ProducedObject {
  const title = `${commit.shortSha} ${commit.subject}`;
  const body = [
    `# ${commit.subject}`,
    "",
    `Commit: ${commit.sha}`,
    `Author: ${commit.author}`,
    `Authored: ${commit.authoredAt}`,
    "",
    commit.body,
    "",
    "## Files",
    ...commit.files.map((path) => `- ${path}`),
  ].join("\n");

  return {
    kind: "commit",
    externalId: commitExternalId(commit.sha),
    title,
    renderings: {
      card: title,
      summary: `${commit.subject} — ${commit.author} touched ${commit.files.length} file${commit.files.length === 1 ? "" : "s"}`,
      agentContent: body,
    },
  };
}
