/**
 * Agent tools (§10.1, principle 8).
 *
 * "Each write is available both as a UI action **and** as an agent tool" — so the five
 * write tools here do not reimplement anything: each names its `writeActionId` and
 * calls that action's `perform`, which is what makes the two paths refuse and succeed
 * identically. A second implementation of a transition is a second set of rules about
 * transitions.
 *
 * The three reads exist because a session that is about to write needs to see first:
 * one issue, a JQL query, and **which transitions Jira will actually accept**, which no
 * amount of reading a status tells you.
 *
 * `context.actor` is the **calling session**, supplied by the host per call
 * (principle 1). Nothing here reads it to decide anything and nothing here can set it:
 * a plugin's tool acts as whoever called it, and there is no field in the contract by
 * which a plugin names an actor.
 */
import type {
  AgentTool,
  PluginCallContext,
  ToolResult,
  WriteAction,
} from "@plotroom/plugin-sdk";

import {
  readIssue,
  readSearch,
  readTransitions,
  ticketObject,
  workflowObject,
} from "./model.js";
import { issuePath, searchPath, transitionsPath } from "./producers.js";
import { isIssueKey, MAX_PAGE_SIZE } from "./scope.js";
import { JiraApi, type HttpTransport } from "./transport.js";
import {
  ASSIGN_ACTION,
  COMMENT_ACTION,
  CREATE_ISSUE_ACTION,
  TRANSITION_ACTION,
  UPDATE_SUMMARY_ACTION,
} from "./writes.js";

const siteField = {
  type: "string" as const,
  required: true,
  description: "the Jira Cloud site, e.g. acme.atlassian.net",
};

const keyField = {
  type: "string" as const,
  required: true,
  description: "the issue key, e.g. OXY-2982",
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
            ? "Jira was not re-read afterwards, so this is what it answered, not what it now says."
            : `Read back: ${result.readBack.renderings.summary}`,
        ].join("\n"),
      };
    },
  };
}

interface Connected {
  readonly site: string;
  readonly api: JiraApi;
}

type Connection =
  | { readonly ok: true; readonly connected: Connected }
  | { readonly ok: false; readonly result: ToolResult };

function connect(
  transport: HttpTransport,
  input: unknown,
  context: PluginCallContext,
): Connection {
  const raw =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const site = typeof raw["site"] === "string" ? raw["site"].trim() : "";
  if (site === "") {
    return {
      ok: false,
      result: {
        ok: false,
        content:
          "this tool needs the Jira site, e.g. acme.atlassian.net; there is no default site",
      },
    };
  }
  const connection = JiraApi.connect(transport, site, context.credentials);
  return connection.connected
    ? { ok: true, connected: { site, api: connection.api } }
    : { ok: false, result: { ok: false, content: connection.why } };
}

const keyOf = (input: unknown): string | null => {
  const raw =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const key = typeof raw["key"] === "string" ? raw["key"].trim() : "";
  return isIssueKey(key) ? key : null;
};

