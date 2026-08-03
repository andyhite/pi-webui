/**
 * Concept producers: pull requests, reviews, issues-as-tickets, and repository
 * metadata (§9.4, §3.1).
 *
 * Every one of them obeys the same three rules:
 *
 * - **Present or absent, never degraded** (§3.1). A read GitHub refused returns no
 *   object and names itself in `unavailable`; there is no half-filled pull request
 *   and no "source unavailable" object on the graph.
 * - **A broken connection is an integration health problem, never missing data**
 *   (§9.3). No credential injected for this call means the read says exactly that.
 * - **Reads may be scheduled; runs may not** (principle 2). `refresh` is
 *   `on-demand`: GitHub can be polled, and the substrate (Epic 7.2) will offer an
 *   interval, but nothing a producer does starts a session.
 */
import type {
  ConceptProducer,
  PluginCallContext,
  ReadRequest,
  ReadResult,
} from "@plotroom/plugin-sdk";

import {
  pullRequestObject,
  readIssue,
  readList,
  readPullRequest,
  readRepository,
  readReview,
  repositoryExternalId,
  repositoryObject,
  repositorySlug,
  reviewObject,
  ticketObject,
  type RepositoryRef,
} from "./model.js";
import {
  GITHUB_SCOPE_EXAMPLE,
  GITHUB_SCOPE_LANGUAGE,
  parseExternalId,
  parseGitHubScope,
  type GitHubScope,
} from "./scope.js";
import { GitHubApi, type HttpTransport } from "./transport.js";

export const PULL_REQUEST_PRODUCER_ID = "pull-requests";
export const REVIEW_PRODUCER_ID = "reviews";
export const TICKET_PRODUCER_ID = "issues-as-tickets";
export const REPOSITORY_PRODUCER_ID = "repository-metadata";

const scoping = {
  language: GITHUB_SCOPE_LANGUAGE,
  example: GITHUB_SCOPE_EXAMPLE,
};

interface Resolved {
  readonly scope: GitHubScope;
  readonly api: GitHubApi;
  /** Set for a per-object refresh (§9.1). */
  readonly number: number | null;
}

type Resolution =
  | { readonly ok: true; readonly resolved: Resolved }
  | { readonly ok: false; readonly result: ReadResult };

/**
 * The scope, the connection, and the one object a refresh names — resolved once,
 * because each of the three failures has to be reported as itself.
 */
function resolve(
  transport: HttpTransport,
  request: ReadRequest,
  context: PluginCallContext,
): Resolution {
  const parsedScope = parseGitHubScope(request.scope);
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
  const repository: RepositoryRef | null = parsedScope.ok
    ? parsedScope.scope.repository
    : (target?.repository ?? null);
  if (repository === null) {
    return {
      ok: false,
      result: {
        objects: [],
        unavailable: [
          {
            externalId: request.externalId ?? "(no scope)",
            why: `neither the scope nor the external id names a repository, e.g. "${GITHUB_SCOPE_EXAMPLE}"`,
          },
        ],
      },
    };
  }
  const scope: GitHubScope = parsedScope.ok
    ? parsedScope.scope
    : { repository, state: "open", limit: 1 };

  const connection = GitHubApi.connect(transport, context.credentials);
  if (!connection.connected) {
    return {
      ok: false,
      result: {
        objects: [],
        unavailable: [
          {
            externalId: request.externalId ?? repositoryExternalId(repository),
            why: connection.why,
          },
        ],
      },
    };
  }
  return {
    ok: true,
    resolved: {
      scope,
      api: connection.api,
      number: target?.number ?? null,
    },
  };
}

export function createPullRequestProducer(
  transport: HttpTransport,
  permissions: readonly string[],
): ConceptProducer {
  return {
    id: PULL_REQUEST_PRODUCER_ID,
    kinds: ["pull_request"],
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
      const { scope, api, number } = resolution.resolved;
      const slug = repositorySlug(scope.repository);
      context.log(`reading pull requests in ${slug}`);

      if (number !== null) {
        const one = await api.get(`/repos/${slug}/pulls/${number}`);
        if (!one.ok) {
          return {
            objects: [],
            unavailable: [
              { externalId: request.externalId as string, why: one.message },
            ],
          };
        }
        const pull = readPullRequest(one.value);
        return pull === null
          ? {
              objects: [],
              unavailable: [
                {
                  externalId: request.externalId as string,
                  why: "GitHub answered with a payload that has no pull request number in it",
                },
              ],
            }
          : {
              objects: [pullRequestObject(scope.repository, pull)],
              unavailable: [],
            };
      }

      const list = await api.get(
        `/repos/${slug}/pulls?state=${scope.state}&per_page=${scope.limit}`,
      );
      if (!list.ok) {
        return {
          objects: [],
          unavailable: [
            {
              externalId: repositoryExternalId(scope.repository),
              why: list.message,
            },
          ],
        };
      }
      const objects = readList(list.value)
        .map(readPullRequest)
        .filter((pull): pull is NonNullable<typeof pull> => pull !== null)
        .map((pull) => pullRequestObject(scope.repository, pull));
      return { objects, unavailable: [] };
    },
  };
}

