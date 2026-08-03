/**
 * Scoping, in GitHub's own query vocabulary (§9.1).
 *
 * "Scoping is per integration and configurable at runtime — which tickets, which
 * repositories, expressed in the source's own query language and changeable without
 * a restart, because the right query is discovered by trying queries."
 *
 * So a scope here reads like a GitHub search: `repo:acme/app state:open`. It is
 * parsed rather than passed through, because an unparseable scope must be **refused
 * with what it should have said** instead of quietly returning everything or nothing.
 */
import type { RepositoryRef } from "./model.js";

export const GITHUB_SCOPE_LANGUAGE = "gh-search";
export const GITHUB_SCOPE_EXAMPLE = "repo:acme/app state:open";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface GitHubScope {
  readonly repository: RepositoryRef;
  readonly state: "open" | "closed" | "all";
  readonly limit: number;
}

export type ScopeParse =
  | { readonly ok: true; readonly scope: GitHubScope }
  | { readonly ok: false; readonly why: string };

export function parseGitHubScope(scope: string | null): ScopeParse {
  if (scope === null || scope.trim() === "") {
    return {
      ok: false,
      why: `this producer needs a scope naming a repository, e.g. "${GITHUB_SCOPE_EXAMPLE}"`,
    };
  }
  let repository: RepositoryRef | null = null;
  let state: GitHubScope["state"] = "open";
  let limit = DEFAULT_PAGE_SIZE;

  for (const token of scope.trim().split(/\s+/u)) {
    const separator = token.indexOf(":");
    const key = separator === -1 ? "repo" : token.slice(0, separator);
    const value = separator === -1 ? token : token.slice(separator + 1);

    if (key === "repo") {
      const parsed = parseRepository(value);
      if (parsed === null) {
        return {
          ok: false,
          why: `"${value}" is not an owner/name repository`,
        };
      }
      repository = parsed;
      continue;
    }
    if (key === "state") {
      if (value !== "open" && value !== "closed" && value !== "all") {
        return {
          ok: false,
          why: `state must be open, closed or all, not "${value}"`,
        };
      }
      state = value;
      continue;
    }
    if (key === "limit") {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return {
          ok: false,
          why: `limit must be a positive integer, not "${value}"`,
        };
      }
      limit = Math.min(parsed, MAX_PAGE_SIZE);
      continue;
    }
    return {
      ok: false,
      why: `unknown scope key "${key}"; this producer reads "${GITHUB_SCOPE_EXAMPLE}"`,
    };
  }

  if (repository === null) {
    return {
      ok: false,
      why: `this producer needs a repository in its scope, e.g. "${GITHUB_SCOPE_EXAMPLE}"`,
    };
  }
  return { ok: true, scope: { repository, state, limit } };
}

export function parseRepository(value: string): RepositoryRef | null {
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/u.exec(value.trim());
  if (match === null) {
    return null;
  }
  return { owner: match[1] as string, name: match[2] as string };
}

export interface ExternalTarget {
  readonly repository: RepositoryRef;
  readonly number: number | null;
  readonly reviewId: number | null;
}

/**
 * The external ids this plugin mints, read back. A per-object refresh arrives as one
 * of these (§9.1), and identity is the source's own — `acme/app#12` names the same
 * pull request tomorrow, which is what makes a re-read reconcile (§3.1).
 */
export function parseExternalId(externalId: string): ExternalTarget | null {
  const match =
    /^github:(?:pull_request|review|ticket|document):([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)(?:#(\d+))?(?::(\d+))?$/u.exec(
      externalId,
    );
  if (match === null) {
    return null;
  }
  const repository = parseRepository(match[1] as string);
  if (repository === null) {
    return null;
  }
  const number = match[2] === undefined ? null : Number.parseInt(match[2], 10);
  const reviewId =
    match[3] === undefined ? null : Number.parseInt(match[3], 10);
  return { repository, number, reviewId };
}
