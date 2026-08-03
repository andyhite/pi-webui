/**
 * Write actions, each declaring its own reversibility (§9.2, §6.6).
 *
 * "Write-back is a normal capability, not an exception. Any integration may offer
 * writes; each is available both as a UI action and as an agent tool (principle 8,
 * subject to approvals), and **each declares whether it is reversible**."
 *
 * Five writes, and the declarations are the load-bearing part — they drive §6.6's
 * irreversibility approvals and §6.3's outside-world markers. Each is declared
 * **per action**, from what Jira actually does, and none of them is guessed:
 *
 * | Action        | Reversibility | Why                                                                                            |
 * | ------------- | ------------- | ---------------------------------------------------------------------------------------------- |
 * | `comment`     | reversible    | a comment can be deleted, and deleting it restores the prior state                              |
 * | `assign`      | reversible    | assignee is a field; setting it back is the inverse, and Jira keeps the change in history        |
 * | `update`      | reversible    | editing a field overwrites a value Jira still records in the issue's history                     |
 * | `transition`  | reversible    | the issue and its history survive and status is a field a further transition moves back — with the caveat below |
 * | `create`      | **unknown**   | the issue can be deleted, but the key it consumed is never reissued and automation that already fired cannot be unfired |
 *
 * **`transition` is `reversible`, and the caveat is reported rather than guessed.**
 * Whether a *particular* workflow offers a path back is a fact only the destination
 * status reveals, and `WriteReversibility` is declared per action rather than per call,
 * so there is nowhere in contract v1 to say "reversible except from Done in this
 * project". Declaring `unknown` instead would make §6.6 ask before every ticket move —
 * which is not a stricter product, it is one where the operator stops reading the asks.
 * So the declaration states the general case, and the **read-back names the transitions
 * available from wherever the issue actually landed**, so a move with no way back says
 * so in the result. Recorded as a contract finding.
 *
 * **`create` is `unknown` rather than `reversible`**, and `unknown` is treated as
 * irreversible (principle 7): an author who cannot tell must not have that read as
 * reversible.
 *
 * **Every result is read back, never assumed** (§9.2): each `perform` re-reads the issue
 * afterwards and returns what Jira says it now is, including a rejection's own error
 * text. Jira has automation, post-functions and workflow validators, so the state you
 * asked for is emphatically not reliably the state you get.
 */
import type {
  PluginCallContext,
  ProducedObject,
  ToolInputSchema,
  WriteAction,
  WriteResult,
} from "@plotroom/plugin-sdk";

import {
  readIssue,
  readTransitions,
  ticketObject,
  type TransitionRead,
} from "./model.js";
import { issuePath, transitionsPath } from "./producers.js";
import { isIssueKey } from "./scope.js";
import { JiraApi, type ApiResult, type HttpTransport } from "./transport.js";
import {
  ASSIGN_ACTION,
  COMMENT_ACTION,
  CREATE_ISSUE_ACTION,
  TRANSITION_ACTION,
  UPDATE_SUMMARY_ACTION,
} from "./write-action-ids.js";

// The ids themselves are a leaf module (`write-action-ids.ts`), because the
// renderer half names one of them on a card action and must not import this
// file to learn it. Re-exported here so every existing import site is unchanged.
export {
  ASSIGN_ACTION,
  COMMENT_ACTION,
  CREATE_ISSUE_ACTION,
  TRANSITION_ACTION,
  UPDATE_SUMMARY_ACTION,
} from "./write-action-ids.js";

/**
 * The site, on every write.
 *
 * A write has no scope to carry it and contract v1 gives a plugin no per-connection
 * configuration channel, so the site is a declared input — the same workaround the git
 * port used for its checkout path, and the same finding.
 */
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

interface WriteTarget {
  readonly site: string;
  readonly key: string;
  readonly api: JiraApi;
}

const refused = (message: string): WriteResult => ({
  ok: false,
  message,
  readBack: null,
});

const raw = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : {};

