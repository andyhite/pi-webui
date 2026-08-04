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