export function createJiraTools(
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
      name: "jira_read_ticket",
      summary:
        "read one Jira issue as a ticket: status, type, assignee, labels and description",
      input: { site: siteField, key: keyField },
      output: {
        description:
          "the ticket's agent-ready content, or why Jira could not answer",
      },
      requires: { mutates: false, writeActionId: null, permissions },
      async call(
        input: unknown,
        context: PluginCallContext,
      ): Promise<ToolResult> {
        const connection = connect(transport, input, context);
        if (!connection.ok) {
          return connection.result;
        }
        const key = keyOf(input);
        if (key === null) {
          return {
            ok: false,
            content: "this tool needs an issue key like OXY-2982",
          };
        }
        context.log(`reading ${key}`);
        const one = await connection.connected.api.get(issuePath(key));
        if (!one.ok) {
          return { ok: false, content: one.message };
        }
        const issue = readIssue(one.value);
        return issue === null
          ? {
              ok: false,
              content:
                "Jira answered with a payload that has no issue key in it",
            }
          : {
              ok: true,
              content: ticketObject(connection.connected.site, issue).renderings
                .agentContent,
            };
      },
    },
    {
      name: "jira_search",
      summary:
        "search Jira with JQL — its own query language, passed through unedited (§9.1)",
      input: {
        site: siteField,
        jql: {
          type: "string",
          required: true,
          description:
            "the JQL query, e.g. project = OXY AND statusCategory != Done",
        },
        limit: {
          type: "number",
          required: false,
          description: `how many issues to read, capped at ${MAX_PAGE_SIZE}`,
        },
      },
      output: {
        description:
          "one line per matching issue, and a note when Jira has more than were read",
      },
      requires: { mutates: false, writeActionId: null, permissions },
      async call(
        input: unknown,
        context: PluginCallContext,
      ): Promise<ToolResult> {
        const connection = connect(transport, input, context);
        if (!connection.ok) {
          return connection.result;
        }
        const raw = input as Record<string, unknown>;
        const jql = typeof raw["jql"] === "string" ? raw["jql"].trim() : "";
        if (jql === "") {
          return {
            ok: false,
            content:
              "this tool needs a JQL query; JQL is what says which issues (§9.1)",
          };
        }
        const asked =
          typeof raw["limit"] === "number" && Number.isInteger(raw["limit"])
            ? raw["limit"]
            : 25;
        if (asked <= 0) {
          return {
            ok: false,
            content: `limit must be a positive integer, not ${asked}`,
          };
        }
        const limit = Math.min(asked, MAX_PAGE_SIZE);
        context.log(`searching ${connection.connected.site}: ${jql}`);
        const found = await connection.connected.api.get(
          searchPath(jql, limit),
        );
        if (!found.ok) {
          return { ok: false, content: found.message };
        }
        const search = readSearch(found.value);
        const lines = search.issues.map(
          (issue) =>
            ticketObject(connection.connected.site, issue).renderings.summary,
        );
        return {
          ok: true,
          content: [
            `${search.issues.length} issue${search.issues.length === 1 ? "" : "s"} read for: ${jql}`,
            ...lines,
            // Never a silent page standing in for a query (principle 12).
            search.more
              ? `Jira has more matches than the limit of ${limit}; the rest were not read.`
              : null,
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
        };
      },
    },
    {
      name: "jira_read_transitions",
      summary:
        "read which transitions Jira will accept for an issue right now, with their ids",
      input: { site: siteField, key: keyField },
      output: {
        description:
          "the issue's current status and every transition available from it, by id",
      },
      requires: { mutates: false, writeActionId: null, permissions },
      async call(
        input: unknown,
        context: PluginCallContext,
      ): Promise<ToolResult> {
        const connection = connect(transport, input, context);
        if (!connection.ok) {
          return connection.result;
        }
        const key = keyOf(input);
        if (key === null) {
          return {
            ok: false,
            content: "this tool needs an issue key like OXY-2982",
          };
        }
        const one = await connection.connected.api.get(issuePath(key));
        if (!one.ok) {
          return { ok: false, content: one.message };
        }
        const issue = readIssue(one.value);
        if (issue === null) {
          return {
            ok: false,
            content: "Jira answered with a payload that has no issue key in it",
          };
        }
        const answer = await connection.connected.api.get(transitionsPath(key));
        if (!answer.ok) {
          return { ok: false, content: answer.message };
        }
        return {
          ok: true,
          content: workflowObject(
            connection.connected.site,
            issue,
            readTransitions(answer.value),
          ).renderings.agentContent,
        };
      },
    },
    writeTool(
      find(COMMENT_ACTION),
      "jira_comment",
      "comment on a Jira issue",
      "what Jira said happened, and the issue as it reads afterwards",
      permissions,
    ),
    writeTool(
      find(TRANSITION_ACTION),
      "jira_transition_issue",
      "move a Jira issue through a transition, by id — read the transitions first",
      "what Jira said happened, where the issue actually landed, and whether the workflow offers a way back",
      permissions,
    ),
    writeTool(
      find(ASSIGN_ACTION),
      "jira_assign_issue",
      "assign a Jira issue, or unassign it",
      "what Jira said happened, and the issue as it reads afterwards",
      permissions,
    ),
    writeTool(
      find(UPDATE_SUMMARY_ACTION),
      "jira_update_summary",
      "retitle a Jira issue",
      "what Jira said happened, and the issue as it reads afterwards",
      permissions,
    ),
    writeTool(
      find(CREATE_ISSUE_ACTION),
      "jira_create_issue",
      "create a Jira issue — its key is never reissued, so §6.6 asks first",
      "what Jira said happened, and the new issue as it reads afterwards",
      permissions,
    ),
  ];
}
