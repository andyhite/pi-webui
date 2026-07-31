/**
 * Migrations are embedded rather than read from disk, so a packaged app has no
 * asset-copying step and cannot ship a build missing its schema.
 *
 * Append only. Never edit a migration that has shipped.
 */
export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

export const migrations: readonly Migration[] = [
  {
    id: 1,
    name: "blobs_and_search",
    sql: `
      CREATE TABLE blobs (
        id           TEXT PRIMARY KEY,
        hash         TEXT NOT NULL UNIQUE,
        size         INTEGER NOT NULL,
        encoding     TEXT NOT NULL CHECK (encoding IN ('utf8', 'binary')),
        kind         TEXT NOT NULL,
        inline_bytes BLOB,
        is_external  INTEGER NOT NULL DEFAULT 0,
        released_at  INTEGER,
        created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
        CHECK (
          (is_external = 1 AND inline_bytes IS NULL) OR
          (is_external = 0 AND (inline_bytes IS NOT NULL OR released_at IS NOT NULL))
        )
      );

      CREATE INDEX blobs_kind_idx ON blobs (kind);
      CREATE INDEX blobs_size_idx ON blobs (size);

      CREATE TABLE blob_refs (
        blob_id    TEXT NOT NULL REFERENCES blobs (id) ON DELETE CASCADE,
        owner_kind TEXT NOT NULL,
        owner_id   TEXT NOT NULL,
        pinned     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (blob_id, owner_kind, owner_id)
      );

      CREATE INDEX blob_refs_owner_idx ON blob_refs (owner_kind, owner_id);

      -- Index-only FTS: content is tokenized on write, wherever the bytes
      -- live, so search works for inline and external content alike (§6.8).
      CREATE VIRTUAL TABLE search USING fts5(
        body,
        kind UNINDEXED,
        ref_kind UNINDEXED,
        ref_id UNINDEXED
      );
    `,
  },
];
