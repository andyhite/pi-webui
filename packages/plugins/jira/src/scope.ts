/**
 * Scoping, in Jira's own query language (§9.1).
 *
 * "Scoping is per integration and configurable at runtime — which tickets, which
 * repositories, expressed in the source's own query language and changeable without a
 * restart, because the right query is discovered by trying queries."
 *
 * Jira's own query language is **JQL**, so a scope here _is_ JQL and is handed to Jira
 * verbatim: `project = OXY AND statusCategory != Done ORDER BY created DESC`. This
 * module parses nothing inside it and validates nothing about it — JQL is Jira's
 * grammar, and a plugin that re-implemented a subset of it would refuse queries Jira
 * accepts. An unparseable **scope** is refused with what it should have said; an
 * invalid **query** is refused by Jira, in Jira's own words (§9.2).
 *
 * ## The two directives in front of the JQL, and why they exist
 *
 * A scope reads `site=acme.atlassian.net [limit=50] <JQL>`:
 *
 * - **`site=`** is required, because contract v1 gives a plugin no per-connection
 *   configuration channel at all (`PluginCallContext` is credentials plus a log
 *   function), and the site must not travel as a credential — the host redacts every
 *   injected credential value out of results, so the site would redact itself out of
 *   every issue link. Same workaround the git port used for its checkout path, and
 *   recorded as the same contract finding.
 * - **`limit=`** is optional, because Jira's page size is a search parameter rather
 *   than part of JQL, so there is nowhere inside the query to say it.
 *
 * Both are anchored at the front and matched with an anchored pattern, so everything
 * after them is JQL, whitespace and all. A scope that omits `site=` is refused rather
 * than guessed at: there is no default Jira site, and inventing one would send a
 * query to somebody else's tenant.
 */

export const JIRA_SCOPE_LANGUAGE = "jql";
export const JIRA_SCOPE_EXAMPLE =
  "site=acme.atlassian.net project = OXY AND statusCategory != Done";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface JiraScope {
  /** The Jira Cloud site, host only: `acme.atlassian.net`. */
  readonly site: string;
  /** Jira's own query language, verbatim and unvalidated (§9.1). */
  readonly jql: string;
  readonly limit: number;
}

export type ScopeParse =
  | { readonly ok: true; readonly scope: JiraScope }
  | { readonly ok: false; readonly why: string };

const SCOPE = /^site=(\S+?)(?:\s+limit=(\d+))?\s+([\s\S]+)$/u;

/** A Jira Cloud site host. Deliberately strict: this becomes a request's origin. */
const SITE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u;

export function parseJiraScope(scope: string | null): ScopeParse {
  if (scope === null || scope.trim() === "") {
    return {
      ok: false,
      why: `this producer needs a scope naming a site and a JQL query, e.g. "${JIRA_SCOPE_EXAMPLE}"`,
    };
  }
  const match = SCOPE.exec(scope.trim());
  if (match === null) {
    return {
      ok: false,
      why: `a scope is "site=<host> [limit=<n>] <JQL>", e.g. "${JIRA_SCOPE_EXAMPLE}"; there is no default Jira site to fall back to`,
    };
  }
  const site = match[1] as string;
  if (!SITE.test(site)) {
    return { ok: false, why: `"${site}" is not a Jira site host` };
  }
  const declaredLimit = match[2];
  const limit =
    declaredLimit === undefined
      ? DEFAULT_PAGE_SIZE
      : Math.min(Number.parseInt(declaredLimit, 10), MAX_PAGE_SIZE);
  if (limit <= 0) {
    return { ok: false, why: `limit must be a positive integer, not "0"` };
  }
  const jql = (match[3] as string).trim();
  if (jql === "") {
    return {
      ok: false,
      why: `the scope names a site but no query; JQL is what says which issues, e.g. "${JIRA_SCOPE_EXAMPLE}"`,
    };
  }
  return { ok: true, scope: { site, jql, limit } };
}

/** A Jira issue key: `OXY-2982`. Identity in the source system (§3.1). */
export const ISSUE_KEY = /^[A-Z][A-Z0-9]*-\d+$/u;

export function isIssueKey(value: string): boolean {
  return ISSUE_KEY.test(value);
}

export interface ExternalTarget {
  readonly site: string;
  readonly key: string;
  /** Which of this plugin's kinds the id addresses, so a refresh reads the same thing. */
  readonly kind: "ticket" | "collection" | "document";
}

/**
 * The external ids this plugin mints, read back.
 *
 * A per-object refresh arrives as one of these (§9.1) and carries the site, which is
 * why an id names it: identity is Jira's own — `acme.atlassian.net/OXY-1` names the
 * same issue tomorrow, which is what makes a re-read reconcile (§3.1) — and a refresh
 * with no scope beside it would otherwise have no site to ask.
 */
export function parseExternalId(externalId: string): ExternalTarget | null {
  const match =
    /^jira:(ticket|collection|document):([A-Za-z0-9.-]+)\/([A-Z][A-Z0-9]*-\d+)$/u.exec(
      externalId,
    );
  if (match === null) {
    return null;
  }
  const site = match[2] as string;
  if (!SITE.test(site)) {
    return null;
  }
  return {
    site,
    key: match[3] as string,
    kind: match[1] as ExternalTarget["kind"],
  };
}
