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
  {
    id: 5,
    name: "commands_and_runs",
    sql: `
      -- A command definition is reusable, editable *content*, not code
      -- (§3.5): created, duplicated, and organized by the user, shipped
      -- first-party in the box, and shippable inside plugins.
      CREATE TABLE command_definitions (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        instruction      TEXT NOT NULL,
        model            TEXT NOT NULL,
        effort           TEXT NOT NULL CHECK (effort IN ('low', 'medium', 'high')),
        permissions_json TEXT NOT NULL,
        -- Where the user wants to be asked (§3.5, §6.6). Stored as declared;
        -- the effective set is computed, because irreversibility always asks.
        ask_points_json  TEXT NOT NULL,
        lifecycle        TEXT NOT NULL CHECK (lifecycle IN ('producing', 'open')),
        -- The expected outcome: a named, typed object, optionally with
        -- structure and with world conditions (§3.5).
        outcome_json     TEXT,
        parameters_json  TEXT NOT NULL,
        budget_json      TEXT NOT NULL,
        source           TEXT NOT NULL CHECK (source IN ('builtin', 'user', 'plugin')),
        -- Organization is authored: a user-named folder, or the top level.
        folder           TEXT,
        duplicated_from  TEXT REFERENCES command_definitions (id),
        created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
        deleted_at       INTEGER,
        -- The two lifecycles, enforced rather than described: producing work
        -- declares what it will produce, open work cannot pretend to (§3.5).
        CHECK (
          (lifecycle = 'producing' AND outcome_json IS NOT NULL) OR
          (lifecycle = 'open'      AND outcome_json IS NULL)
        )
      );

      CREATE INDEX command_definitions_folder_idx
        ON command_definitions (folder, name);

      -- A command node: a definition plus its wiring (§3.5). workstream_id is
      -- NOT NULL because a command never leaves its workstream (§3.3).
      CREATE TABLE commands (
        id            TEXT PRIMARY KEY,
        definition_id TEXT NOT NULL REFERENCES command_definitions (id),
        workstream_id TEXT NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
        created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
        -- Soft delete: authored state is recoverable (principle 10).
        deleted_at    INTEGER
      );

      CREATE INDEX commands_workstream_idx ON commands (workstream_id);
      CREATE INDEX commands_definition_idx ON commands (definition_id);

      -- Parameter bindings (§3.5). A derived default is a *proposal the user
      -- confirms, never a guess applied silently* — so the two states are
      -- distinguished in the schema, and a proposal cannot carry the
      -- confirmation that would make a reader treat it as a value.
      CREATE TABLE command_parameter_bindings (
        command_id   TEXT NOT NULL REFERENCES commands (id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        state        TEXT NOT NULL CHECK (state IN ('proposed', 'confirmed')),
        value_json   TEXT NOT NULL,
        -- Where the proposal came from, so the user can judge it.
        derived_from TEXT,
        confirmed_at INTEGER,
        PRIMARY KEY (command_id, name),
        CHECK (
          (state = 'proposed'  AND derived_from IS NOT NULL AND confirmed_at IS NULL) OR
          (state = 'confirmed' AND confirmed_at IS NOT NULL)
        )
      );

      -- Output pre-wiring (§3.5): a producing command's output exists before
      -- any run as a typed placeholder, and binds to what was produced after.
      CREATE TABLE command_outputs (
        id              TEXT PRIMARY KEY,
        command_id      TEXT NOT NULL REFERENCES commands (id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        kind            TEXT NOT NULL,
        structure_json  TEXT,
        -- publish marks a placeholder world-visible *before* a run, which is
        -- the product's only cross-workstream dependency. Distinct from
        -- promote, which lifts an existing object after the fact (§3.2).
        published_at    INTEGER,
        bound_object_id TEXT REFERENCES objects (id),
        bound_run_id    TEXT REFERENCES runs (id),
        bound_at        INTEGER,
        -- The pre-bind half of the two-state rule: deleting the producing
        -- command leaves a visibly broken placeholder, never a silent
        -- unblock (§3.5).
        broken_at       INTEGER,
        created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE (command_id, name),
        CHECK (
          (bound_object_id IS NULL     AND bound_at IS NULL) OR
          (bound_object_id IS NOT NULL AND bound_at IS NOT NULL)
        ),
        -- Post-bind, what crosses is the object and the command dependency has
        -- evaporated, so a bound output can never become broken.
        CHECK (broken_at IS NULL OR bound_object_id IS NULL)
      );

      CREATE INDEX command_outputs_command_idx ON command_outputs (command_id);

      -- Section 15 invariant 1: run history records the FULL assembled content
      -- and the configuration it ran under. Both are NOT NULL, because a run
      -- recorded without them is exactly the uncomparable history the
      -- invariant exists to prevent (§3.7, §4.4).
      CREATE TABLE runs (
        id                 TEXT PRIMARY KEY,
        command_id         TEXT NOT NULL REFERENCES commands (id) ON DELETE CASCADE,
        -- Recorded on the run because retention is per definition (§4.4).
        definition_id      TEXT NOT NULL REFERENCES command_definitions (id),
        -- Section 15 invariant 4: the n in output@n. 1-based per command, and
        -- the general address. There is deliberately no 'latest' column
        -- anywhere in this schema — latest is resolved by ordering runs.
        ordinal            INTEGER NOT NULL,
        status             TEXT NOT NULL CHECK (status IN
                             ('running', 'completed', 'failed', 'out_of_budget', 'stopped')),
        assembled_blob_id  TEXT NOT NULL REFERENCES blobs (id),
        assembled_hash     TEXT NOT NULL,
        assembled_bytes    INTEGER NOT NULL,
        config_json        TEXT NOT NULL,
        -- What it cost, so cross-run outcomes are answerable (§4.4, §8).
        input_tokens       INTEGER NOT NULL DEFAULT 0,
        output_tokens      INTEGER NOT NULL DEFAULT 0,
        cost_micros        INTEGER NOT NULL DEFAULT 0,
        -- Proof is point-in-time: what held at submission, written once and
        -- never silently revoked (§3.5).
        outcome_proof_json TEXT,
        failure_reason     TEXT,
        -- Pinning is the human's word for "never compact this" (§4.4).
        pinned             INTEGER NOT NULL DEFAULT 0,
        started_at         INTEGER NOT NULL DEFAULT (unixepoch()),
        ended_at           INTEGER,
        UNIQUE (command_id, ordinal)
      );

      CREATE INDEX runs_definition_idx ON runs (definition_id, started_at);
      CREATE INDEX runs_retention_idx ON runs (pinned, started_at);

      -- The exact ordered content that went in (§15 invariant 1). The version
      -- foreign key is the teeth of invariant 3's interplay: a version a run
      -- consumed cannot be deleted while the run exists, so compaction can
      -- never quietly eat run history.
      CREATE TABLE run_inputs (
        run_id       TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        ordinal      INTEGER NOT NULL,
        node_id      TEXT,
        object_id    TEXT NOT NULL REFERENCES objects (id),
        version_id   TEXT NOT NULL REFERENCES object_versions (id),
        content_hash TEXT NOT NULL,
        bytes        INTEGER NOT NULL,
        PRIMARY KEY (run_id, ordinal)
      );

      CREATE INDEX run_inputs_version_idx ON run_inputs (version_id);

      -- Section 15 invariant 4: outputs are addressed per run. Resolving
      -- 'latest' is a query over runs.ordinal, so a new run never rewrites
      -- what output@1 means.
      CREATE TABLE run_outputs (
        run_id     TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        object_id  TEXT NOT NULL REFERENCES objects (id),
        version_id TEXT NOT NULL REFERENCES object_versions (id),
        PRIMARY KEY (run_id, name)
      );

      CREATE INDEX run_outputs_name_idx ON run_outputs (name, run_id);
      CREATE INDEX run_outputs_version_idx ON run_outputs (version_id);
    `,
  },
];
