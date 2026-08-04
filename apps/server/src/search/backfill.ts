import type { ApiStores } from "../routes/api.js";
import { reindexSessionSearch } from "./session-index.js";

export interface SearchBackfillResult {
  readonly total: number;
  readonly reindexed: number;
}

/**
 * Every session that existed before search indexing did (§6.8): "search
 * spans every session, including archived ones" is false the moment one
 * exists this build never wrote into the index — which is every session
 * from before this feature landed, since `reindexSessionSearch` only ever
 * fires at start, checkpoint, and end (never retroactively).
 *
 * A read/derivation, so principle 2 permits running it on its own — nothing
 * here is a gesture, and it starts no work: it re-derives an index entry from
 * a session record that already exists, exactly what `reindexSessionSearch`
 * already does at the ordinary boundaries. Idempotent by construction:
 * whatever a previous boot (or this same one, called twice) already indexed is
 * skipped, so running it zero, one, or a hundred times leaves the index in
 * exactly the same state either way.
 *
 * What is already covered is read **once**, not asked per session:
 * `search` is an FTS5 virtual table, so a `ref_kind`/`ref_id` lookup with no
 * `MATCH` scans the whole index — one `has` per session made an every-boot
 * sweep quadratic in sessions, which at a few thousand archived sessions is
 * the boot the operator notices. `indexedRefIds` is the same question asked
 * once.
 */
export function backfillSearchIndex(stores: ApiStores): SearchBackfillResult {
  const sessions = stores.sessions.list();
  const indexed = stores.search.indexedRefIds("session");

  let reindexed = 0;
  for (const stored of sessions) {
    if (indexed.has(stored.session.id)) continue;
    reindexSessionSearch(stores, stored.session.id);
    reindexed += 1;
  }

  return { total: sessions.length, reindexed };
}
