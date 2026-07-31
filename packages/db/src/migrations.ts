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
  {
    id: 3,
    name: "nodes_and_edges",
    sql: `
      CREATE TABLE nodes (
        id            TEXT PRIMARY KEY,
        role          TEXT NOT NULL CHECK (role IN ('content', 'command', 'session')),
        -- What this node stands for: an object, a command, or a session.
        ref_id        TEXT NOT NULL,
        workstream_id TEXT,
        running       INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
        deleted_at    INTEGER,
        UNIQUE (role, ref_id)
      );

      CREATE INDEX nodes_workstream_idx ON nodes (workstream_id);

      CREATE TABLE edges (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL CHECK (kind IN ('context', 'provenance')),
        from_node  TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
        to_node    TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,

        -- Section 15 invariant 2: every context edge records its author.
        -- NOT NULL is the whole point; a nullable column would let a single
        -- unattributed write make the graph unable to say who decided what
        -- agents know. Provenance edges are recorded by the system, never
        -- authored, and carry the reserved author 'system'.
        author_kind    TEXT NOT NULL CHECK (author_kind IN ('human', 'session', 'system')),
        author_session TEXT,

        -- Context edges only: assembly order of this input into its target.
        ordinal    INTEGER,
        -- Provenance edges only: what the relationship means.
        relation   TEXT,

        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        deleted_at INTEGER,

        CHECK (
          (author_kind = 'session' AND author_session IS NOT NULL) OR
          (author_kind <> 'session' AND author_session IS NULL)
        ),
        CHECK (
          (kind = 'context'    AND ordinal IS NOT NULL AND relation IS NULL
                               AND author_kind IN ('human', 'session')) OR
          (kind = 'provenance' AND ordinal IS NULL AND relation IS NOT NULL
                               AND author_kind = 'system')
        )
      );

      CREATE UNIQUE INDEX edges_context_unique_idx
        ON edges (from_node, to_node)
        WHERE kind = 'context' AND deleted_at IS NULL;

      CREATE UNIQUE INDEX edges_context_ordinal_idx
        ON edges (to_node, ordinal)
        WHERE kind = 'context' AND deleted_at IS NULL;

      CREATE INDEX edges_to_idx ON edges (to_node, kind);
      CREATE INDEX edges_from_idx ON edges (from_node, kind);

      -- Initiation chains: principle 1's enforcement substrate. A null parent
      -- means a human gesture started this session.
      CREATE TABLE session_lineage (
        session_id    TEXT PRIMARY KEY,
        initiated_by  TEXT REFERENCES session_lineage (session_id),
        created_at    INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX session_lineage_parent_idx ON session_lineage (initiated_by);
    `,
  },
  {
    id: 4,
    name: "workstreams",
    sql: `
      CREATE TABLE workstreams (
        id                TEXT PRIMARY KEY,
        -- The subject is authored and optional: dragging a ticket in gives
        -- the container its identity, and a subject-less scratch workstream
        -- is legal (§3.3).
        subject_object_id TEXT REFERENCES objects (id),
        -- Lifecycle is authored, never auto-transitioned; the product only
        -- suggests (§3.3).
        status            TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'done', 'abandoned')),
        -- Archive is a gesture, not a status: an archived workstream leaves
        -- the board, stays searchable reported as archived, and is
        -- recoverable (§3.3, principle 10).
        archived_at       INTEGER,
        -- Attention rollup cache for the collapsed card (§3.3, §7): derived
        -- from the feeds, never authored, safe to recompute at any time.
        attention_status  TEXT,
        attention_json    TEXT,
        created_at        INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX workstreams_board_idx ON workstreams (status, archived_at);

      -- Every authored workstream mutation is attributed, and the trail is
      -- what makes lifecycle changes and the archive gesture recoverable
      -- (principle 10). There is deliberately no 'system' author here:
      -- nothing in this table is machine-initiated — the product suggests,
      -- a human confirms (§3.3).
      CREATE TABLE workstream_events (
        id             TEXT PRIMARY KEY,
        workstream_id  TEXT NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
        kind           TEXT NOT NULL CHECK (kind IN
                         ('created', 'subject_set', 'status_set', 'archived', 'unarchived')),
        -- The new status or subject object id, where the kind carries one.
        value          TEXT,
        author_kind    TEXT NOT NULL CHECK (author_kind IN ('human', 'session')),
        author_session TEXT,
        created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
        CHECK (
          (author_kind = 'session' AND author_session IS NOT NULL) OR
          (author_kind = 'human' AND author_session IS NULL)
        )
      );

      CREATE INDEX workstream_events_stream_idx
        ON workstream_events (workstream_id, created_at);
    `,
  },
];
