import { DEFAULT_SEARCH_LIMIT } from "@plotroom/db";
import { Hono } from "hono";
import { badRequest, forbidden } from "../http/errors.js";
import { actorOf, type ApiEnv, type ApiStores } from "./api.js";

/**
 * The most hits one request will answer with, however large a `limit` it asks
 * for. A clamp rather than a refusal — but never a silent one: see
 * `truncated` below.
 */
const MAX_SEARCH_LIMIT = 100;

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
 *
 * The operator's own surface, matching `/api/logs` and `/api/settings`: a
 * search result carries transcript snippets across every workstream a
 * session was never wired into, so a session reading it would be the exact
 * silent reach principle 1 exists to prevent — not lessened by "only a
 * snippet", since a snippet is exactly how much of another session's private
 * content a session was never given. This route's own
 * `OPERATOR_ONLY_ROUTES` entry already declares it operator-only
 * (`packages/core/src/sessions/tools/catalog.test.ts`); this is that
 * declaration enforced rather than merely documented (cross-cutting rule 3).
 *
 * Every answer says whether it is complete. `limit` is the bound actually
 * applied — the caller's, clamped to `MAX_SEARCH_LIMIT`, or the index's own
 * default when none was asked for — and `truncated` is true when the index
 * held at least one more hit than that. Detected by asking for one hit past
 * the limit and dropping it, so "there are more" is observed rather than
 * inferred from `hits.length === limit`, which is also true of a query whose
 * last hit is its last hit. A clamped result that said nothing about being
 * clamped would be silent truncation, which this repository does not do
 * (AGENTS.md) — an operator searching a fleet's transcripts has no other way
 * to tell "nothing else matched" from "the rest was not shown".
 *
 * `q` is always literal text, never FTS5 query grammar. A hyphenated ticket
 * id (`PROJ-123`), a branch name (`feat/x-y`), an unbalanced quote, a stray
 * `*` or `(` — anything an operator or a future agent caller pastes in — is
 * search text, not a NOT-operator, a column filter, or a syntax error that
 * surfaces as a 500. `stores.search.query` sanitizes at the source
 * (`toLiteralFtsQuery` in `@plotroom/db`) precisely because this route is the
 * gate every caller goes through (curl, the UI, agents later): a caller that
 * genuinely needs raw FTS5 grammar has no way to opt into it here — that
 * would be a deliberate future addition to this route, not today's default.
 */
export function searchRoutes(stores: ApiStores): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get("/search", (c) => {
    if (actorOf(c).kind !== "human") {
      throw forbidden(
        "search is the operator's browse/find surface (§6.8); a session cannot make it",
      );
    }

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
    // Truncated to an integer, not merely clamped: a fractional `LIMIT` is a
    // datatype mismatch SQLite raises as a 500, and "1.5 hits" is not a
    // question this route should be forwarding in the first place.
    const limit =
      limitParam !== undefined && Number.isFinite(Number(limitParam))
        ? Math.max(
            1,
            Math.min(MAX_SEARCH_LIMIT, Math.trunc(Number(limitParam))),
          )
        : DEFAULT_SEARCH_LIMIT;

    // One past the limit: the extra hit is never returned, and its existence
    // is the only honest evidence that the answer is partial.
    const found = stores.search.query(q, {
      ...(kinds ? { kinds } : {}),
      limit: limit + 1,
    });
    const truncated = found.length > limit;
    const hits = truncated ? found.slice(0, limit) : found;

    return c.json({
      query: q,
      limit,
      truncated,
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
