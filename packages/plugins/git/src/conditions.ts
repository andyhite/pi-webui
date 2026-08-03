/**
 * Condition checks: predicates for **proving** completion (§10.1, principle 3).
 *
 * "Completion is proof, not a claim." Two properties the contract insists on and
 * this file keeps:
 *
 * - A check **reads**, and the host calls it. Nothing here starts work (principle 2).
 * - **`unknown` is not `unmet`.** A checkout git could not read has not disproved
 *   anything, and reporting it as unmet would make a broken path read as failed work.
 *
 * Every check takes the checkout in its input, because a `ConditionCheck` is handed
 * an input and a call context and nothing else — the contract has no workspace on
 * that call. Whoever declares the condition supplies `path`; the server's condition
 * registry knows the workspace and is the one that can fill it in.
 */
import type {
  ConditionCheck,
  ConditionResult,
  ToolInputSchema,
} from "@plotroom/plugin-sdk";

import type { GitContext } from "./exec.js";
import { readBranches, readCommits, type GitScope } from "./reads.js";
import { readGitStatus } from "./status.js";

export const CLEAN_CHECK_ID = "git_workspace_clean";
export const COMMITS_CHECK_ID = "git_commits_since_base";
export const BRANCH_CHECK_ID = "git_branch_is";

const pathField = {
  type: "string" as const,
  required: true,
  description: "the checkout to read, absolute",
};

const readString = (input: unknown, name: string): string | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const value = (input as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

const readBoolean = (input: unknown, name: string): boolean => {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  return (input as Record<string, unknown>)[name] === true;
};

const missing = (name: string): ConditionResult => ({
  state: "unknown",
  evidence: `this condition declares no ${name}, so nothing was checked — which is not proof`,
});

const scopeOf = (path: string, baseRef: string | null): GitScope => ({
  path,
  baseRef,
  limit: 50,
});

/** Nothing uncommitted is left in the checkout. */
export function workspaceCleanCheck(
  context: GitContext,
  permissions: readonly string[],
): ConditionCheck {
  const input: ToolInputSchema = {
    path: pathField,
    includeUntracked: {
      type: "boolean",
      required: false,
      description:
        "count untracked files as uncommitted work; false counts only tracked changes",
    },
  };
  return {
    id: CLEAN_CHECK_ID,
    summary: "the workspace has no uncommitted changes",
    input,
    permissions,
    async check(raw: unknown): Promise<ConditionResult> {
      const path = readString(raw, "path");
      if (path === null) {
        return missing("path");
      }
      const read = await readGitStatus(context, path);
      if (!read.read) {
        return { state: "unknown", evidence: read.message };
      }
      const tracked = read.value.entries.filter(
        (entry) => entry.kind === "tracked" || entry.kind === "unmerged",
      );
      const untracked = readBoolean(raw, "includeUntracked")
        ? read.value.entries.filter((entry) => entry.kind === "untracked")
        : [];
      const dirty = [...tracked, ...untracked];
      if (dirty.length === 0) {
        return {
          state: "met",
          evidence: `git reports nothing uncommitted in ${path}${
            read.value.head === null ? "" : ` at ${read.value.head}`
          }`,
        };
      }
      return {
        state: "unmet",
        // Every path, complete: the evidence is what was seen (principle 12).
        evidence: `git reports ${dirty.length} uncommitted path${dirty.length === 1 ? "" : "s"} in ${path}: ${dirty
          .map((entry) => entry.path)
          .join(", ")}`,
      };
    },
  };
}

/** At least one commit exists on top of the base ref — work was recorded. */
export function commitsSinceBaseCheck(
  context: GitContext,
  permissions: readonly string[],
): ConditionCheck {
  const input: ToolInputSchema = {
    path: pathField,
    base: {
      type: "string",
      required: true,
      description: "the ref the work branched from, e.g. main",
    },
  };
  return {
    id: COMMITS_CHECK_ID,
    summary: "the workspace has at least one commit since its base ref",
    input,
    permissions,
    async check(raw: unknown): Promise<ConditionResult> {
      const path = readString(raw, "path");
      if (path === null) {
        return missing("path");
      }
      const base = readString(raw, "base");
      if (base === null) {
        return missing("base");
      }
      const read = await readCommits(context, scopeOf(path, base));
      if (!read.read) {
        return { state: "unknown", evidence: read.message };
      }
      if (read.value.length === 0) {
        return {
          state: "unmet",
          evidence: `git reports no commits in ${base}..HEAD in ${path}`,
        };
      }
      return {
        state: "met",
        evidence: `git reports ${read.value.length} commit${read.value.length === 1 ? "" : "s"} in ${base}..HEAD: ${read.value
          .map((commit) => `${commit.shortSha} ${commit.subject}`)
          .join("; ")}`,
      };
    },
  };
}

/** The checkout is on the branch the condition names. */
export function branchIsCheck(
  context: GitContext,
  permissions: readonly string[],
): ConditionCheck {
  const input: ToolInputSchema = {
    path: pathField,
    branch: {
      type: "string",
      required: true,
      description: "the branch the workspace is expected to be on",
    },
  };
  return {
    id: BRANCH_CHECK_ID,
    summary: "the workspace is on a named branch",
    input,
    permissions,
    async check(raw: unknown): Promise<ConditionResult> {
      const path = readString(raw, "path");
      if (path === null) {
        return missing("path");
      }
      const branch = readString(raw, "branch");
      if (branch === null) {
        return missing("branch");
      }
      const read = await readBranches(context, path);
      if (!read.read) {
        return { state: "unknown", evidence: read.message };
      }
      const current = read.value.find((one) => one.current);
      if (current === undefined) {
        return {
          state: "unmet",
          evidence: `${path} is on no branch (a detached checkout), not ${branch}`,
        };
      }
      return current.name === branch
        ? {
            state: "met",
            evidence: `${path} is on ${branch} at ${current.head}`,
          }
        : {
            state: "unmet",
            evidence: `${path} is on ${current.name}, not ${branch}`,
          };
    },
  };
}
