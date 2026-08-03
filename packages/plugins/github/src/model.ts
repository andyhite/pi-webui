/**
 * GitHub's JSON, read into the first-class concepts §3.1 already has.
 *
 * **Integrations do not add concepts; they populate the ones that exist.** A GitHub
 * pull request is a `pull_request`, a review is a `review`, an **issue is a ticket**
 * ("a unit of requested work: identity in some external system, summary, status,
 * type, assignee, a link out"), and repository metadata is a `document`. There is no
 * fifth kind here and `CONCEPT_KINDS` has no room for one.
 *
 * Reading is deliberately defensive and deliberately **not** lenient about identity:
 * a payload with no number or no id produces **no object at all** rather than a
 * half-filled one, because concepts are present or absent, never degraded (§3.1),
 * and the external id is what makes a re-read reconcile rather than duplicate.
 */
import type { ProducedObject } from "@plotroom/plugin-sdk";

export interface RepositoryRef {
  readonly owner: string;
  readonly name: string;
}

export const repositorySlug = (repository: RepositoryRef): string =>
  `${repository.owner}/${repository.name}`;

export const pullRequestExternalId = (
  repository: RepositoryRef,
  number: number,
): string => `github:pull_request:${repositorySlug(repository)}#${number}`;

export const reviewExternalId = (
  repository: RepositoryRef,
  number: number,
  reviewId: number,
): string =>
  `github:review:${repositorySlug(repository)}#${number}:${reviewId}`;

export const ticketExternalId = (
  repository: RepositoryRef,
  number: number,
): string => `github:ticket:${repositorySlug(repository)}#${number}`;

export const repositoryExternalId = (repository: RepositoryRef): string =>
  `github:document:${repositorySlug(repository)}`;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

const integer = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

const login = (value: unknown): string => {
  const user = record(value);
  return user === null ? "" : text(user["login"]);
};

export interface PullRequestRead {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly draft: boolean;
  readonly merged: boolean;
  readonly mergeable: boolean | null;
  readonly author: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly url: string;
  readonly body: string;
  readonly changedFiles: number | null;
  readonly requestedReviewers: readonly string[];
  /** For clone-from-a-pull-request (§3.4): the host's git clones this, never a token URL. */
  readonly cloneUrl: string | null;
  readonly sshUrl: string | null;
}

export function readPullRequest(payload: unknown): PullRequestRead | null {
  const raw = record(payload);
  if (raw === null) {
    return null;
  }
  const number = integer(raw["number"]);
  if (number === null) {
    return null;
  }
  const head = record(raw["head"]);
  const headRepository = head === null ? null : record(head["repo"]);
  const reviewers = Array.isArray(raw["requested_reviewers"])
    ? raw["requested_reviewers"].map(login).filter((name) => name !== "")
    : [];
  return {
    number,
    title: text(raw["title"]),
    state: text(raw["state"]),
    draft: raw["draft"] === true,
    merged: raw["merged"] === true,
    mergeable: typeof raw["mergeable"] === "boolean" ? raw["mergeable"] : null,
    author: login(raw["user"]),
    headRef: head === null ? "" : text(head["ref"]),
    headSha: head === null ? "" : text(head["sha"]),
    baseRef: text(record(raw["base"])?.["ref"]),
    url: text(raw["html_url"]),
    body: text(raw["body"]),
    changedFiles: integer(raw["changed_files"]),
    requestedReviewers: reviewers,
    cloneUrl:
      headRepository === null
        ? null
        : text(headRepository["clone_url"]) || null,
    sshUrl:
      headRepository === null ? null : text(headRepository["ssh_url"]) || null,
  };
}