const stringOf = (input: unknown, name: string): string | null => {
  const value = raw(input)[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

type SiteResolution =
  | { readonly ok: true; readonly site: string; readonly api: JiraApi }
  | { readonly ok: false; readonly result: WriteResult };

function resolveSite(
  transport: HttpTransport,
  input: unknown,
  context: PluginCallContext,
): SiteResolution {
  const site = stringOf(input, "site");
  if (site === null) {
    return {
      ok: false,
      result: refused(
        "this action needs the Jira site, e.g. acme.atlassian.net; there is no default site",
      ),
    };
  }
  const connection = JiraApi.connect(transport, site, context.credentials);
  if (!connection.connected) {
    return { ok: false, result: refused(connection.why) };
  }
  return { ok: true, site, api: connection.api };
}

type TargetResolution =
  | { readonly ok: true; readonly target: WriteTarget }
  | { readonly ok: false; readonly result: WriteResult };

function resolveTarget(
  transport: HttpTransport,
  input: unknown,
  context: PluginCallContext,
): TargetResolution {
  const site = resolveSite(transport, input, context);
  if (!site.ok) {
    return { ok: false, result: site.result };
  }
  const key = stringOf(input, "key");
  if (key === null || !isIssueKey(key)) {
    return {
      ok: false,
      result: refused(
        `this action needs an issue key like OXY-2982${key === null ? "" : `, not "${key}"`}`,
      ),
    };
  }
  return { ok: true, target: { site: site.site, key, api: site.api } };
}

/** Re-read the issue, so what is returned is what Jira now says (§9.2). */
async function readBackIssue(
  target: WriteTarget,
): Promise<ProducedObject | null> {
  const again = await target.api.get(issuePath(target.key));
  if (!again.ok) {
    return null;
  }
  const issue = readIssue(again.value);
  return issue === null ? null : ticketObject(target.site, issue);
}

const failureOf = (outcome: ApiResult<unknown>): WriteResult =>
  outcome.ok
    ? refused("unreachable")
    : // Jira's own text on a rejection, unedited (§9.2).
      refused(outcome.message);

/** Jira's plain-text-to-ADF, for the one direction this plugin writes. */
const adf = (body: string): unknown => ({
  type: "doc",
  version: 1,
  content: body.split("\n").map((line) => ({
    type: "paragraph",
    content: line === "" ? [] : [{ type: "text", text: line }],
  })),
});

export function createJiraWriteActions(
  transport: HttpTransport,
  permissions: readonly string[],
): readonly WriteAction[] {
  const commentInput: ToolInputSchema = {
    site: siteField,
    key: keyField,
    body: {
      type: "string",
      required: true,
      description: "the comment's text",
    },
  };

  return [
    {
      id: COMMENT_ACTION,
      action: "comment",
      system: "jira",
      reversibility: "reversible",
      input: commentInput,
      permissions,
      async perform(
        input: unknown,
        context: PluginCallContext,
      ): Promise<WriteResult> {
        const resolved = resolveTarget(transport, input, context);
        if (!resolved.ok) {
          return resolved.result;
        }
        const body = stringOf(input, "body");
        if (body === null) {
          return refused("a comment needs a body");
        }
        const posted = await resolved.target.api.post(
          `/rest/api/3/issue/${resolved.target.key}/comment`,
          { body: adf(body) },
        );
        if (!posted.ok) {
          return failureOf(posted);
        }
        return {
          ok: true,
          message: `commented on ${resolved.target.key}`,
          readBack: await readBackIssue(resolved.target),
        };
      },
    },
    {
      id: TRANSITION_ACTION,
      action: "transition",
      system: "jira",
      // See this module's header: the general case, with the specific case reported
      // from the read-back rather than guessed at before the fact.
      reversibility: "reversible",
      input: {
        site: siteField,
        key: keyField,
        transitionId: {
          type: "string",
          required: true,
          description:
            "the transition's id, as the workflow document lists it (jira_read_transitions)",
        },
        comment: {
          type: "string",
          required: false,
          description: "a comment to leave with the transition",
        },
      },
      permissions,
      async perform(
        input: unknown,
        context: PluginCallContext,
      ): Promise<WriteResult> {
        const resolved = resolveTarget(transport, input, context);
        if (!resolved.ok) {
          return resolved.result;
        }
        const transitionId = stringOf(input, "transitionId");
        if (transitionId === null) {
          return refused(
            "a transition is asked for by id; read the workflow first, because which transitions exist depends on the project's workflow and on this account's permissions",
          );
        }
        const comment = stringOf(input, "comment");
        const before = await resolved.target.api.get(
          issuePath(resolved.target.key),
        );
        const previousStatus = before.ok
          ? (readIssue(before.value)?.status ?? null)
          : null;
        const moved = await resolved.target.api.post(
          transitionsPath(resolved.target.key),
          {
            transition: { id: transitionId },
            ...(comment === null
              ? {}
              : { update: { comment: [{ add: { body: adf(comment) } }] } }),
          },
        );
        if (!moved.ok) {
          return failureOf(moved);
        }
        // Read back rather than assume: Jira's post-functions and automation rules
        // may have moved it somewhere else entirely (§9.2).
        const readBack = await readBackIssue(resolved.target);
        const landed = readBack?.renderings.card ?? null;
        const back = await backwardsTransition(resolved.target, previousStatus);
        return {
          ok: true,
          message: [
            `asked Jira to move ${resolved.target.key} through transition ${transitionId}`,
            landed === null
              ? "Jira was not re-read afterwards, so what it now says is unknown"
              : `Jira now reports: ${landed}`,
            back,
          ]
            .filter((part): part is string => part !== null)
            .join("; "),
          readBack,
        };
      },
    },
    {
      id: ASSIGN_ACTION,
      action: "assign",
      system: "jira",
      reversibility: "reversible",
      input: {
        site: siteField,
        key: keyField,
        accountId: {
          type: "string",
          required: false,
          description:
            "the Atlassian account id to assign to; omitted unassigns the issue",
        },
      },
      permissions,
      async perform(
        input: unknown,
        context: PluginCallContext,
      ): Promise<WriteResult> {
        const resolved = resolveTarget(transport, input, context);
        if (!resolved.ok) {
          return resolved.result;
        }
        const accountId = stringOf(input, "accountId");
        const assigned = await resolved.target.api.put(
          `/rest/api/3/issue/${resolved.target.key}/assignee`,
          { accountId },
        );
        if (!assigned.ok) {
          return failureOf(assigned);
        }
        return {
          ok: true,
          message:
            accountId === null
              ? `asked Jira to unassign ${resolved.target.key}`
              : `asked Jira to assign ${resolved.target.key} to ${accountId}`,
          readBack: await readBackIssue(resolved.target),
        };
      },
    },
    {
      id: UPDATE_SUMMARY_ACTION,
      action: "update",
      system: "jira",
      reversibility: "reversible",
      input: {
        site: siteField,
        key: keyField,
        summary: {
          type: "string",
          required: true,
          description: "the issue's new summary",
        },
      },
      permissions,
      async perform(
        input: unknown,
        context: PluginCallContext,
      ): Promise<WriteResult> {
        const resolved = resolveTarget(transport, input, context);
        if (!resolved.ok) {
          return resolved.result;
        }
        const summary = stringOf(input, "summary");
        if (summary === null) {
          return refused("updating a summary needs the new summary");
        }
        const edited = await resolved.target.api.put(
          `/rest/api/3/issue/${resolved.target.key}`,
          { fields: { summary } },
        );
        if (!edited.ok) {
          return failureOf(edited);
        }
        return {
          ok: true,
          message: `asked Jira to retitle ${resolved.target.key}`,
          readBack: await readBackIssue(resolved.target),
        };
      },
    },
    {
      id: CREATE_ISSUE_ACTION,
      action: "create",
      system: "jira",
      // See this module's header. `unknown` is treated as irreversible (principle 7),
      // so §6.6 asks before an issue exists that a key can never be taken back from.
      reversibility: "unknown",
      input: {
        site: siteField,
        project: {
          type: "string",
          required: true,
          description: "the project key the issue is created in, e.g. OXY",
        },
        issueType: {
          type: "string",
          required: true,
          description: "the issue type's name, e.g. Task",
        },
        summary: {
          type: "string",
          required: true,
          description: "the issue's summary",
        },
        description: {
          type: "string",
          required: false,
          description: "the issue's description",
        },
        parent: {
          type: "string",
          required: false,
          description: "the parent issue key, to create this under an epic",
        },
      },
      permissions,
      async perform(
        input: unknown,
        context: PluginCallContext,
      ): Promise<WriteResult> {
        const site = resolveSite(transport, input, context);
        if (!site.ok) {
          return site.result;
        }
        const project = stringOf(input, "project");
        const issueType = stringOf(input, "issueType");
        const summary = stringOf(input, "summary");
        if (project === null || issueType === null || summary === null) {
          return refused(
            "creating an issue needs a project key, an issue type and a summary",
          );
        }
        const parent = stringOf(input, "parent");
        if (parent !== null && !isIssueKey(parent)) {
          return refused(`"${parent}" is not an issue key like OXY-2982`);
        }
        const description = stringOf(input, "description");
        const created = await site.api.post("/rest/api/3/issue", {
          fields: {
            project: { key: project },
            issuetype: { name: issueType },
            summary,
            ...(description === null ? {} : { description: adf(description) }),
            ...(parent === null ? {} : { parent: { key: parent } }),
          },
        });
        if (!created.ok) {
          return failureOf(created);
        }
        const key =
          typeof created.value === "object" &&
          created.value !== null &&
          typeof (created.value as Record<string, unknown>)["key"] === "string"
            ? ((created.value as Record<string, unknown>)["key"] as string)
            : null;
        if (key === null) {
          return {
            ok: true,
            // The write happened; Jira's answer did not name what it made. Reported
            // as exactly that rather than as a failure, because a retry would create
            // a second issue.
            message:
              "Jira accepted the issue but its answer names no key, so the new issue could not be read back",
            readBack: null,
          };
        }
        const target: WriteTarget = { site: site.site, key, api: site.api };
        return {
          ok: true,
          message: `created ${key}`,
          readBack: await readBackIssue(target),
        };
      },
    },
  ];
}

/**
 * Whether the workflow offers a way back to where the issue was.
 *
 * This is the honest half of declaring `transition` reversible: the declaration states
 * the general case before the fact, and this states the particular case after it, from
 * observation (principle 7). A workflow with no path back says so in the result the
 * caller reads.
 */
async function backwardsTransition(
  target: WriteTarget,
  previousStatus: string | null,
): Promise<string | null> {
  if (previousStatus === null) {
    return null;
  }
  const answer = await target.api.get(transitionsPath(target.key));
  if (!answer.ok) {
    return `whether ${target.key} can move back to ${previousStatus} could not be read: ${answer.message}`;
  }
  const transitions: readonly TransitionRead[] = readTransitions(answer.value);
  const back = transitions.find(
    (transition) => transition.toStatus === previousStatus,
  );
  return back === undefined
    ? `Jira offers this account no transition back to ${previousStatus}, so this move is not reversible in this workflow`
    : `a transition back to ${previousStatus} exists ("${back.name}", id ${back.id})`;
}
