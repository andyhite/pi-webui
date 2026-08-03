/**
 * Concept producers: issues as tickets, epics-with-children as collections, and an
 * issue's workflow as a document (§9.4, §3.1).
 *
 * Every one of them obeys the same three rules:
 *
 * - **Present or absent, never degraded** (§3.1). A read Jira refused returns no object
 *   and names itself in `unavailable`; there is no half-filled ticket and no "source
 *   unavailable" object on the graph.
 * - **A broken connection is an integration health problem, never missing data**
 *   (§9.3). No credential injected for this call means the read says exactly that, and
 *   a stored credential that is not a Jira Cloud pair says that instead.
 * - **Reads may be scheduled; runs may not** (principle 2). `refresh` is `on-demand`:
 *   Jira can be polled, and the substrate (Epic 7.2) will offer an interval, but
 *   nothing a producer does starts a session.
 */
import type {
  ConceptProducer,
  PluginCallContext,
  ProducedObject,
  ReadRequest,
  ReadResult,
} from "@plotroom/plugin-sdk";

import {
  collectionExternalId,
  epicCollectionObject,
  readIssue,
  readSearch,
  readTransitions,
  ticketObject,
  workflowExternalId,
  workflowObject,
  type IssueRead,
} from "./model.js";
import {
  DEFAULT_PAGE_SIZE,
  JIRA_SCOPE_EXAMPLE,
  JIRA_SCOPE_LANGUAGE,
  parseExternalId,
  parseJiraScope,
  type JiraScope,
} from "./scope.js";
import { JiraApi, type HttpTransport } from "./transport.js";

export const ISSUE_PRODUCER_ID = "jira-issues";
export const EPIC_PRODUCER_ID = "jira-epics-as-collections";
export const WORKFLOW_PRODUCER_ID = "jira-workflow";

const scoping = {
  language: JIRA_SCOPE_LANGUAGE,
  example: JIRA_SCOPE_EXAMPLE,
};

/** The fields every read asks for by name, so a payload's shape is this plugin's. */
export const ISSUE_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "assignee",
  "reporter",
  "priority",
  "labels",
  "resolution",
  "updated",
  "parent",
  "description",
].join(",");

export const searchPath = (jql: string, limit: number): string =>
  `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${limit}&fields=${ISSUE_FIELDS}`;

export const issuePath = (key: string): string =>
  `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`;

export const transitionsPath = (key: string): string =>
  `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`;

interface Resolved {
  readonly scope: JiraScope;
  readonly api: JiraApi;
  /** Set for a per-object refresh (§9.1): the one issue key the id names. */
  readonly key: string | null;
}

type Resolution =
  | { readonly ok: true; readonly resolved: Resolved }
  | { readonly ok: false; readonly result: ReadResult };

/**
 * The scope, the connection, and the one object a refresh names — resolved once,
 * because each of the three failures has to be reported as itself.
 *
 * A per-object refresh may arrive with no scope at all, which is why this plugin's
 * external ids carry the site: the id alone is enough to re-read one issue.
 */
function resolve(
  transport: HttpTransport,
  request: ReadRequest,
  context: PluginCallContext,
): Resolution {
  const parsedScope = parseJiraScope(request.scope);
  const target =
    request.externalId === null ? null : parseExternalId(request.externalId);
  if (!parsedScope.ok && target === null) {
    return {
      ok: false,
      result: {
        objects: [],
        unavailable: [
          {
            externalId: request.externalId ?? "(no scope)",
            why: parsedScope.why,
          },
        ],
      },
    };
  }
  const refresh = target as NonNullable<typeof target>;
  const scope: JiraScope = parsedScope.ok
    ? parsedScope.scope
    : {
        // A refresh of one object: its own key is the query, in Jira's own language.
        site: refresh.site,
        jql: `issue = ${refresh.key}`,
        // Not 1. A per-object refresh reads its object **by key**, so this limit
        // bounds only the secondary reads a producer makes about it — an epic's
        // children, an issue's transitions — and a limit of one there would have
        // reported every child but the first as omitted.
        limit: DEFAULT_PAGE_SIZE,
      };

  const connection = JiraApi.connect(
    transport,
    scope.site,
    context.credentials,
  );
  if (!connection.connected) {
    return {
      ok: false,
      result: {
        objects: [],
        unavailable: [
          {
            externalId: request.externalId ?? `jira:site:${scope.site}`,
            why: connection.why,
          },
        ],
      },
    };
  }
  return {
    ok: true,
    resolved: { scope, api: connection.api, key: target?.key ?? null },
  };
}

