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
 * Always `/api/search` — a fixed, same-origin literal — with every dynamic
 * part carried as a `URLSearchParams` value, never concatenated into the
 * path or the host: exactly the shape `HttpClient`'s own contract requires
 * (`transport/http.ts`'s "never a full URL"), so there is nothing here for a
 * caller-supplied query string to redirect.
 *
 * `q` travels as the operator typed it. It used to be re-quoted here as an
 * FTS5 phrase before the route's own sanitization existed at the source
 * (`toLiteralFtsQuery` in `packages/db/src/search.ts`) — the same rule
 * stated twice is exactly the drift principle 8 exists to prevent (#68), and
 * the route is every caller's gate (curl, this client, agents later), so it
 * is the one place that has to get FTS5's grammar right.
 */
export function createApiSearchDataSource(
  options: ApiSearchDataSourceOptions,
): SearchDataSource {
  const { http } = options;
  return {
    search(query: SearchQuery): Promise<SearchResult> {
      const q = query.q.trim();
      if (q.length === 0) {
        // No request was made, so no bound was applied: nothing was asked for
        // and nothing was withheld. `limit: 0` states that rather than
        // guessing at the server's default, which lives in `@plotroom/db`.
        return Promise.resolve({
          query: q,
          hits: [],
          limit: 0,
          truncated: false,
        });
      }
      const params = new URLSearchParams();
      params.set("q", q);
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
      return Promise.resolve(
        resultsByQuery.get(q) ?? {
          query: q,
          hits: [],
          limit: 0,
          truncated: false,
        },
      );
    },
  };
}