export function pullRequestObject(
  repository: RepositoryRef,
  pull: PullRequestRead,
): ProducedObject {
  const slug = repositorySlug(repository);
  const state = pull.merged
    ? "merged"
    : pull.draft
      ? `${pull.state} (draft)`
      : pull.state;
  const title = `${slug}#${pull.number} ${pull.title}`;
  return {
    kind: "pull_request",
    externalId: pullRequestExternalId(repository, pull.number),
    title,
    renderings: {
      card: `#${pull.number} ${pull.title} — ${state}`,
      summary: `${title} — ${state}, ${pull.headRef} → ${pull.baseRef}, by ${pull.author}`,
      agentContent: [
        `# ${title}`,
        "",
        `State: ${state}`,
        `Author: ${pull.author}`,
        `Branches: ${pull.headRef} → ${pull.baseRef}`,
        `Head: ${pull.headSha}`,
        pull.changedFiles === null
          ? null
          : `Changed files: ${pull.changedFiles}`,
        pull.requestedReviewers.length === 0
          ? null
          : `Requested reviewers: ${pull.requestedReviewers.join(", ")}`,
        `Link: ${pull.url}`,
        pull.cloneUrl === null ? null : `Clone: ${pull.cloneUrl}`,
        "",
        pull.body,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    },
  };
}

export interface ReviewRead {
  readonly id: number;
  readonly author: string;
  readonly state: string;
  readonly body: string;
  readonly submittedAt: string;
  readonly url: string;
  readonly comments: readonly {
    readonly path: string;
    readonly body: string;
  }[];
}

export function readReview(payload: unknown): ReviewRead | null {
  const raw = record(payload);
  if (raw === null) {
    return null;
  }
  const id = integer(raw["id"]);
  if (id === null) {
    return null;
  }
  return {
    id,
    author: login(raw["user"]),
    state: text(raw["state"]),
    body: text(raw["body"]),
    submittedAt: text(raw["submitted_at"]),
    url: text(raw["html_url"]),
    comments: [],
  };
}

export function reviewObject(
  repository: RepositoryRef,
  number: number,
  review: ReviewRead,
): ProducedObject {
  const slug = repositorySlug(repository);
  const title = `${review.author} ${review.state.toLowerCase()} ${slug}#${number}`;
  return {
    kind: "review",
    externalId: reviewExternalId(repository, number, review.id),
    title,
    renderings: {
      card: `${review.author}: ${review.state}`,
      summary: `${title}${review.submittedAt === "" ? "" : ` on ${review.submittedAt}`}`,
      agentContent: [
        `# ${title}`,
        "",
        `State: ${review.state}`,
        `Submitted: ${review.submittedAt}`,
        `Link: ${review.url}`,
        "",
        review.body,
        ...review.comments.map(
          (comment) => `\n## ${comment.path}\n${comment.body}`,
        ),
      ].join("\n"),
    },
  };
}

export interface IssueRead {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly author: string;
  readonly assignees: readonly string[];
  readonly labels: readonly string[];
  readonly url: string;
  readonly body: string;
  /** GitHub's issue list includes pull requests; a ticket is not one of those. */
  readonly isPullRequest: boolean;
}

export function readIssue(payload: unknown): IssueRead | null {
  const raw = record(payload);
  if (raw === null) {
    return null;
  }
  const number = integer(raw["number"]);
  if (number === null) {
    return null;
  }
  return {
    number,
    title: text(raw["title"]),
    state: text(raw["state"]),
    author: login(raw["user"]),
    assignees: Array.isArray(raw["assignees"])
      ? raw["assignees"].map(login).filter((name) => name !== "")
      : [],
    labels: Array.isArray(raw["labels"])
      ? raw["labels"]
          .map((label) => {
            const one = record(label);
            return one === null ? text(label) : text(one["name"]);
          })
          .filter((name) => name !== "")
      : [],
    url: text(raw["html_url"]),
    body: text(raw["body"]),
    isPullRequest: record(raw["pull_request"]) !== null,
  };
}

/** An issue as a **ticket** (§3.1, §9.4) — the concept, not a GitHub-shaped one. */
export function ticketObject(
  repository: RepositoryRef,
  issue: IssueRead,
): ProducedObject {
  const slug = repositorySlug(repository);
  const title = `${slug}#${issue.number} ${issue.title}`;
  return {
    kind: "ticket",
    externalId: ticketExternalId(repository, issue.number),
    title,
    renderings: {
      card: `#${issue.number} ${issue.title} — ${issue.state}`,
      summary: `${title} — ${issue.state}${
        issue.assignees.length === 0
          ? ", unassigned"
          : `, assigned to ${issue.assignees.join(", ")}`
      }`,
      agentContent: [
        `# ${title}`,
        "",
        `Status: ${issue.state}`,
        `Type: issue`,
        `Reporter: ${issue.author}`,
        `Assignees: ${issue.assignees.length === 0 ? "none" : issue.assignees.join(", ")}`,
        issue.labels.length === 0 ? null : `Labels: ${issue.labels.join(", ")}`,
        `Link: ${issue.url}`,
        "",
        issue.body,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    },
  };
}

export interface RepositoryRead {
  readonly slug: string;
  readonly description: string;
  readonly defaultBranch: string;
  readonly url: string;
  readonly cloneUrl: string | null;
  readonly sshUrl: string | null;
  readonly language: string;
  readonly topics: readonly string[];
  readonly openIssues: number | null;
  readonly archived: boolean;
  readonly visibility: string;
}

export function readRepository(payload: unknown): RepositoryRead | null {
  const raw = record(payload);
  if (raw === null) {
    return null;
  }
  const slug = text(raw["full_name"]);
  if (slug === "") {
    return null;
  }
  return {
    slug,
    description: text(raw["description"]),
    defaultBranch: text(raw["default_branch"]),
    url: text(raw["html_url"]),
    cloneUrl: text(raw["clone_url"]) || null,
    sshUrl: text(raw["ssh_url"]) || null,
    language: text(raw["language"]),
    topics: Array.isArray(raw["topics"])
      ? raw["topics"].map(text).filter((topic) => topic !== "")
      : [],
    openIssues: integer(raw["open_issues_count"]),
    archived: raw["archived"] === true,
    visibility: text(raw["visibility"]),
  };
}

/** Repository metadata as a **document** (§3.1: "a durable piece of prose"). */
export function repositoryObject(
  repository: RepositoryRef,
  read: RepositoryRead,
): ProducedObject {
  return {
    kind: "document",
    externalId: repositoryExternalId(repository),
    title: read.slug,
    renderings: {
      card: `${read.slug}${read.language === "" ? "" : ` · ${read.language}`}`,
      summary: `${read.slug} — ${read.description === "" ? "no description" : read.description}`,
      agentContent: [
        `# ${read.slug}`,
        "",
        read.description,
        "",
        `Default branch: ${read.defaultBranch}`,
        `Visibility: ${read.visibility}${read.archived ? " (archived)" : ""}`,
        read.language === "" ? null : `Primary language: ${read.language}`,
        read.topics.length === 0 ? null : `Topics: ${read.topics.join(", ")}`,
        read.openIssues === null ? null : `Open issues: ${read.openIssues}`,
        `Link: ${read.url}`,
        read.cloneUrl === null ? null : `Clone (https): ${read.cloneUrl}`,
        read.sshUrl === null ? null : `Clone (ssh): ${read.sshUrl}`,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    },
  };
}

export interface CheckRunRead {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

export function readCheckRuns(payload: unknown): readonly CheckRunRead[] {
  const raw = record(payload);
  const runs = raw === null ? null : raw["check_runs"];
  if (!Array.isArray(runs)) {
    return [];
  }
  const read: CheckRunRead[] = [];
  for (const entry of runs) {
    const one = record(entry);
    if (one === null) {
      continue;
    }
    read.push({
      name: text(one["name"]),
      status: text(one["status"]),
      conclusion:
        typeof one["conclusion"] === "string" ? one["conclusion"] : null,
    });
  }
  return read;
}

export function readList(payload: unknown): readonly unknown[] {
  return Array.isArray(payload) ? payload : [];
}
