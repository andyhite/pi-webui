import { Hono } from "hono";
import { badRequest } from "../http/errors.js";
import type { ApiEnv, ApiStores } from "./api.js";

/**
 * FTS search (§6.8).
 *
 * "Search spans every session, including archived ones, ranked over title,
 * location, and content; archived sessions are reported as archived rather
 * than hidden, because finding them is the point." The index (`stores.search`)
 * only ever knows what was written into it at the moments listed in
 * `search/session-index.ts`; "archived" is never one of those writes — it is
 * resolved fresh, per hit, from the session's own workstream record, so a
 * workstream archived a minute ago is never reported as if it still weren't.
 *
 * Only the `session` kind is populated as of this batch (Epic 8.2): sessions
 * and their transcripts. The index itself is kind-agnostic — a future
 * producer can write `note`, `ticket`, or any other kind into the same table
 * without a new endpoint, which is why `kinds` is already a filter here
 * rather than assumed to be `["session"]`.
 */
export function searchRoutes(stores: ApiStores): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get("/search", (c) => {
    const q = c.req.query("q")?.trim() ?? "";
    if (q.length === 0) {
      throw badRequest("q is required and must be non-empty");
    }

    const kindsParam = c.req.query("kinds");
    const kinds = kindsParam
      ? kindsParam
          .split(",")
          .map((kind) => kind.trim())
          .filter((kind) => kind.length > 0)
      : undefined;

    const limitParam = c.req.query("limit");
    const limit =
      limitParam !== undefined && Number.isFinite(Number(limitParam))
        ? Math.max(1, Math.min(100, Number(limitParam)))
        : undefined;

    const hits = stores.search.query(q, {
      ...(kinds ? { kinds } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });

    return c.json({
      query: q,
      hits: hits.map((hit) => ({
        kind: hit.kind,
        refKind: hit.refKind,
        refId: hit.refId,
        title: hit.title,
        location: hit.location,
        snippet: hit.snippet,
        rank: hit.rank,
        archived: resolveArchived(stores, hit.refKind, hit.refId),
      })),
    });
  });

  return app;
}

/**
 * Whether the hit's referenced entity is archived, read fresh rather than
 * carried in the index — §6.8's "reported as archived rather than hidden"
 * only holds if this can never be stale. A session is archived exactly when
 * its workstream is (§3.3: the archive gesture is the workstream's); an id
 * the store no longer has a record for reports `false` rather than throwing —
 * a search result outliving its own referent is a fact for the row to state
 * (a stale index entry), never a reason to fail the whole query.
 */
function resolveArchived(
  stores: ApiStores,
  refKind: string,
  refId: string,
): boolean {
  if (refKind !== "session") return false;
  try {
    const stored = stores.sessions.get(refId);
    const workstream = stores.workstreams.get(stored.session.workstreamId);
    return (
      workstream?.archivedAt !== null && workstream?.archivedAt !== undefined
    );
  } catch {
    return false;
  }
}
