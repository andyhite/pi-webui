import type { PlotroomDatabase } from "./client.js";

export interface IndexEntry {
  readonly body: string;
  /** Content kind, e.g. "transcript_part", "note", "ticket". */
  readonly kind: string;
  /** What the hit should navigate to. */
  readonly refKind: string;
  readonly refId: string;
}

export interface SearchHit {
  readonly kind: string;
  readonly refKind: string;
  readonly refId: string;
  readonly snippet: string;
  readonly rank: number;
}

export interface SearchOptions {
  readonly limit?: number;
  /** Restrict to these content kinds. */
  readonly kinds?: readonly string[];
}

/**
 * Index-only FTS5 (spec §6.8). Content is tokenized on write regardless of
 * where its bytes live, so inline and external blobs are equally searchable
 * and archived sessions stay findable rather than hidden.
 */
export class SearchIndex {
  constructor(private readonly state: PlotroomDatabase) {}

  index(entry: IndexEntry): void {
    this.remove(entry.refKind, entry.refId);
    this.state.sqlite
      .prepare(
        "INSERT INTO search (body, kind, ref_kind, ref_id) VALUES (?, ?, ?, ?)",
      )
      .run(entry.body, entry.kind, entry.refKind, entry.refId);
  }

  remove(refKind: string, refId: string): void {
    this.state.sqlite
      .prepare("DELETE FROM search WHERE ref_kind = ? AND ref_id = ?")
      .run(refKind, refId);
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
                snippet(search, 0, '[', ']', '…', 12) AS snippet,
                rank
           FROM search
          WHERE search MATCH ?
            ${kindFilter}
          ORDER BY rank
          LIMIT ?`,
      )
      .all(match, ...kinds, limit);

    return rows.map((row) => ({
      kind: row.kind,
      refKind: row.refKind,
      refId: row.refId,
      snippet: row.snippet,
      rank: row.rank,
    }));
  }
}

interface SearchRow {
  kind: string;
  refKind: string;
  refId: string;
  snippet: string;
  rank: number;
}
