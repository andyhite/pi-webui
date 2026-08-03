/**
 * Agent tools (§10.1, principle 8).
 *
 * "Each write is available both as a UI action **and** as an agent tool" — so the
 * three write tools here do not reimplement anything: each names its `writeActionId`
 * and calls that action's `perform`, which is what makes the two paths refuse and
 * succeed identically. A second implementation of merging is a second set of rules
 * about merging.
 *
 * `context.actor` is the **calling session**, supplied by the host per call
 * (principle 1). Nothing here reads it to decide anything and nothing here can set
 * it: a plugin's tool acts as whoever called it, and there is no field in the
 * contract by which a plugin names an actor.
 */
import type {
  AgentTool,
  PluginCallContext,
  ToolResult,
  WriteAction,
} from "@plotroom/plugin-sdk";

import { pullRequestObject, readPullRequest, repositorySlug } from "./model.js";
import { parseRepository } from "./scope.js";
import { GitHubApi, type HttpTransport } from "./transport.js";
import { CLOSE_ISSUE_ACTION, COMMENT_ACTION, MERGE_ACTION } from "./writes.js";

const repositoryField = {
  type: "string" as const,
  required: true,
  description: "the repository, as owner/name",
};

const numberField = {
  type: "number" as const,
  required: true,
  description: "the pull request or issue number",
};

/** One agent tool per write action, delegating to the action itself. */
function writeTool(
  action: WriteAction,
  name: string,
  summary: string,
  outputDescription: string,
  permissions: readonly string[],
): AgentTool {
  return {
    name,
    summary,
    input: action.input,
    output: { description: outputDescription },
    requires: {
      mutates: true,
      // Reversibility comes from the write action, so §6.6 asks about the same
      // declaration whoever pressed it.
      writeActionId: action.id,
      permissions,
    },
    async call(
      input: unknown,
      context: PluginCallContext,
    ): Promise<ToolResult> {
      const result = await action.perform(input, context);
      return {
        ok: result.ok,
        content: [
          result.message,
          result.readBack === null
            ? "GitHub was not re-read afterwards, so this is what it answered, not what it now says."
            : `Read back: ${result.readBack.renderings.summary}`,
        ].join("\n"),
      };
    },
  };
}

export function createGitHubTools(
  transport: HttpTransport,
  writeActions: readonly WriteAction[],
  permissions: readonly string[],
): readonly AgentTool[] {
  const find = (id: string): WriteAction => {
    const action = writeActions.find((candidate) => candidate.id === id);
    if (action === undefined) {
      throw new Error(`no write action named ${id}`);
    }
    return action;
  };

  return [
    {
      name: "github_read_pull_request",
      summary:
        "read one pull request: state, branches, author, requested reviewers and body",
      input: { repository: repositoryField, number: numberField },
      output: {
        description:
          "the pull request's agent-ready content, or why GitHub could not answer",
      },
      requires: { mutates: false, writeActionId: null, permissions },
      async call(
        input: unknown,
        context: PluginCallContext,
      ): Promise<ToolResult> {
        const raw =
          typeof input === "object" && input !== null
            ? (input as Record<string, unknown>)
            : {};
        const repository =
          typeof raw["repository"] === "string"
            ? parseRepository(raw["repository"])
            : null;
        const number =
          typeof raw["number"] === "number" && Number.isInteger(raw["number"])
            ? raw["number"]
            : null;
        if (repository === null || number === null) {
          return {
            ok: false,
            content: "this tool needs a repository (owner/name) and a number",
          };
        }
        const connection = GitHubApi.connect(transport, context.credentials);
        if (!connection.connected) {
          return { ok: false, content: connection.why };
        }
        const slug = repositorySlug(repository);
        context.log(`reading ${slug}#${number}`);
        const one = await connection.api.get(`/repos/${slug}/pulls/${number}`);
        if (!one.ok) {
          return { ok: false, content: one.message };
        }
        const pull = readPullRequest(one.value);
        return pull === null
          ? {
              ok: false,
              content:
                "GitHub answered with a payload that has no pull request number in it",
            }
          : {
              ok: true,
              content: pullRequestObject(repository, pull).renderings
                .agentContent,
            };
      },
    },
    writeTool(
      find(COMMENT_ACTION),
      "github_comment",
      "comment on a pull request or issue",
      "what GitHub said happened, and the object as it reads afterwards",
      permissions,
    ),
    writeTool(
      find(CLOSE_ISSUE_ACTION),
      "github_transition_issue",
      "open or close an issue",
      "what GitHub said happened, and the issue as it reads afterwards",
      permissions,
    ),
    writeTool(
      find(MERGE_ACTION),
      "github_merge_pull_request",
      "merge a pull request — irreversible, so §6.6 asks first",
      "what GitHub said happened, and the pull request as it reads afterwards",
      permissions,
    ),
  ];
}
