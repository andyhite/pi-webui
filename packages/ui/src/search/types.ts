/**
 * Search (§6.8, Epic 8.2): "search spans every session, including archived
 * ones, ranked over title, location, and content; archived sessions are
 * reported as archived rather than hidden, because finding them is the
 * point." This is the operator's browse surface for what is not on canvas
 * (archive-by-default, §3.3) — the shape mirrors `GET /api/search`
 * (`apps/server/src/routes/search.ts`) field for field, so a Search panel
 * renders the response without reshaping it.
 */

export interface SearchHit {
  readonly kind: string;
  readonly refKind: string;
  readonly refId: string;
  readonly title: string;
  readonly location: string;
  readonly snippet: string;
  readonly rank: number;
  /**
   * Resolved fresh by the server, per hit, from the referenced entity's own
   * workstream (§6.8) — never hidden here either: a hit stays in the list
   * and this flag says so.
   */
  readonly archived: boolean;
}

export interface SearchResult {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  /**
   * The bound the server applied to *this* answer — the caller's, clamped, or
   * the index's own default when none was asked for. Rendered rather than
   * assumed: the default lives in `@plotroom/db`, and a renderer holding a copy
   * of it would be a second source of truth for the same number.
   *
   * A data source that answered without a request (an empty query, an
   * unregistered fixture) applied no bound and reports `0`. Nothing renders it:
   * `limit` is only ever read beside a `truncated` that is true, and those
   * answers are complete by construction.
   */
  readonly limit: number;
  /**
   * True when the index held at least one more hit than `limit`. Observed by
   * the server (which asks for one hit past the bound), and not inferrable
   * here: `hits.length === limit` is also true of a query whose last hit is
   * its last. A result that did not carry this could only be rendered as if
   * it were complete — the silent truncation §6.8 and AGENTS.md refuse.
   */
  readonly truncated: boolean;
}

export interface SearchQuery {
  readonly q: string;
  readonly kinds?: readonly string[];
  readonly limit?: number;
}

export interface SearchDataSource {
  /** Empty `q` resolves to no hits without a request — there is nothing to rank. */
  search(query: SearchQuery): Promise<SearchResult>;
}
