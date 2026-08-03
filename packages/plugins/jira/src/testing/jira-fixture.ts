/**
 * A recorded Jira, for tests — **the reason the transport is injected**.
 *
 * No test in this repository reaches Jira. This fake answers the exact endpoints the
 * plugin calls, and it is deliberately **stateful**: a comment lands, a transition
 * moves the issue, an assignment sticks, a created issue appears in later searches — so
 * §9.2's "a write's result is read back, never assumed" is provable rather than
 * asserted, because the read-back really does re-read something that changed.
 *
 * Three of its behaviours are the point:
 *
 * 1. **It refuses an unauthenticated request with 401**, which is how a test proves the
 *    host injected the credential: a producer that answers at all had one, and one that
 *    did not reports a connection problem (§9.3).
 * 2. **One transition does not do what it was asked to do.** Asking for `Start review`
 *    (id 31) lands the issue in **Blocked**, because this fixture has an automation rule
 *    exactly as real Jira projects do. That is §9.2's whole reason for reading a write
 *    back: "the state you asked for is not reliably the state you get".
 * 3. **`Done` has no transition out of it**, so a move to Done is honestly reported as
 *    one this workflow offers no way back from — the fact the per-action reversibility
 *    declaration cannot express before the call (see `writes.ts`).
 */
import type { HttpRequest, HttpResponse, HttpTransport } from "../transport.js";

export interface RecordedJira {
  readonly transport: HttpTransport;
  /** Every request the plugin made, in order — for in-process tests. */
  readonly requests: readonly HttpRequest[];
}

export const FIXTURE_SITE = "acme.atlassian.net";
export const FIXTURE_EMAIL = "operator@acme.test";
export const FIXTURE_TOKEN = "jira_fixture_api_token_value";
/** What the host stores and injects: Jira Cloud's `email:token` basic-auth pair. */
export const FIXTURE_CREDENTIAL = `${FIXTURE_EMAIL}:${FIXTURE_TOKEN}`;

export const FIXTURE_EPIC = "OXY-1";
export const FIXTURE_TICKET = "OXY-2";
export const FIXTURE_BUG = "OXY-3";
/** The account the fixture knows; every other account id is refused as Jira refuses one. */
export const FIXTURE_ACCOUNT_ID = "acc-andy";

const json = (status: number, body: unknown): HttpResponse => ({
  status,
  body: JSON.stringify(body),
});

const jiraError = (status: number, ...messages: string[]): HttpResponse =>
  json(status, { errorMessages: messages, errors: {} });

const STATUS_CATEGORY: Readonly<Record<string, string>> = {
  "To Do": "new",
  "In Progress": "indeterminate",
  "In Review": "indeterminate",
  Blocked: "indeterminate",
  Done: "done",
};

/** The workflow, by the status the issue is in. `Done` is deliberately terminal. */
const TRANSITIONS: Readonly<
  Record<string, readonly { id: string; name: string; to: string }[]>
> = {
  "To Do": [{ id: "21", name: "Start work", to: "In Progress" }],
  "In Progress": [
    { id: "11", name: "Back to backlog", to: "To Do" },
    { id: "31", name: "Start review", to: "In Review" },
    { id: "41", name: "Finish", to: "Done" },
  ],
  "In Review": [
    { id: "21", name: "Back to work", to: "In Progress" },
    { id: "41", name: "Finish", to: "Done" },
  ],
  Blocked: [{ id: "21", name: "Back to work", to: "In Progress" }],
  Done: [],
};

interface FixtureIssue {
  key: string;
  type: string;
  summary: string;
  status: string;
  assignee: string;
  parent: string | null;
  comments: number;
  description: string;
}

