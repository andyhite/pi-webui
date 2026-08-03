/**
 * Agent tools: what a session can ask this plugin about a checkout (§10.1, §9.4).
 *
 * Every tool here **reads**. That is a decision, not an omission: a tool that wrote
 * files or made commits would be a write into a workspace, and §3.4 grants write
 * access **per path** through the claim ledger. A `WriteAction` in contract v1
 * declares no paths, so nothing the server can see would let it gate a plugin's
 * write by the claim its calling session holds — and a write PlotRoom cannot gate is
 * one it must not offer. Committing stays a native, claim-gated capability; this
 * plugin's contribution is that a session can *see* the workspace precisely.
 *
 * `mutates: false` on every tool is therefore honest rather than convenient, and
 * `context.actor` is the host's statement about the calling session (principle 1) —
 * a plugin cannot set one, and these tools do not read it to decide anything.
 */
import type {
  AgentTool,
  PluginCallContext,
  ToolResult,
} from "@plotroom/plugin-sdk";

import type { GitContext } from "./exec.js";
import {
  DEFAULT_COMMIT_LIMIT,
  MAX_COMMIT_LIMIT,
  readBranches,
  readCommits,
  readWorkspaceDiff,
  type GitScope,
} from "./reads.js";
import { readGitStatus, unitStatusFrom } from "./status.js";

export const STATUS_TOOL = "git_status";
export const DIFF_TOOL = "git_diff";
export const LOG_TOOL = "git_log";
export const BRANCHES_TOOL = "git_branches";

const pathField = {
  type: "string" as const,
  required: true,
  description: "the checkout to read, absolute",
};

const baseField = {
  type: "string" as const,
  required: false,
  description: "the ref the work branched from; the answer says what it used",
};

const stringOf = (input: unknown, name: string): string | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const value = (input as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

const numberOf = (input: unknown, name: string): number | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const value = (input as Record<string, unknown>)[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const needPath = (): ToolResult => ({
  ok: false,
  content: "this tool needs an absolute path to a checkout",
});

const scopeOf = (
  input: unknown,
  path: string,
  fallbackLimit = DEFAULT_COMMIT_LIMIT,
): GitScope => {
  const limit = numberOf(input, "limit");
  return {
    path,
    baseRef: stringOf(input, "base"),
    limit:
      limit === null
        ? fallbackLimit
        : Math.min(Math.max(Math.trunc(limit), 1), MAX_COMMIT_LIMIT),
  };
};

export function createGitTools(
  context: GitContext,
  permissions: readonly string[],
): readonly AgentTool[] {
  const requires = {
    mutates: false,
    writeActionId: null,
    permissions,
  };

  return [
    {
      name: STATUS_TOOL,
      summary:
        "read a checkout's live git status: branch, head, upstream, ahead/behind, and every uncommitted or untracked path",
      input: { path: pathField },
      output: {
        description:
          "one JSON object with branch, head, upstream, ahead, behind, uncommitted and untracked",
      },
      requires,
      async call(input: unknown, call: PluginCallContext): Promise<ToolResult> {
        const path = stringOf(input, "path");
        if (path === null) {
          return needPath();
        }
        call.log(`git status in ${path}`);
        const read = await readGitStatus(context, path);
        if (!read.read) {
          return { ok: false, content: read.message };
        }
        return {
          ok: true,
          content: JSON.stringify(
            unitStatusFrom("root", path, read.value),
            null,
            2,
          ),
        };
      },
    },
    {
      name: DIFF_TOOL,
      summary:
        "read a checkout's changes as patches, against its base ref where one is given",
      input: { path: pathField, base: baseField },
      output: {
        description:
          "the base it measured against, its own description of that choice, and one patch per changed file",
      },
      requires,
      async call(input: unknown, call: PluginCallContext): Promise<ToolResult> {
        const path = stringOf(input, "path");
        if (path === null) {
          return needPath();
        }
        call.log(`git diff in ${path}`);
        const read = await readWorkspaceDiff(context, scopeOf(input, path));
        if (!read.read) {
          return { ok: false, content: read.message };
        }
        const diff = read.value;
        return {
          ok: true,
          content: [
            `Base: ${diff.base.ref}${diff.base.resolved === null ? "" : ` (${diff.base.resolved})`}`,
            diff.base.description,
            "",
            ...diff.files.map(
              (file) =>
                `--- ${file.status}: ${file.previousPath === null ? file.path : `${file.previousPath} → ${file.path}`}\n${file.patchText}`,
            ),
          ].join("\n"),
        };
      },
    },
    {
      name: LOG_TOOL,
      summary: "read a checkout's recent commits, newest first",
      input: {
        path: pathField,
        base: baseField,
        limit: {
          type: "number",
          required: false,
          description: `how many commits at most (default ${DEFAULT_COMMIT_LIMIT}, capped at ${MAX_COMMIT_LIMIT})`,
        },
      },
      output: {
        description: "one line per commit: sha, author, date and subject",
      },
      requires,
      async call(input: unknown, call: PluginCallContext): Promise<ToolResult> {
        const path = stringOf(input, "path");
        if (path === null) {
          return needPath();
        }
        call.log(`git log in ${path}`);
        const read = await readCommits(context, scopeOf(input, path));
        if (!read.read) {
          return { ok: false, content: read.message };
        }
        return {
          ok: true,
          content:
            read.value.length === 0
              ? "no commits in that range"
              : read.value
                  .map(
                    (commit) =>
                      `${commit.sha} ${commit.authoredAt} ${commit.author} ${commit.subject}`,
                  )
                  .join("\n"),
        };
      },
    },
    {
      name: BRANCHES_TOOL,
      summary:
        "list a checkout's local branches, with their heads, upstreams, and which one is checked out",
      input: { path: pathField },
      output: {
        description:
          "one line per branch; the checked-out branch is marked with *",
      },
      requires,
      async call(input: unknown, call: PluginCallContext): Promise<ToolResult> {
        const path = stringOf(input, "path");
        if (path === null) {
          return needPath();
        }
        call.log(`git branches in ${path}`);
        const read = await readBranches(context, path);
        if (!read.read) {
          return { ok: false, content: read.message };
        }
        return {
          ok: true,
          content:
            read.value.length === 0
              ? "this checkout has no local branches"
              : read.value
                  .map(
                    (branch) =>
                      `${branch.current ? "*" : " "} ${branch.name} ${branch.head}${
                        branch.upstream === null ? "" : ` → ${branch.upstream}`
                      }`,
                  )
                  .join("\n"),
        };
      },
    },
  ];
}
