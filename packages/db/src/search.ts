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
   * Whether this entity already has a row — the backfill's own idempotency
   * check (§6.8, Epic 8.2): a boot-time sweep over every session asks this
   * first, so a session already indexed costs one indexed lookup rather than
   * a full re-derivation and re-write every time the process starts.
   */
  has(refKind: string, refId: string): boolean {
    const row = this.state.sqlite
      .prepare("SELECT 1 FROM search WHERE ref_kind = ? AND ref_id = ? LIMIT 1")
      .get(refKind, refId);
    return row !== undefined;
  }

  query(match: string, options: SearchOptions = {}): SearchHit[] {
    const limit = options.limit ?? 25;
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
