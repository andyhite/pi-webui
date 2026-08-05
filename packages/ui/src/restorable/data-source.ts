/**
 * `RestorableDataSource` (issue #65, §5, principle 10). `createApiRestorableDataSource`
 * is live over `GET /api/restorable`; the response travels through untouched
 * (`data-source.test.ts` defends this the same way `search/data-source.ts` does).
 */

import type { HttpClient } from "../transport/http.js";
import type { RestorableDataSource, RestorableSummary } from "./types.js";

export interface ApiRestorableDataSourceOptions {
  readonly http: HttpClient;
}

export function createApiRestorableDataSource(
  options: ApiRestorableDataSourceOptions,
): RestorableDataSource {
  const { http } = options;
  return {
    load(): Promise<RestorableSummary> {
      return http.get<RestorableSummary>("/api/restorable");
    },
  };
}

/** Fixtures/tests/dev-offline: behind the identical interface, no request made. */
export function createFixtureRestorableDataSource(
  summary: RestorableSummary,
): RestorableDataSource {
  return {
    load(): Promise<RestorableSummary> {
      return Promise.resolve(summary);
    },
  };
}

/** Empty by construction — the fixture default when nothing is deleted. */
export const EMPTY_RESTORABLE_SUMMARY: RestorableSummary = {
  objects: [],
  nodes: [],
  edges: [],
  workstreams: [],
  commands: [],
  commandDefinitions: [],
  sessions: [],
};
