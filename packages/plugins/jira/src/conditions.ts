/**
 * Condition checks: Jira's half of "completion is proof, not a claim" (§10.1,
 * principle 3, §4.3).
 *
 * The native registry ships only workspace checks, and says why: "a check that needs
 * Jira belongs to the Jira plugin". These are those two — `jira_issue_in_status` and
 * `jira_epic_children_resolved` — and the interesting answer is the third state:
 *
 * - **`unknown` is not `unmet`.** A site the credential cannot read, or an **epic with
 *   no children at all**, has not disproved anything. Reporting either as unmet would
 *   make a missing connection read as failed work; reporting them as met would let an
 *   empty epic claim its work is finished.
 * - **The status is compared against Jira's own name and its own category**, never
 *   against a word this plugin decided means done: `statusCategory` is Jira's answer to
 *   "is this finished", and a project that spells it "Shipped" is still `done`.
 */
import type {
  ConditionCheck,
  ConditionResult,
  ToolInputSchema,
} from "@plotroom/plugin-sdk";

import { isResolved, readIssue, readSearch } from "./model.js";
import { issuePath, searchPath } from "./producers.js";
import { isIssueKey, MAX_PAGE_SIZE } from "./scope.js";
import { JiraApi, type HttpTransport } from "./transport.js";

export const ISSUE_IN_STATUS_CHECK = "jira_issue_in_status";
export const EPIC_CHILDREN_RESOLVED_CHECK = "jira_epic_children_resolved";

const siteField = {
  type: "string" as const,
  required: true,
  description: "the Jira Cloud site, e.g. acme.atlassian.net",
};

const stringOf = (input: unknown, name: string): string | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const value = (input as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

const unknown = (evidence: string): ConditionResult => ({
  state: "unknown",
  evidence,
});

export function issueInStatusCheck(
  transport: HttpTransport,
  permissions: readonly string[],
): ConditionCheck {
  const input: ToolInputSchema = {
    site: siteField,
    key: {
      type: "string",
      required: true,
      description: "the issue key the outcome is about, e.g. OXY-2982",
    },
    status: {
      type: "string",
      required: true,
      description:
        'the status it must be in — a status name, or "done" for any status Jira categorises as done',
    },
  };
  return {
    id: ISSUE_IN_STATUS_CHECK,
    summary: "a Jira issue has reached a named status",
    input,
    permissions,
    async check(raw: unknown, context): Promise<ConditionResult> {
      const site = stringOf(raw, "site");
      const key = stringOf(raw, "key");
      const status = stringOf(raw, "status");
      if (
        site === null ||
        key === null ||
        status === null ||
        !isIssueKey(key)
      ) {
        return unknown(
          "this condition needs a site, an issue key like OXY-2982 and a status, so nothing was checked — which is not proof",
        );
      }
      const connection = JiraApi.connect(transport, site, context.credentials);
      if (!connection.connected) {
        return unknown(connection.why);
      }
      const one = await connection.api.get(issuePath(key));
      if (!one.ok) {
        return unknown(one.message);
      }
      const issue = readIssue(one.value);
      if (issue === null) {
        return unknown(
          `Jira answered about ${key} with a payload that has no issue key in it`,
        );
      }
      const wantsDone = status.toLowerCase() === "done";
      const met = wantsDone
        ? isResolved(issue)
        : issue.status.toLowerCase() === status.toLowerCase();
      return {
        state: met ? "met" : "unmet",
        evidence: `Jira reports ${key} in ${issue.status} (category ${
          issue.statusCategory === "" ? "unstated" : issue.statusCategory
        })${wantsDone ? "" : `, asked for ${status}`}`,
      };
    },
  };
}

export function epicChildrenResolvedCheck(
  transport: HttpTransport,
  permissions: readonly string[],
): ConditionCheck {
  const input: ToolInputSchema = {
    site: siteField,
    epic: {
      type: "string",
      required: true,
      description: "the epic's issue key, e.g. OXY-1",
    },
  };
  return {
    id: EPIC_CHILDREN_RESOLVED_CHECK,
    summary:
      "every child of a Jira epic is in a status Jira categorises as done",
    input,
    permissions,
    async check(raw: unknown, context): Promise<ConditionResult> {
      const site = stringOf(raw, "site");
      const epic = stringOf(raw, "epic");
      if (site === null || epic === null || !isIssueKey(epic)) {
        return unknown(
          "this condition needs a site and an epic key like OXY-1, so nothing was checked — which is not proof",
        );
      }
      const connection = JiraApi.connect(transport, site, context.credentials);
      if (!connection.connected) {
        return unknown(connection.why);
      }
      const children = await connection.api.get(
        searchPath(`parent = ${epic} ORDER BY key ASC`, MAX_PAGE_SIZE),
      );
      if (!children.ok) {
        return unknown(children.message);
      }
      const read = readSearch(children.value);
      if (read.issues.length === 0) {
        // An epic with no children has not finished anything. Not a pass (principle 3).
        return unknown(
          `Jira reports no children of ${epic}; an empty epic has proved nothing`,
        );
      }
      if (read.more) {
        // A page is not the epic. Answering from one would be a proof about a subset.
        return unknown(
          `Jira reports more children of ${epic} than could be read at once, so not all of them were checked`,
        );
      }
      const open = read.issues.filter((child) => !isResolved(child));
      if (open.length > 0) {
        return {
          state: "unmet",
          evidence: `${open.length} of ${read.issues.length} children of ${epic} are not done: ${open
            .map((child) => `${child.key} (${child.status})`)
            .join(", ")}`,
        };
      }
      return {
        state: "met",
        evidence: `all ${read.issues.length} children of ${epic} are done: ${read.issues
          .map((child) => `${child.key} (${child.status})`)
          .join(", ")}`,
      };
    },
  };
}
