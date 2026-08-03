/**
 * A recorded GitHub, for tests — **the reason the transport is injected**.
 *
 * No test in this repository reaches GitHub. This fake answers the exact endpoints
 * the plugin calls, and it is deliberately **stateful**: a comment lands, a
 * transition moves the issue, a merge merges — so §9.2's "a write's result is read
 * back, never assumed" is provable rather than asserted, because the read-back really
 * does re-read something that changed.
 *
 * It also **refuses an unauthenticated request with 401**, which is how a test proves
 * the host injected the credential: a producer that answers at all had a token, and
 * one that did not reports a connection problem (§9.3).
 */
import {
  GITHUB_API_ORIGIN,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from "../transport.js";

export interface RecordedGitHub {
  readonly transport: HttpTransport;
  /** Every request the plugin made, in order — for in-process tests. */
  readonly requests: readonly HttpRequest[];
}

export const FIXTURE_TOKEN = "ghp_fixture_token_value";
export const FIXTURE_HEAD_SHA = "1111111111111111111111111111111111111111";
export const FIXTURE_UNCHECKED_SHA = "2222222222222222222222222222222222222222";

const json = (status: number, body: unknown): HttpResponse => ({
  status,
  body: JSON.stringify(body),
});

export function createRecordedGitHub(): RecordedGitHub {
  const requests: HttpRequest[] = [];
  let issueState = "open";
  let issueComments = 0;
  let merged = false;
  let requestedReviewers: string[] = [];

  const pullRequest = (): unknown => ({
    number: 12,
    title: "Refuse illegal edges mid-drag",
    state: merged ? "closed" : "open",
    draft: false,
    merged,
    mergeable: true,
    user: { login: "andy" },
    head: {
      ref: "feat/mid-drag",
      sha: FIXTURE_HEAD_SHA,
      repo: {
        clone_url: "https://github.com/acme/app.git",
        ssh_url: "git@github.com:acme/app.git",
      },
    },
    base: { ref: "main" },
    html_url: "https://github.com/acme/app/pull/12",
    body: "The canvas must refuse an illegal edge while the drag is happening.",
    changed_files: 3,
    requested_reviewers: requestedReviewers.map((login) => ({ login })),
  });

  const issue = (): unknown => ({
    number: 7,
    title: "Login flow drops the second factor",
    state: issueState,
    user: { login: "reporter" },
    assignees: [{ login: "andy" }],
    labels: [{ name: "bug" }],
    html_url: "https://github.com/acme/app/issues/7",
    body: `Steps to reproduce…\n\nComments so far: ${issueComments}`,
  });

  const repository = (): unknown => ({
    full_name: "acme/app",
    description: "The application",
    default_branch: "main",
    html_url: "https://github.com/acme/app",
    clone_url: "https://github.com/acme/app.git",
    ssh_url: "git@github.com:acme/app.git",
    language: "TypeScript",
    topics: ["canvas", "agents"],
    open_issues_count: 4,
    archived: false,
    visibility: "private",
  });

  const review = (): unknown => ({
    id: 9001,
    user: { login: "reviewer" },
    state: "CHANGES_REQUESTED",
    body: "The mid-drag refusal needs a test.",
    submitted_at: "2025-01-02T03:04:05Z",
    html_url: "https://github.com/acme/app/pull/12#pullrequestreview-9001",
  });

  const answer = (request: HttpRequest): HttpResponse => {
    const path = request.url.startsWith(GITHUB_API_ORIGIN)
      ? request.url.slice(GITHUB_API_ORIGIN.length)
      : request.url;
    const route = `${request.method} ${path}`;

    // An unauthenticated request is refused the way GitHub refuses one.
    if (request.headers["authorization"] !== `Bearer ${FIXTURE_TOKEN}`) {
      return json(401, { message: "Bad credentials" });
    }

    if (route === "GET /repos/acme/app") {
      return json(200, repository());
    }
    if (route.startsWith("GET /repos/acme/app/pulls?")) {
      const query = new URLSearchParams(path.slice(path.indexOf("?") + 1));
      const head = query.get("head");
      if (head !== null && head !== "acme:feat/mid-drag") {
        return json(200, []);
      }
      return json(200, [pullRequest()]);
    }
    if (route === "GET /repos/acme/app/pulls/12") {
      return json(200, pullRequest());
    }
    if (route.startsWith("GET /repos/acme/app/pulls/12/reviews")) {
      return json(200, [review()]);
    }
    if (route === "PUT /repos/acme/app/pulls/12/merge") {
      merged = true;
      return json(200, {
        merged: true,
        message: "Pull Request successfully merged",
      });
    }
    if (route === "PUT /repos/acme/app/pulls/13/merge") {
      // GitHub's own rejection text, which the write action must pass through
      // unedited (§9.2).
      return json(405, { message: "Pull Request is not mergeable" });
    }
    if (route === "POST /repos/acme/app/pulls/12/requested_reviewers") {
      const body = JSON.parse(request.body ?? "{}") as {
        reviewers?: readonly string[];
      };
      requestedReviewers = [...(body.reviewers ?? [])];
      return json(201, pullRequest());
    }
    if (route.startsWith("GET /repos/acme/app/issues?")) {
      // GitHub's issue list includes pull requests; the ticket producer must drop
      // this second entry.
      return json(200, [
        issue(),
        {
          number: 12,
          title: "Refuse illegal edges mid-drag",
          state: "open",
          user: { login: "andy" },
          html_url: "https://github.com/acme/app/pull/12",
          pull_request: {
            url: "https://api.github.com/repos/acme/app/pulls/12",
          },
        },
      ]);
    }
    if (route === "GET /repos/acme/app/issues/7") {
      return json(200, issue());
    }
    if (route === "POST /repos/acme/app/issues/7/comments") {
      issueComments += 1;
      return json(201, { id: 555 });
    }
    if (route === "PATCH /repos/acme/app/issues/7") {
      const body = JSON.parse(request.body ?? "{}") as { state?: string };
      issueState = body.state ?? issueState;
      return json(200, issue());
    }
    if (
      route ===
      `GET /repos/acme/app/commits/${FIXTURE_HEAD_SHA}/check-runs?per_page=100`
    ) {
      return json(200, {
        total_count: 2,
        check_runs: [
          { name: "typecheck", status: "completed", conclusion: "success" },
          { name: "test", status: "completed", conclusion: "success" },
        ],
      });
    }
    if (
      route === "GET /repos/acme/app/commits/failing/check-runs?per_page=100"
    ) {
      return json(200, {
        total_count: 2,
        check_runs: [
          { name: "typecheck", status: "completed", conclusion: "success" },
          { name: "test", status: "completed", conclusion: "failure" },
        ],
      });
    }
    if (
      route ===
      `GET /repos/acme/app/commits/${FIXTURE_UNCHECKED_SHA}/check-runs?per_page=100`
    ) {
      // A commit nothing checked. Not a pass (principle 3).
      return json(200, { total_count: 0, check_runs: [] });
    }
    if (route.startsWith("GET /repos/acme/missing")) {
      return json(404, { message: "Not Found" });
    }
    return json(404, {
      message: `the recorded GitHub has no route for ${route}`,
    });
  };

  return {
    requests,
    transport: (request) => {
      requests.push(request);
      return Promise.resolve(answer(request));
    },
  };
}
