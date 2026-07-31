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
  {
    id: 2,
    name: "objects_and_versions",
    sql: `
      CREATE TABLE objects (
        id                TEXT PRIMARY KEY,
        kind              TEXT NOT NULL,
        scope             TEXT NOT NULL CHECK (scope IN ('world', 'local')),
        -- Local objects belong to the workstream that produced them; a world
        -- object has no owner and can be context for many (§3.2).
        workstream_id     TEXT,
        -- External identity survives re-reads, so a refresh reconciles
        -- rather than duplicating (§3.1).
        external_system   TEXT,
        external_id       TEXT,
        title             TEXT NOT NULL,
        latest_version_id TEXT,
        created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
        promoted_at       INTEGER,
        CHECK (
          (scope = 'local' AND workstream_id IS NOT NULL) OR
          (scope = 'world' AND workstream_id IS NULL)
        ),
        CHECK (
          (external_system IS NULL AND external_id IS NULL) OR
          (external_system IS NOT NULL AND external_id IS NOT NULL)
        )
      );

      CREATE UNIQUE INDEX objects_external_idx
        ON objects (external_system, external_id)
        WHERE external_system IS NOT NULL;

      CREATE INDEX objects_kind_idx ON objects (kind);
      CREATE INDEX objects_workstream_idx ON objects (workstream_id);

      CREATE TABLE object_versions (
        id             TEXT PRIMARY KEY,
        object_id      TEXT NOT NULL REFERENCES objects (id) ON DELETE CASCADE,
        ordinal        INTEGER NOT NULL,
        content_hash   TEXT NOT NULL,
        -- The object's single output, agent-ready, stored via the blob store
        -- so large content spills out of the row (§3.2).
        content_blob_id TEXT NOT NULL REFERENCES blobs (id),
        -- Card renderings are structured; the summary is one line (§3.2).
        card_json      TEXT NOT NULL,
        summary        TEXT NOT NULL,
        -- "What's new" against the previous version, when the producer can
        -- express one smaller than the content itself (§3.2).
        delta_summary  TEXT,
        delta_blob_id  TEXT REFERENCES blobs (id),
        -- §15 invariant 3: retention metadata exists from the first write.
        run_referenced INTEGER NOT NULL DEFAULT 0,
        pinned         INTEGER NOT NULL DEFAULT 0,
        created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE (object_id, ordinal)
      );

      CREATE INDEX object_versions_object_idx
        ON object_versions (object_id, ordinal DESC);

      CREATE INDEX object_versions_retention_idx
        ON object_versions (run_referenced, pinned, created_at);
    `,
  },
];