/**
 * Read one issue, or the issues a JQL query names.
 *
 * A refresh addresses one issue directly rather than through a query, because
 * `issue = KEY` would fail for an issue that has been moved to another project — its
 * key changes and the direct read follows the redirect, which is what keeps a re-read
 * reconciling rather than dropping the card (§3.1).
 */
async function readIssues(resolved: Resolved): Promise<
  | {
      readonly ok: true;
      readonly issues: readonly IssueRead[];
      readonly more: boolean;
    }
  | { readonly ok: false; readonly why: string }
> {
  if (resolved.key !== null) {
    const one = await resolved.api.get(issuePath(resolved.key));
    if (!one.ok) {
      return { ok: false, why: one.message };
    }
    const issue = readIssue(one.value);
    return issue === null
      ? {
          ok: false,
          why: "Jira answered with a payload that has no issue key in it",
        }
      : { ok: true, issues: [issue], more: false };
  }
  const found = await resolved.api.get(
    searchPath(resolved.scope.jql, resolved.scope.limit),
  );
  if (!found.ok) {
    return { ok: false, why: found.message };
  }
  const search = readSearch(found.value);
  return { ok: true, issues: search.issues, more: search.more };
}

export function createIssueProducer(
  transport: HttpTransport,
  permissions: readonly string[],
): ConceptProducer {
  return {
    id: ISSUE_PRODUCER_ID,
    kinds: ["ticket"],
    refresh: { kind: "on-demand" },
    scoping,
    permissions,
    async read(
      request: ReadRequest,
      context: PluginCallContext,
    ): Promise<ReadResult> {
      const resolution = resolve(transport, request, context);
      if (!resolution.ok) {
        return resolution.result;
      }
      const { scope } = resolution.resolved;
      context.log(`reading issues on ${scope.site}: ${scope.jql}`);
      const read = await readIssues(resolution.resolved);
      if (!read.ok) {
        return {
          objects: [],
          unavailable: [
            {
              externalId: request.externalId ?? `jira:query:${scope.site}`,
              why: read.why,
            },
          ],
        };
      }
      // More than one page is reported rather than silently standing in for the
      // query (principle 12): the page that was read is present, and the fact that
      // it is a page is a named unavailability rather than a shorter list.
      const unavailable = read.more
        ? [
            {
              externalId: `jira:query:${scope.site}`,
              why: `Jira has more issues matching this query than the scope's limit of ${scope.limit}; the rest were not read`,
            },
          ]
        : [];
      return {
        objects: read.issues.map((issue) => ticketObject(scope.site, issue)),
        unavailable,
      };
    },
  };
}

/**
 * Epics with their children, as collections **and** as the children themselves.
 *
 * The scope selects epics (`issuetype = Epic AND project = OXY`); each epic's children
 * are then read with Jira's own `parent = KEY`. Both the collection and every child
 * `ticket` come back from one read, which is what makes §3.1's expand-and-drag gesture
 * work over objects that already exist — see `model.ts` for why membership is stated as
 * content plus co-produced members and not as a schema core does not have.
 */
