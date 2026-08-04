/**
 * `SearchDataSource` (§6.8, Epic 8.2). `createApiSearchDataSource` is live
 * over `GET /api/search` — operator-only server-side (a session actor gets
 * 403), which the renderer never has to enforce itself: the browser's own
 * calls carry no `X-PlotRoom-Actor` header, so they are the human operator
 * by the header's own default (`apps/server/src/http/actor.ts`).
 */

import type { HttpClient } from "../transport/http.js";
import type { SearchDataSource, SearchQuery, SearchResult } from "./types.js";

export interface ApiSearchDataSourceOptions {
  readonly http: HttpClient;
}

/**
 * `GET /api/search` passes `q` straight into an FTS5 `MATCH` expression
 * (`packages/db/src/search.ts`) — that is FTS5's own *query grammar*, not a
 * plain full-text term: an unquoted `-` is its NOT-operator and `:` starts
 * a column filter, so an ordinary hyphenated word (a ticket id, a branch
 * name) either changes what the query means or, for some inputs, raises a
 * raw SQLite error the route surfaces as a 500. Nothing in §6.8 asks an
 * operator typing a search box to know FTS5's grammar, so every word this
 * client sends is wrapped as its own quoted phrase (`"word"`, embedded
 * quotes doubled per FTS5's own escaping rule) — literal text, adjacent
 * quoted phrases still AND together exactly like bare terms would, and a
 * hyphen or colon inside one is just a character again.
 */
function toFts5MatchQuery(q: string): string {
  return q
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => `"${word.replace(/"/g, '""')}"`)
    .join(" ");
}

/**
 * Always `/api/search` — a fixed, same-origin literal — with every dynamic
 * part carried as a `URLSearchParams` value, never concatenated into the
 * path or the host: exactly the shape `HttpClient`'s own contract requires
 * (`transport/http.ts`'s "never a full URL"), so there is nothing here for a
 * caller-supplied query string to redirect.
 */
export function createApiSearchDataSource(
  options: ApiSearchDataSourceOptions,
): SearchDataSource {
  const { http } = options;
  return {
    search(query: SearchQuery): Promise<SearchResult> {
      const q = query.q.trim();
      if (q.length === 0) {
        return Promise.resolve({ query: q, hits: [] });
      }
      const params = new URLSearchParams();
      params.set("q", toFts5MatchQuery(q));
      if (query.kinds && query.kinds.length > 0) {
        params.set("kinds", query.kinds.join(","));
      }
      if (query.limit !== undefined) {
        params.set("limit", String(query.limit));
      }
      return http
        .get<SearchResult>(`/api/search?${params.toString()}`)
        .then((result) => ({ ...result, query: q }));
    },
  };
}

/** Fixtures/tests/dev-offline: behind the identical interface, no request made. */
export function createFixtureSearchDataSource(
  resultsByQuery: ReadonlyMap<string, SearchResult>,
): SearchDataSource {
  return {
    search(query: SearchQuery): Promise<SearchResult> {
      const q = query.q.trim();
      return Promise.resolve(resultsByQuery.get(q) ?? { query: q, hits: [] });
    },
  };
}