export function createReviewProducer(
  transport: HttpTransport,
  permissions: readonly string[],
): ConceptProducer {
  return {
    id: REVIEW_PRODUCER_ID,
    kinds: ["review"],
    refresh: { kind: "on-demand" },
    scoping: {
      language: GITHUB_SCOPE_LANGUAGE,
      example: "repo:acme/app pull:12",
    },
    permissions,
    async read(
      request: ReadRequest,
      context: PluginCallContext,
    ): Promise<ReadResult> {
      // A review belongs to one pull request, so this producer needs the pull
      // request's number: from the refreshed object's external id, or from `pull:N`
      // in the scope.
      const pullFromScope = /(?:^|\s)pull:(\d+)(?:\s|$)/u.exec(
        request.scope ?? "",
      );
      const cleanedScope =
        request.scope === null
          ? null
          : request.scope.replace(/(?:^|\s)pull:\d+/u, "").trim();
      const resolution = resolve(
        transport,
        { scope: cleanedScope, externalId: request.externalId },
        context,
      );
      if (!resolution.ok) {
        return resolution.result;
      }
      const { scope, api, number } = resolution.resolved;
      const pullNumber =
        number ??
        (pullFromScope === null
          ? null
          : Number.parseInt(pullFromScope[1] as string, 10));
      const slug = repositorySlug(scope.repository);
      if (pullNumber === null) {
        return {
          objects: [],
          unavailable: [
            {
              externalId: repositoryExternalId(scope.repository),
              why: 'reviews belong to one pull request; name it, e.g. "repo:acme/app pull:12"',
            },
          ],
        };
      }
      context.log(`reading reviews on ${slug}#${pullNumber}`);
      const list = await api.get(
        `/repos/${slug}/pulls/${pullNumber}/reviews?per_page=${scope.limit}`,
      );
      if (!list.ok) {
        return {
          objects: [],
          unavailable: [
            {
              externalId: `github:pull_request:${slug}#${pullNumber}`,
              why: list.message,
            },
          ],
        };
      }
      const objects = readList(list.value)
        .map(readReview)
        .filter(
          (review): review is NonNullable<typeof review> => review !== null,
        )
        .map((review) => reviewObject(scope.repository, pullNumber, review));
      return { objects, unavailable: [] };
    },
  };
}

export function createTicketProducer(
  transport: HttpTransport,
  permissions: readonly string[],
): ConceptProducer {
  return {
    id: TICKET_PRODUCER_ID,
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
      const { scope, api, number } = resolution.resolved;
      const slug = repositorySlug(scope.repository);
      context.log(`reading issues in ${slug}`);

      if (number !== null) {
        const one = await api.get(`/repos/${slug}/issues/${number}`);
        if (!one.ok) {
          return {
            objects: [],
            unavailable: [
              { externalId: request.externalId as string, why: one.message },
            ],
          };
        }
        const issue = readIssue(one.value);
        if (issue === null || issue.isPullRequest) {
          return {
            objects: [],
            unavailable: [
              {
                externalId: request.externalId as string,
                why:
                  issue === null
                    ? "GitHub answered with a payload that has no issue number in it"
                    : `${slug}#${number} is a pull request, not a ticket`,
              },
            ],
          };
        }
        return {
          objects: [ticketObject(scope.repository, issue)],
          unavailable: [],
        };
      }

      const list = await api.get(
        `/repos/${slug}/issues?state=${scope.state}&per_page=${scope.limit}`,
      );
      if (!list.ok) {
        return {
          objects: [],
          unavailable: [
            {
              externalId: repositoryExternalId(scope.repository),
              why: list.message,
            },
          ],
        };
      }
      // GitHub's issue list includes pull requests; a ticket is not one of those.
      const objects = readList(list.value)
        .map(readIssue)
        .filter(
          (issue): issue is NonNullable<typeof issue> =>
            issue !== null && !issue.isPullRequest,
        )
        .map((issue) => ticketObject(scope.repository, issue));
      return { objects, unavailable: [] };
    },
  };
}

export function createRepositoryProducer(
  transport: HttpTransport,
  permissions: readonly string[],
): ConceptProducer {
  return {
    id: REPOSITORY_PRODUCER_ID,
    kinds: ["document"],
    refresh: { kind: "on-demand" },
    scoping: { language: GITHUB_SCOPE_LANGUAGE, example: "repo:acme/app" },
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
      const slug = repositorySlug(scope.repository);
      context.log(`reading repository metadata for ${slug}`);
      const one = await api.get(`/repos/${slug}`);
      if (!one.ok) {
        return {
          objects: [],
          unavailable: [
            {
              externalId: repositoryExternalId(scope.repository),
              why: one.message,
            },
          ],
        };
      }
      const read = readRepository(one.value);
      return read === null
        ? {
            objects: [],
            unavailable: [
              {
                externalId: repositoryExternalId(scope.repository),
                why: "GitHub answered with a payload that has no repository name in it",
              },
            ],
          }
        : {
            objects: [repositoryObject(scope.repository, read)],
            unavailable: [],
          };
    },
  };
}