const adf = (text: string): unknown => ({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

export function createRecordedJira(): RecordedJira {
  const requests: HttpRequest[] = [];
  let nextKey = 10;

  const issues = new Map<string, FixtureIssue>(
    (
      [
        {
          key: FIXTURE_EPIC,
          type: "Epic",
          summary: "Path claims",
          status: "To Do",
          assignee: "",
          parent: null,
          comments: 0,
          description: "One writer per path, always.",
        },
        {
          key: FIXTURE_TICKET,
          type: "Task",
          summary: "Refuse illegal edges mid-drag",
          status: "To Do",
          assignee: "",
          parent: FIXTURE_EPIC,
          comments: 0,
          description:
            "The canvas must refuse an illegal edge while the drag is happening.",
        },
        {
          key: FIXTURE_BUG,
          type: "Bug",
          summary: "Login flow drops the second factor",
          status: "In Progress",
          assignee: "Andy Hite",
          parent: FIXTURE_EPIC,
          comments: 0,
          description: "Steps to reproduce…",
        },
        {
          key: "OXY-9",
          type: "Task",
          summary: "Document the claim ledger",
          status: "Done",
          assignee: "Andy Hite",
          parent: null,
          comments: 0,
          description: "Landed.",
        },
      ] satisfies FixtureIssue[]
    ).map((issue) => [issue.key, issue]),
  );

  const payload = (issue: FixtureIssue): unknown => ({
    id: `1000${issue.key.split("-")[1] as string}`,
    key: issue.key,
    fields: {
      summary: issue.summary,
      status: {
        name: issue.status,
        statusCategory: {
          key: STATUS_CATEGORY[issue.status] ?? "indeterminate",
          name: issue.status,
        },
      },
      issuetype: { name: issue.type, subtask: false },
      assignee: issue.assignee === "" ? null : { displayName: issue.assignee },
      reporter: { displayName: "Reporter Person" },
      priority: { name: "High" },
      labels: issue.type === "Bug" ? ["regression"] : [],
      resolution: issue.status === "Done" ? { name: "Done" } : null,
      updated: "2025-01-02T03:04:05.000+0000",
      parent: issue.parent === null ? null : { key: issue.parent },
      description: adf(
        `${issue.description}\n\nComments so far: ${issue.comments}`,
      ),
    },
  });

  /** The narrow slice of JQL this fixture understands, and nothing wider. */
  const query = (jql: string): readonly FixtureIssue[] | null => {
    const all = [...issues.values()].sort((a, b) =>
      a.key.localeCompare(b.key, "en", { numeric: true }),
    );
    const parent = /^parent = ([A-Z]+-\d+)/u.exec(jql);
    if (parent !== null) {
      return all.filter((issue) => issue.parent === parent[1]);
    }
    const one = /^issue = ([A-Z]+-\d+)/u.exec(jql);
    if (one !== null) {
      const found = issues.get(one[1] as string);
      return found === undefined ? [] : [found];
    }
    if (/^issuetype = Epic AND project = OXY/u.test(jql)) {
      return all.filter((issue) => issue.type === "Epic");
    }
    if (/^project = OXY/u.test(jql)) {
      return all;
    }
    return null;
  };

  const answer = (request: HttpRequest): HttpResponse => {
    const url = new URL(request.url);
    if (url.host !== FIXTURE_SITE) {
      // A site nobody can reach. Thrown rather than answered, so the transport's own
      // "could not be reached" path is what a test exercises (§9.3).
      throw new Error(`getaddrinfo ENOTFOUND ${url.host}`);
    }
    const path = `${url.pathname}${url.search}`;
    const route = `${request.method} ${url.pathname}`;

    // An unauthenticated request is refused the way Jira refuses one.
    const expected = `Basic ${Buffer.from(FIXTURE_CREDENTIAL, "utf8").toString("base64")}`;
    if (request.headers["authorization"] !== expected) {
      return jiraError(
        401,
        "Client must be authenticated to access this resource.",
      );
    }

    if (route === "GET /rest/api/3/search/jql") {
      const jql = url.searchParams.get("jql") ?? "";
      const maxResults = Number.parseInt(
        url.searchParams.get("maxResults") ?? "25",
        10,
      );
      const found = query(jql);
      if (found === null) {
        // Jira's own words for a query it will not run (§9.2).
        return jiraError(
          400,
          `Error in the JQL Query: the recorded Jira does not understand ${JSON.stringify(jql)}.`,
        );
      }
      const page = found.slice(0, maxResults);
      return json(200, {
        issues: page.map(payload),
        total: found.length,
        ...(found.length > page.length ? { nextPageToken: "page-2" } : {}),
      });
    }

    const issueMatch = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)(\/[a-z]+)?$/u.exec(
      url.pathname,
    );
    if (issueMatch !== null) {
      const issue = issues.get(issueMatch[1] as string);
      if (issue === undefined) {
        return jiraError(
          404,
          "Issue does not exist or you do not have permission to see it.",
        );
      }
      const suffix = issueMatch[2] ?? "";
      const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;

      if (request.method === "GET" && suffix === "") {
        return json(200, payload(issue));
      }
      if (request.method === "GET" && suffix === "/transitions") {
        return json(200, {
          transitions: (TRANSITIONS[issue.status] ?? []).map((transition) => ({
            id: transition.id,
            name: transition.name,
            to: {
              name: transition.to,
              statusCategory: {
                key: STATUS_CATEGORY[transition.to] ?? "indeterminate",
                name: transition.to,
              },
            },
          })),
        });
      }
      if (request.method === "POST" && suffix === "/transitions") {
        const asked = (body["transition"] as { id?: string } | undefined)?.id;
        const available = TRANSITIONS[issue.status] ?? [];
        const transition = available.find((one) => one.id === asked);
        if (transition === undefined) {
          return json(400, {
            errorMessages: [],
            errors: {
              transition: `Transition id ${String(asked)} is not valid from status ${issue.status}.`,
            },
          });
        }
        // The automation rule: a review request is bounced to Blocked. This is the
        // whole reason a write's result is read back and never assumed (§9.2).
        issue.status =
          transition.to === "In Review" ? "Blocked" : transition.to;
        if (body["update"] !== undefined) {
          issue.comments += 1;
        }
        return { status: 204, body: "" };
      }
      if (request.method === "POST" && suffix === "/comment") {
        issue.comments += 1;
        return json(201, { id: "10500" });
      }
      if (request.method === "PUT" && suffix === "/assignee") {
        const accountId = body["accountId"];
        if (accountId === null || accountId === undefined) {
          issue.assignee = "";
          return { status: 204, body: "" };
        }
        if (accountId !== FIXTURE_ACCOUNT_ID) {
          return json(400, {
            errorMessages: [],
            errors: { accountId: "Specified user does not exist." },
          });
        }
        issue.assignee = "Andy Hite";
        return { status: 204, body: "" };
      }
      if (request.method === "PUT" && suffix === "") {
        const fields = (body["fields"] ?? {}) as Record<string, unknown>;
        if (typeof fields["summary"] === "string") {
          issue.summary = fields["summary"];
        }
        return { status: 204, body: "" };
      }
    }

    if (route === "POST /rest/api/3/issue") {
      const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
      const fields = (body["fields"] ?? {}) as Record<string, unknown>;
      const type = (fields["issuetype"] as { name?: string } | undefined)?.name;
      if (type !== "Task" && type !== "Bug" && type !== "Epic") {
        return json(400, {
          errorMessages: [],
          errors: {
            issuetype: `Specified issue type ${String(type)} is not valid.`,
          },
        });
      }
      const key = `OXY-${(nextKey += 1)}`;
      issues.set(key, {
        key,
        type,
        summary: String(fields["summary"] ?? ""),
        status: "To Do",
        assignee: "",
        parent: (fields["parent"] as { key?: string } | undefined)?.key ?? null,
        comments: 0,
        description: "Created by PlotRoom.",
      });
      return json(201, { id: "10999", key });
    }

    return jiraError(
      404,
      `the recorded Jira has no route for ${request.method} ${path}`,
    );
  };

  return {
    requests,
    transport: (request) => {
      requests.push(request);
      try {
        return Promise.resolve(answer(request));
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
  };
}
