import type { PlotroomDatabase } from "./client.js";

export interface IndexEntry {
  /** A session's own title, a note's title, etc. — ranked highest. */
  readonly title: string;
  /** Where it lives — a workstream's identity, a folder — ranked second. */
  readonly location: string;
  /** The full content: a transcript, a note's body. Ranked third. */
  readonly body: string;
  /** Content kind, e.g. "session", "note", "ticket". */
  readonly kind: string;
  /** What the hit should navigate to. */
  readonly refKind: string;
  readonly refId: string;
}

export interface SearchHit {
  readonly kind: string;
  readonly refKind: string;
  readonly refId: string;
  readonly title: string;
  readonly location: string;
  readonly snippet: string;
  readonly rank: number;
}

export interface SearchOptions {
  readonly limit?: number;
  /** Restrict to these content kinds. */
  readonly kinds?: readonly string[];
}

/**
 * Weights bm25 favors title over location over body, so a session named after
 * what somebody is searching for outranks one that merely mentions the word
 * once in a long transcript (§6.8: "ranked over title, location, and content").
 */
const TITLE_WEIGHT = 10.0;
const LOCATION_WEIGHT = 4.0;
const BODY_WEIGHT = 1.0;

/**
 * How many hits a caller that names no limit gets. Exported because a caller
 * that must report truncation has to know the limit it is actually under: a
 * route asking for "the default, plus one" cannot spell that against a number
 * only this module knows (no silent truncation, AGENTS.md).
 */
export const DEFAULT_SEARCH_LIMIT = 25;

/**
 * Converts operator-typed free text into a literal FTS5 phrase query, so a
 * hyphenated ticket id (`PROJ-123`), a branch name (`feat/x-y`), or garbage
 * punctuation a caller pastes in are always search text, never accidental
 * FTS5 query grammar (the `-` NOT operator, column filters, unbalanced
 * quotes, parens, or a `*` prefix). Splits on whitespace and double-quotes
 * each resulting term, doubling any internal `"` so it round-trips as a
 * literal character rather than closing the phrase early. Each term becomes
 * its own FTS5 phrase; FTS5's default operator between phrases is AND, so a
 * multi-word query keeps requiring every word rather than any one of them.
 * Returns `null` when there is nothing left to search for (blank, or only
 * whitespace a caller's own trim missed) — the sentinel for "no hits", never
 * an error. There is deliberately no way through this function to reach raw
 * FTS5 grammar (boolean operators, column filters, prefix search); an
 * operator who needs that is a future opt-in, not today's default (no silent
 * behavior surprises, per AGENTS.md).
 */
export function toLiteralFtsQuery(input: string): string | null {
  const terms = input
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .map((term) => `"${term.replace(/"/g, '""')}"`);
  return terms.length > 0 ? terms.join(" ") : null;
}

/**
 * Index-only FTS5 (spec §6.8). Content is tokenized on write regardless of
 * where its bytes live, so search works for inline and external content alike
 * and archived sessions stay findable rather than hidden — "archived" itself
 * is never stored here: a caller resolves it fresh from the referenced
 * entity's own record, so the index cannot go stale about it.
 */
export class SearchIndex {
  constructor(private readonly state: PlotroomDatabase) {}

  index(entry: IndexEntry): void {
    this.remove(entry.refKind, entry.refId);
    this.state.sqlite
      .prepare(
        "INSERT INTO search (title, location, body, kind, ref_kind, ref_id) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        entry.title,
        entry.location,
        entry.body,
        entry.kind,
        entry.refKind,
        entry.refId,
      );
  }

  remove(refKind: string, refId: string): void {
    this.state.sqlite
      .prepare("DELETE FROM search WHERE ref_kind = ? AND ref_id = ?")
      .run(refKind, refId);
  }

  /**
   * Whether this entity already has a row (§6.8, Epic 8.2).
   *
   * `search` is an FTS5 virtual table, so a `WHERE ref_kind = …` with no
   * `MATCH` beside it is a **full scan** of the index — cheap for one
   * question, and quadratic for a caller asking it once per row. A sweep over
   * every session asks {@link indexedRefIds} instead, which is the same
   * question asked once.
   */
  has(refKind: string, refId: string): boolean {
    const row = this.state.sqlite
      .prepare("SELECT 1 FROM search WHERE ref_kind = ? AND ref_id = ? LIMIT 1")
      .get(refKind, refId);
    return row !== undefined;
  }

  /**
   * Every `refId` of one kind that already has a row — the boot backfill's
   * idempotency check, asked once rather than per session.
   *
   * One scan of the index instead of `has` per row: the backfill is O(n) in
   * sessions and O(1) in scans, where calling `has` in a loop was O(n) scans
   * of an n-row index. The set is read fresh by each caller and never cached,
   * because the only thing that could invalidate it is a write this same
   * class made.
   */
  indexedRefIds(refKind: string): Set<string> {
    const rows = this.state.sqlite
      .prepare<unknown[], { refId: string }>(
        "SELECT ref_id AS refId FROM search WHERE ref_kind = ?",
      )
      .all(refKind);
    return new Set(rows.map((row) => row.refId));
  }

  /**
   * `rawQuery` is the operator's free text, never FTS5 grammar (see
   * `toLiteralFtsQuery`) — a hyphenated ticket id or a branch name is search
   * text here, not a NOT-operator or a syntax error. A query that sanitizes
   * to nothing (blank, or only whitespace a caller's own trim missed)
   * returns no hits rather than asking SQLite to explain an empty MATCH.
   */
  query(rawQuery: string, options: SearchOptions = {}): SearchHit[] {
    const match = toLiteralFtsQuery(rawQuery);
    if (match === null) return [];

    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
    const kinds = options.kinds ?? [];

    const kindFilter =
      kinds.length > 0
        ? `AND kind IN (${kinds.map(() => "?").join(", ")})`
        : "";

    const rows = this.state.sqlite
      .prepare<unknown[], SearchRow>(
        `SELECT kind,
                ref_kind AS refKind,
                ref_id   AS refId,
                title,
                location,
                snippet(search, 2, '[', ']', '…', 12) AS snippet,
                bm25(search, ?, ?, ?) AS rank
           FROM search
          WHERE search MATCH ?
            ${kindFilter}
          ORDER BY rank
          LIMIT ?`,
      )
      .all(TITLE_WEIGHT, LOCATION_WEIGHT, BODY_WEIGHT, match, ...kinds, limit);

    return rows.map((row) => ({
      kind: row.kind,
      refKind: row.refKind,
      refId: row.refId,
      title: row.title,
      location: row.location,
      snippet: row.snippet,
      rank: row.rank,
    }));
  }
}

interface SearchRow {
  kind: string;
  refKind: string;
  refId: string;
  title: string;
  location: string;
  snippet: string;
  rank: number;
}