export function createEpicProducer(
  transport: HttpTransport,
  permissions: readonly string[],
): ConceptProducer {
  return {
    id: EPIC_PRODUCER_ID,
    kinds: ["collection", "ticket"],
    refresh: { kind: "on-demand" },
    scoping: {
      language: JIRA_SCOPE_LANGUAGE,
      example: "site=acme.atlassian.net issuetype = Epic AND project = OXY",
    },
    permissions,
    async read(
      request: ReadRequest,
      context: PluginCallContext,
    ): Promise<ReadResult> {
      const resolution = resolve(transport, request, context);
      if (!resolution.ok) {
        return resolution.result;
      }
      const { scope, api } = resolution.resolved;
      context.log(`reading epics on ${scope.site}: ${scope.jql}`);
      const epics = await readIssues(resolution.resolved);
      if (!epics.ok) {
        return {
          objects: [],
          unavailable: [
            {
              externalId: request.externalId ?? `jira:query:${scope.site}`,
              why: epics.why,
            },
          ],
        };
      }

      const objects: ProducedObject[] = [];
      const unavailable: { externalId: string; why: string }[] = [];
      if (epics.more) {
        unavailable.push({
          externalId: `jira:query:${scope.site}`,
          why: `Jira has more epics matching this query than the scope's limit of ${scope.limit}; the rest were not read`,
        });
      }

      for (const epic of epics.issues) {
        const children = await api.get(
          searchPath(`parent = ${epic.key} ORDER BY key ASC`, scope.limit),
        );
        if (!children.ok) {
          // The epic is a ticket in its own right, but a collection whose membership
          // could not be read is a degraded collection, and §3.1 has no such state:
          // no object, and the reason named.
          unavailable.push({
            externalId: collectionExternalId({
              site: scope.site,
              key: epic.key,
            }),
            why: children.message,
          });
          continue;
        }
        const read = readSearch(children.value);
        objects.push(
          epicCollectionObject(scope.site, {
            epic,
            children: read.issues,
            childrenIncomplete: read.more,
            omittedChildren:
              read.total === null ? null : read.total - read.issues.length,
          }),
        );
        for (const child of read.issues) {
          objects.push(ticketObject(scope.site, child));
        }
      }
      return { objects, unavailable };
    },
  };
}

/**
 * An issue's workflow: the status it is in and the transitions available from there.
 *
 * Two reads per issue, deliberately: the transitions Jira offers depend on the workflow
 * *and* on the calling account's permissions, so they are asked for rather than derived
 * from the status (principle 7).
 */
export function createWorkflowProducer(
  transport: HttpTransport,
  permissions: readonly string[],
): ConceptProducer {
  return {
    id: WORKFLOW_PRODUCER_ID,
    kinds: ["document"],
    refresh: { kind: "on-demand" },
    scoping: {
      language: JIRA_SCOPE_LANGUAGE,
      example: "site=acme.atlassian.net issue = OXY-2",
    },
    permissions,
    async read(
      request: ReadRequest,
      context: PluginCallContext,
    ): Promise<ReadResult> {
      const resolution = resolve(transport, request, context);
      if (!resolution.ok) {
        return resolution.result;
      }
      const { scope, api } = resolution.resolved;
      context.log(`reading workflows on ${scope.site}: ${scope.jql}`);
      const issues = await readIssues(resolution.resolved);
      if (!issues.ok) {
        return {
          objects: [],
          unavailable: [
            {
              externalId: request.externalId ?? `jira:query:${scope.site}`,
              why: issues.why,
            },
          ],
        };
      }
      const objects: ProducedObject[] = [];
      const unavailable: { externalId: string; why: string }[] = [];
      for (const issue of issues.issues) {
        const answer = await api.get(transitionsPath(issue.key));
        if (!answer.ok) {
          unavailable.push({
            externalId: workflowExternalId({
              site: scope.site,
              key: issue.key,
            }),
            why: answer.message,
          });
          continue;
        }
        objects.push(
          workflowObject(scope.site, issue, readTransitions(answer.value)),
        );
      }
      return { objects, unavailable };
    },
  };
}
