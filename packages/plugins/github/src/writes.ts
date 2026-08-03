/**
 * Write actions, each declaring its own reversibility (§9.2, §6.6).
 *
 * "Write-back is a normal capability, not an exception. Any integration may offer
 * writes; each is available both as a UI action and as an agent tool (principle 8,
 * subject to approvals), and **each declares whether it is reversible**."
 *
 * Four writes, and the declarations are the load-bearing part — they drive §6.6's
 * irreversibility approvals and §6.3's outside-world markers:
 *
 * | Action           | Reversibility  | Why                                                              |
 * | ---------------- | -------------- | ---------------------------------------------------------------- |
 * | `comment`        | reversible     | a comment can be deleted, and deleting it restores the prior state |
 * | `request-review` | reversible     | a review request can be withdrawn                                 |
 * | `close-issue`    | reversible     | a closed issue reopens                                            |
 * | `merge`          | irreversible   | the commits are in the base branch and other work builds on them  |
 *
 * `merge` is `irreversible` rather than `unknown`, because it is knowable — and
 * `unknown` would be treated as irreversible anyway (principle 7), which would hide
 * a fact the author has.
 *
 * **Every result is read back, never assumed** (§9.2): each `perform` re-reads the
 * object afterwards and returns what GitHub says it now is, including a rejection's
 * own error text. External systems have automation; the state you asked for is not
 * reliably the state you get.
 */
import type {
  PluginCallContext,
  ProducedObject,
  ToolInputSchema,
  WriteAction,
  WriteResult,
} from "@plotroom/plugin-sdk";

import {
  pullRequestObject,
  readIssue,
  readPullRequest,
  repositorySlug,
  ticketObject,
  type RepositoryRef,
} from "./model.js";
import { parseRepository } from "./scope.js";
import { GitHubApi, type ApiResult, type HttpTransport } from "./transport.js";

export const COMMENT_ACTION = "comment";
export const REQUEST_REVIEW_ACTION = "request-review";
export const CLOSE_ISSUE_ACTION = "close-issue";
export const MERGE_ACTION = "merge";

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

interface WriteTarget {
  readonly repository: RepositoryRef;
  readonly number: number;
  readonly api: GitHubApi;
}

type TargetResolution =
  | { readonly ok: true; readonly target: WriteTarget }
  | { readonly ok: false; readonly result: WriteResult };

const refused = (message: string): WriteResult => ({
  ok: false,
  message,
  readBack: null,
});

function resolveTarget(
  transport: HttpTransport,
  input: unknown,
  context: PluginCallContext,
): TargetResolution {
  const raw =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const repository =
    typeof raw["repository"] === "string"
      ? parseRepository(raw["repository"])
      : null;
  if (repository === null) {
    return {
      ok: false,
      result: refused("this action needs a repository, as owner/name"),
    };
  }
  const number =
    typeof raw["number"] === "number" && Number.isInteger(raw["number"])
      ? raw["number"]
      : null;
  if (number === null) {
    return {
      ok: false,
      result: refused("this action needs the pull request or issue number"),
    };
  }
  const connection = GitHubApi.connect(transport, context.credentials);
  if (!connection.connected) {
    return { ok: false, result: refused(connection.why) };
  }
  return { ok: true, target: { repository, number, api: connection.api } };
}

const stringOf = (input: unknown, name: string): string | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const value = (input as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() !== "" ? value : null;
};

const stringsOf = (input: unknown, name: string): readonly string[] => {
  if (typeof input !== "object" || input === null) {
    return [];
  }
  const value = (input as Record<string, unknown>)[name];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
};

/** Re-read the pull request, so what is returned is what GitHub now says (§9.2). */
async function readBackPullRequest(
  target: WriteTarget,
): Promise<ProducedObject | null> {
  const slug = repositorySlug(target.repository);
  const again = await target.api.get(`/repos/${slug}/pulls/${target.number}`);
  if (!again.ok) {
    return null;
  }
  const pull = readPullRequest(again.value);
  return pull === null ? null : pullRequestObject(target.repository, pull);
}

async function readBackIssue(
  target: WriteTarget,
): Promise<ProducedObject | null> {
  const slug = repositorySlug(target.repository);
  const again = await target.api.get(`/repos/${slug}/issues/${target.number}`);
  if (!again.ok) {
    return null;
  }
  const issue = readIssue(again.value);
  return issue === null ? null : ticketObject(target.repository, issue);
}

