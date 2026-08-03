/**
 * Condition checks: GitHub's half of "completion is proof, not a claim" (§10.1,
 * principle 3, §4.3).
 *
 * The native registry ships only workspace checks, and says why: "a check that needs
 * GitHub belongs to the GitHub plugin". These are those two — `pull_request_exists`
 * and `checks_green` — and the interesting answer is the third state:
 *
 * - **`unknown` is not `unmet`.** A repository the token cannot read, or a commit
 *   with **no checks configured at all**, has not disproved anything. Reporting
 *   either as unmet would make a missing connection read as failed work; reporting
 *   them as met would let a repository without CI claim green.
 */
import type {
  ConditionCheck,
  ConditionResult,
  ToolInputSchema,
} from "@plotroom/plugin-sdk";

import {
  readCheckRuns,
  readList,
  readPullRequest,
  repositorySlug,
} from "./model.js";
import { parseRepository } from "./scope.js";
import { GitHubApi, type HttpTransport } from "./transport.js";

export const PULL_REQUEST_EXISTS_CHECK = "github_pull_request_exists";
export const CHECKS_GREEN_CHECK = "github_checks_green";

const repositoryField = {
  type: "string" as const,
  required: true,
  description: "the repository, as owner/name",
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

export function pullRequestExistsCheck(
  transport: HttpTransport,
  permissions: readonly string[],
): ConditionCheck {
  const input: ToolInputSchema = {
    repository: repositoryField,
    branch: {
      type: "string",
      required: true,
      description: "the head branch the pull request should be open from",
    },
  };
  return {
    id: PULL_REQUEST_EXISTS_CHECK,
    summary: "an open pull request exists from a named branch",
    input,
    permissions,
    async check(raw: unknown, context): Promise<ConditionResult> {
      const repositoryName = stringOf(raw, "repository");
      const repository =
        repositoryName === null ? null : parseRepository(repositoryName);
      const branch = stringOf(raw, "branch");
      if (repository === null || branch === null) {
        return unknown(
          "this condition needs a repository (owner/name) and a branch, so nothing was checked — which is not proof",
        );
      }
      const connection = GitHubApi.connect(transport, context.credentials);
      if (!connection.connected) {
        return unknown(connection.why);
      }
      const slug = repositorySlug(repository);
      const list = await connection.api.get(
        `/repos/${slug}/pulls?state=open&head=${repository.owner}:${branch}&per_page=10`,
      );
      if (!list.ok) {
        return unknown(list.message);
      }
      const pulls = readList(list.value)
        .map(readPullRequest)
        .filter((pull): pull is NonNullable<typeof pull> => pull !== null);
      if (pulls.length === 0) {
        return {
          state: "unmet",
          evidence: `GitHub reports no open pull request from ${slug}:${branch}`,
        };
      }
      return {
        state: "met",
        evidence: `GitHub reports ${pulls
          .map(
            (pull) =>
              `${slug}#${pull.number} (${pull.headRef} → ${pull.baseRef})`,
          )
          .join(", ")}`,
      };
    },
  };
}

export function checksGreenCheck(
  transport: HttpTransport,
  permissions: readonly string[],
): ConditionCheck {
  const input: ToolInputSchema = {
    repository: repositoryField,
    ref: {
      type: "string",
      required: true,
      description:
        "the commit, branch or tag whose checks are being asked about",
    },
  };
  return {
    id: CHECKS_GREEN_CHECK,
    summary: "every check run on a commit concluded successfully",
    input,
    permissions,
    async check(raw: unknown, context): Promise<ConditionResult> {
      const repositoryName = stringOf(raw, "repository");
      const repository =
        repositoryName === null ? null : parseRepository(repositoryName);
      const ref = stringOf(raw, "ref");
      if (repository === null || ref === null) {
        return unknown(
          "this condition needs a repository (owner/name) and a ref, so nothing was checked — which is not proof",
        );
      }
      const connection = GitHubApi.connect(transport, context.credentials);
      if (!connection.connected) {
        return unknown(connection.why);
      }
      const slug = repositorySlug(repository);
      const answer = await connection.api.get(
        `/repos/${slug}/commits/${ref}/check-runs?per_page=100`,
      );
      if (!answer.ok) {
        return unknown(answer.message);
      }
      const runs = readCheckRuns(answer.value);
      if (runs.length === 0) {
        // No checks at all is not a pass: nothing observed it.
        return unknown(
          `GitHub reports no check runs on ${slug}@${ref}; nothing has checked this commit, which is not proof`,
        );
      }
      const pending = runs.filter((run) => run.status !== "completed");
      if (pending.length > 0) {
        return unknown(
          `${pending.length} of ${runs.length} check runs on ${slug}@${ref} are still running: ${pending
            .map((run) => run.name)
            .join(", ")}`,
        );
      }
      const failed = runs.filter(
        (run) =>
          run.conclusion !== "success" &&
          run.conclusion !== "neutral" &&
          run.conclusion !== "skipped",
      );
      if (failed.length > 0) {
        return {
          state: "unmet",
          evidence: `${failed.length} of ${runs.length} check runs on ${slug}@${ref} did not pass: ${failed
            .map((run) => `${run.name} (${run.conclusion ?? "no conclusion"})`)
            .join(", ")}`,
        };
      }
      return {
        state: "met",
        evidence: `all ${runs.length} check runs on ${slug}@${ref} concluded successfully: ${runs
          .map((run) => run.name)
          .join(", ")}`,
      };
    },
  };
}