const failureOf = (outcome: ApiResult<unknown>): WriteResult =>
  outcome.ok
    ? refused("unreachable")
    : // GitHub's own text on a rejection, unedited (§9.2).
      refused(outcome.message);

export function createGitHubWriteActions(
  transport: HttpTransport,
  permissions: readonly string[],
): readonly WriteAction[] {
  const commentInput: ToolInputSchema = {
    repository: repositoryField,
    number: numberField,
    body: {
      type: "string",
      required: true,
      description: "the comment's markdown body",
    },
  };

  return [
    {
      id: COMMENT_ACTION,
      action: "comment",
      system: "github",
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
        const slug = repositorySlug(resolved.target.repository);
        const posted = await resolved.target.api.post(
          `/repos/${slug}/issues/${resolved.target.number}/comments`,
          { body },
        );
        if (!posted.ok) {
          return failureOf(posted);
        }
        return {
          ok: true,
          message: `commented on ${slug}#${resolved.target.number}`,
          readBack: await readBackIssue(resolved.target),
        };
      },
    },
    {
      id: REQUEST_REVIEW_ACTION,
      action: "request-review",
      system: "github",
      reversibility: "reversible",
      input: {
        repository: repositoryField,
        number: numberField,
        reviewers: {
          type: "string[]",
          required: true,
          description: "the GitHub logins to request a review from",
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
        const reviewers = stringsOf(input, "reviewers");
        if (reviewers.length === 0) {
          return refused("requesting a review needs at least one reviewer");
        }
        const slug = repositorySlug(resolved.target.repository);
        const requested = await resolved.target.api.post(
          `/repos/${slug}/pulls/${resolved.target.number}/requested_reviewers`,
          { reviewers },
        );
        if (!requested.ok) {
          return failureOf(requested);
        }
        return {
          ok: true,
          message: `requested review from ${reviewers.join(", ")} on ${slug}#${resolved.target.number}`,
          readBack: await readBackPullRequest(resolved.target),
        };
      },
    },
    {
      id: CLOSE_ISSUE_ACTION,
      action: "transition",
      system: "github",
      reversibility: "reversible",
      input: {
        repository: repositoryField,
        number: numberField,
        state: {
          type: "string",
          required: true,
          description: 'the state to move the issue to: "open" or "closed"',
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
        const state = stringOf(input, "state");
        if (state !== "open" && state !== "closed") {
          return refused('this action moves an issue to "open" or "closed"');
        }
        const slug = repositorySlug(resolved.target.repository);
        const patched = await resolved.target.api.patch(
          `/repos/${slug}/issues/${resolved.target.number}`,
          { state },
        );
        if (!patched.ok) {
          return failureOf(patched);
        }
        // Read back rather than assume: GitHub's own automation may have moved it
        // somewhere else entirely (§9.2).
        const readBack = await readBackIssue(resolved.target);
        return {
          ok: true,
          message: `asked GitHub to move ${slug}#${resolved.target.number} to ${state}`,
          readBack,
        };
      },
    },
    {
      id: MERGE_ACTION,
      action: "merge",
      system: "github",
      // The commits land in the base branch and other work builds on them; §6.6
      // treats this as irreversible and asks before it happens.
      reversibility: "irreversible",
      input: {
        repository: repositoryField,
        number: numberField,
        method: {
          type: "string",
          required: false,
          description: "merge, squash or rebase; GitHub's default when absent",
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
        const method = stringOf(input, "method");
        if (
          method !== null &&
          method !== "merge" &&
          method !== "squash" &&
          method !== "rebase"
        ) {
          return refused(
            `"${method}" is not a merge method; use merge, squash or rebase`,
          );
        }
        const slug = repositorySlug(resolved.target.repository);
        const merged = await resolved.target.api.put(
          `/repos/${slug}/pulls/${resolved.target.number}/merge`,
          method === null ? {} : { merge_method: method },
        );
        if (!merged.ok) {
          return failureOf(merged);
        }
        return {
          ok: true,
          message: `merged ${slug}#${resolved.target.number}`,
          readBack: await readBackPullRequest(resolved.target),
        };
      },
    },
  ];
}
