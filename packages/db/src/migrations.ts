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
  /**
   * Set for the one kind of change SQLite cannot make in place: altering a
   * CHECK constraint, which requires rebuilding the table.
   *
   * SQLite's own procedure for that (its ALTER TABLE docs, "Making Other Kinds
   * Of Table Schema Changes") requires foreign keys to be *off* while the old
   * table is dropped — otherwise the drop performs an implicit cascading delete
   * and takes every child row with it. `PRAGMA foreign_keys` is a no-op inside a
   * transaction, so the runner turns it off *before* beginning one, which keeps
   * the rebuild atomic and the children intact. It then turns it back on and
   * runs `PRAGMA foreign_key_check`, so a rebuild that got the references wrong
   * fails loudly instead of shipping a store that lies about itself.
   */
  readonly rebuildsTable?: true;
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
  {
    id: 6,
    name: "recoverable_deletion",
    sql: `
      -- Principle 10: deletion is recoverable for authored state, including
      -- when an agent did the deleting. Nodes, edges, commands, and command
      -- definitions already carried deleted_at; objects and workstreams did
      -- not, so "delete a workstream" and "delete an object" had no
      -- representation that could be undone. They do now.
      ALTER TABLE objects ADD COLUMN deleted_at INTEGER;
      ALTER TABLE workstreams ADD COLUMN deleted_at INTEGER;

      -- The restorable list is a query over these, so it is cheap enough to
      -- offer as a first-class verb rather than a maintenance tool.
      CREATE INDEX objects_deleted_idx ON objects (deleted_at);
      CREATE INDEX workstreams_deleted_idx ON workstreams (deleted_at);

      -- Widen the attribution trail to cover deletion and restoration: a
      -- CHECK constraint cannot be altered in place, so the table is rebuilt.
      -- "Who deleted this, and when" is the question the restore list has to
      -- answer, and an untracked deletion cannot answer it.
      CREATE TABLE workstream_events_new (
        id             TEXT PRIMARY KEY,
        workstream_id  TEXT NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
        kind           TEXT NOT NULL CHECK (kind IN
                         ('created', 'subject_set', 'status_set', 'archived',
                          'unarchived', 'deleted', 'restored')),
        value          TEXT,
        author_kind    TEXT NOT NULL CHECK (author_kind IN ('human', 'session')),
        author_session TEXT,
        created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
        CHECK (
          (author_kind = 'session' AND author_session IS NOT NULL) OR
          (author_kind = 'human' AND author_session IS NULL)
        )
      );

      INSERT INTO workstream_events_new
        SELECT id, workstream_id, kind, value, author_kind, author_session, created_at
        FROM workstream_events;

      DROP TABLE workstream_events;
      ALTER TABLE workstream_events_new RENAME TO workstream_events;

      CREATE INDEX workstream_events_stream_idx
        ON workstream_events (workstream_id, created_at);
    `,
  },
  {
    id: 7,
    name: "sessions_and_workspaces",
    sql: `
      -- One workstream owns exactly one workspace, and workspaces never cross
      -- workstreams (§3.4). The boundary is a predicate in @plotroom/core
      -- (checkWorkspaceBoundary); the partial unique index below is the same
      -- rule the schema cannot represent a violation of. Timestamps in this
      -- table are MILLISECONDS, matching the workspace record's own
      -- EpochMillis vocabulary rather than converting at every edge.
      CREATE TABLE workspaces (
        id                    TEXT PRIMARY KEY,
        workstream_id         TEXT NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
        kind                  TEXT NOT NULL,
        -- Opaque to the product; the kind validated it (§10.1), and it crosses
        -- a worker boundary as JSON for a plugin-supplied kind.
        config_json           TEXT NOT NULL,
        -- One entry per root, so a multi-root kind (§13) needs no new concept.
        roots_json            TEXT NOT NULL DEFAULT '[]',
        -- The readiness record whole, including the last setup attempt's
        -- output: not-ready blocks a run with a visible reason (§3.4).
        readiness_json        TEXT NOT NULL,
        created_by_kind       TEXT NOT NULL CHECK (created_by_kind IN ('human', 'session')),
        created_by_session    TEXT,
        created_at            INTEGER NOT NULL,
        -- Provisioning happens at FIRST RUN, never at workstream creation
        -- (§3.4, §3.5): a fresh record has no roots and no provisioned_at.
        provisioned_at        INTEGER,
        provision_cost_json   TEXT,
        last_fingerprint_json TEXT,
        removed_at            INTEGER,
        CHECK (
          (created_by_kind = 'session' AND created_by_session IS NOT NULL) OR
          (created_by_kind = 'human'   AND created_by_session IS NULL)
        )
      );

      CREATE UNIQUE INDEX workspaces_workstream_idx
        ON workspaces (workstream_id)
        WHERE removed_at IS NULL;

      -- A session (§3.6): live and stored are the same record, so "end" is
      -- null while it runs. Everything derived from observation — the phase,
      -- the accounting totals — is a *snapshot* here; session_observations is
      -- the truth it is folded from, which is why a restart can recompute it
      -- rather than trust it (principle 7).
      CREATE TABLE sessions (
        id                   TEXT PRIMARY KEY,
        -- A session never leaves its workstream (§3.3).
        workstream_id        TEXT NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
        command_id           TEXT REFERENCES commands (id),
        -- Run retention (§4.4) may reclaim the run; the session record is
        -- readable, resumable, and forkable *always* (§3.6), so the link goes
        -- null and the record stays rather than the reverse.
        run_id               TEXT REFERENCES runs (id) ON DELETE SET NULL,
        workspace_id         TEXT REFERENCES workspaces (id),
        mode                 TEXT NOT NULL CHECK (mode IN ('producing', 'open')),
        -- Per-session launch choices, made at launch and visible after (§3.6).
        -- A null allowed_tools_json inherits the app's tools; a list narrows
        -- them, and checkToolPermissions refuses anything wider.
        model                TEXT NOT NULL,
        effort               TEXT NOT NULL CHECK (effort IN
                               ('off', 'minimal', 'low', 'medium', 'high', 'max')),
        allowed_tools_json   TEXT,
        initiated_by_kind    TEXT NOT NULL CHECK (initiated_by_kind IN ('human', 'session')),
        initiated_by_session TEXT,
        -- Which adapter and which native session, so resume and fork survive a
        -- restart (decision 0001).
        adapter_id           TEXT NOT NULL,
        runtime_ref          TEXT NOT NULL,
        -- The transcript is content like anything else (§3.6): an object whose
        -- versions are published by the checkpoint rule, never per turn.
        transcript_object_id TEXT REFERENCES objects (id),
        -- Derived by PlotRoom from the observation log, never agent-reported.
        phase_json           TEXT NOT NULL,
        turns                INTEGER NOT NULL DEFAULT 0,
        input_tokens         INTEGER NOT NULL DEFAULT 0,
        output_tokens        INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens   INTEGER NOT NULL DEFAULT 0,
        -- Money as integer micros, like runs.cost_micros: a float column is
        -- how spend totals stop adding up.
        cost_micros          INTEGER NOT NULL DEFAULT 0,
        -- A number that cannot name its source is not evidence (§3.6).
        cost_basis           TEXT NOT NULL DEFAULT 'none' CHECK (cost_basis IN
                               ('runtime-reported', 'priced-from-tokens', 'none')),
        context_used_tokens  INTEGER,
        context_max_tokens   INTEGER,
        context_basis        TEXT CHECK (context_basis IN ('reported', 'estimated')),
        started_at           INTEGER NOT NULL,
        last_activity_at     INTEGER NOT NULL,
        -- The closed end-state taxonomy (§3.6, principle 11). out-of-budget is
        -- distinct from failed, and interrupted from both; a nullable end_kind
        -- is what "live" means, and the three columns move together.
        end_kind             TEXT CHECK (end_kind IN
                               ('completed', 'ended-by-user', 'stopped',
                                'out-of-budget', 'failed', 'interrupted')),
        end_json             TEXT,
        ended_at             INTEGER,
        deleted_at           INTEGER,
        CHECK (
          (initiated_by_kind = 'session' AND initiated_by_session IS NOT NULL) OR
          (initiated_by_kind = 'human'   AND initiated_by_session IS NULL)
        ),
        CHECK (
          (end_kind IS NULL     AND end_json IS NULL     AND ended_at IS NULL) OR
          (end_kind IS NOT NULL AND end_json IS NOT NULL AND ended_at IS NOT NULL)
        ),
        -- A producing session runs a command and its run history is the record
        -- of what it produced (§3.5); an open session is a conversation.
        CHECK (
          (mode = 'producing' AND command_id IS NOT NULL) OR mode = 'open'
        ),
        CHECK (
          (context_used_tokens IS NULL AND context_max_tokens IS NULL
                                       AND context_basis IS NULL) OR
          (context_used_tokens IS NOT NULL AND context_max_tokens IS NOT NULL
                                           AND context_basis IS NOT NULL)
        )
      );

      CREATE INDEX sessions_workstream_idx ON sessions (workstream_id);
      CREATE INDEX sessions_command_idx ON sessions (command_id);
      CREATE INDEX sessions_run_idx ON sessions (run_id);
      -- The in-flight query principle 11 runs at every process start.
      CREATE INDEX sessions_live_idx ON sessions (end_kind, deleted_at);

      -- PlotRoom's OWN observation records, not vendor payloads (§3.6,
      -- decision 0001): the log resume, fork, phases, and accounting are all
      -- derived from, so all of them survive vendor churn. Appended in order;
      -- \`seq\` is 1-based per session and the ordering primitive.
      CREATE TABLE session_observations (
        session_id       TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        seq              INTEGER NOT NULL,
        -- Milliseconds, as the adapter stamped it at observation time.
        at               INTEGER NOT NULL,
        kind             TEXT NOT NULL,
        observation_json TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );

      CREATE INDEX session_observations_kind_idx
        ON session_observations (session_id, kind);

      -- The live-transcript checkpoint rule (§3.6): consumers drift on session
      -- end or explicit checkpoint, never per turn. One row per published
      -- version, so "what did this consumer read" is answerable after the fact.
      CREATE TABLE session_transcript_publications (
        session_id   TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        ordinal      INTEGER NOT NULL,
        through_turn INTEGER NOT NULL,
        trigger      TEXT NOT NULL CHECK (trigger IN ('checkpoint', 'session-end')),
        by_kind      TEXT CHECK (by_kind IN ('human', 'session')),
        by_session   TEXT,
        object_id    TEXT NOT NULL REFERENCES objects (id),
        version_id   TEXT NOT NULL REFERENCES object_versions (id),
        at           INTEGER NOT NULL,
        PRIMARY KEY (session_id, ordinal),
        -- A session end publishes on nobody's behalf; a checkpoint is a
        -- gesture, and §3.6 allows the session itself to make it.
        CHECK (
          (trigger = 'session-end' AND by_kind IS NULL) OR trigger = 'checkpoint'
        ),
        CHECK (
          (by_kind = 'session' AND by_session IS NOT NULL) OR
          (by_kind IS NOT 'session' AND by_session IS NULL)
        )
      );

      -- The injection ledger (§6.5): queue acceptance and delivery are two
      -- facts, kept apart, so the UI can show "queued" honestly instead of
      -- pretending the message landed.
      CREATE TABLE session_injections (
        id             TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        -- Steering is authored and leaves a permanent content node on the graph
        -- (§6.5, principle 5). World-condition feedback is the product
        -- answering a submission it checked itself — not authored context, so
        -- it has no author and no node, and the schema says which is which.
        origin         TEXT NOT NULL CHECK (origin IN ('steering', 'condition-feedback')),
        author_kind    TEXT CHECK (author_kind IN ('human', 'session')),
        author_session TEXT,
        node_id        TEXT REFERENCES nodes (id),
        text           TEXT NOT NULL,
        queued_at      INTEGER NOT NULL,
        delivered_at   INTEGER,
        refused_at     INTEGER,
        refused_reason TEXT,
        CHECK (
          (origin = 'steering' AND author_kind IS NOT NULL AND node_id IS NOT NULL) OR
          (origin = 'condition-feedback' AND author_kind IS NULL AND node_id IS NULL)
        ),
        CHECK (delivered_at IS NULL OR refused_at IS NULL),
        CHECK (
          (author_kind = 'session' AND author_session IS NOT NULL) OR
          (author_kind IS NOT 'session' AND author_session IS NULL)
        )
      );

      CREATE INDEX session_injections_session_idx
        ON session_injections (session_id, queued_at);

      -- The producing completion loop (§3.5, principle 3): a submission is
      -- checked against the declared world conditions, and a failing condition
      -- comes back as feedback while the session continues. Every attempt is
      -- recorded, whole — that is what makes "typical failures" answerable
      -- (§6.4) and what keeps proof point-in-time rather than re-derived.
      CREATE TABLE run_submissions (
        run_id           TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        ordinal          INTEGER NOT NULL,
        session_id       TEXT REFERENCES sessions (id) ON DELETE SET NULL,
        at               INTEGER NOT NULL,
        accepted         INTEGER NOT NULL,
        evaluations_json TEXT NOT NULL,
        feedback         TEXT,
        PRIMARY KEY (run_id, ordinal),
        CHECK (
          (accepted = 1 AND feedback IS NULL) OR
          (accepted = 0 AND feedback IS NOT NULL)
        )
      );

      -- Idempotent initiation (principle 9): one gesture is one run and one
      -- session, across retries and reconnects. The client supplies the key, so
      -- a resent request is recognisable as the same gesture rather than as a
      -- second one. Cascading with the run is deliberate: once run history has
      -- been compacted (§4.4) there is nothing left to hand a retry.
      CREATE TABLE run_initiations (
        initiation_key TEXT PRIMARY KEY,
        command_id     TEXT NOT NULL REFERENCES commands (id) ON DELETE CASCADE,
        run_id         TEXT REFERENCES runs (id) ON DELETE CASCADE,
        session_id     TEXT REFERENCES sessions (id) ON DELETE SET NULL,
        created_at     INTEGER NOT NULL,
        settled_at     INTEGER
      );

      CREATE INDEX run_initiations_command_idx ON run_initiations (command_id);
    `,
  },
  {
    id: 8,
    name: "arrangement_and_spend_caps",
    sql: `
      -- Durable placement (§5, Epic 3.1): the arrangement is authored state, so
      -- it belongs in the one portable store like everything else — the canvas
      -- kept it in the browser only because there was no server to keep it in.
      -- NULL means no authored position: a derived initial arrangement decides
      -- where such a node starts, and "reset arrangement" puts them all back to
      -- NULL rather than inventing coordinates of its own (§12).
      ALTER TABLE nodes ADD COLUMN x REAL;
      ALTER TABLE nodes ADD COLUMN y REAL;

      -- The spend cap the operator accepted at the run preview (§4.1, §8).
      -- Recorded on the run because it is part of what the run was authorised to
      -- do (§15-1): "what did we agree to spend on this" is unanswerable
      -- afterwards if only the estimate was ever written down. NULL means no cap
      -- was accepted; enforcing one is Phase 6's job, recording it is not.
      ALTER TABLE runs ADD COLUMN spend_cap_micros INTEGER;
    `,
  },
  {
    id: 9,
    name: "interrupted_runs",
    // The CHECK on runs.status has to change, and SQLite cannot alter one in
    // place, so the table is rebuilt — see `Migration.rebuildsTable` for why the
    // runner drops foreign keys around this one and checks them afterwards.
    rebuildsTable: true,
    sql: `
      -- A run whose session was interrupted (principle 11) was recorded as
      -- 'stopped' with the reason in failure_reason, because the taxonomy had
      -- nowhere else to put it. "Stopped" means somebody decided to stop it, and
      -- nobody did — so run history was saying something untrue about every run
      -- a restart caught in flight. The end-state taxonomy the session already
      -- keeps (§3.6) is now representable on the run too.
      CREATE TABLE runs_new (
        id                 TEXT PRIMARY KEY,
        command_id         TEXT NOT NULL REFERENCES commands (id) ON DELETE CASCADE,
        definition_id      TEXT NOT NULL REFERENCES command_definitions (id),
        ordinal            INTEGER NOT NULL,
        status             TEXT NOT NULL CHECK (status IN
                             ('running', 'completed', 'failed', 'out_of_budget',
                              'stopped', 'interrupted')),
        assembled_blob_id  TEXT NOT NULL REFERENCES blobs (id),
        assembled_hash     TEXT NOT NULL,
        assembled_bytes    INTEGER NOT NULL,
        config_json        TEXT NOT NULL,
        input_tokens       INTEGER NOT NULL DEFAULT 0,
        output_tokens      INTEGER NOT NULL DEFAULT 0,
        cost_micros        INTEGER NOT NULL DEFAULT 0,
        outcome_proof_json TEXT,
        failure_reason     TEXT,
        pinned             INTEGER NOT NULL DEFAULT 0,
        started_at         INTEGER NOT NULL DEFAULT (unixepoch()),
        ended_at           INTEGER,
        spend_cap_micros   INTEGER
      );

      -- Columns listed explicitly rather than SELECT *: a copy that depended on
      -- column order would break the first time one was added.
      INSERT INTO runs_new (
        id, command_id, definition_id, ordinal, status, assembled_blob_id,
        assembled_hash, assembled_bytes, config_json, input_tokens,
        output_tokens, cost_micros, outcome_proof_json, failure_reason, pinned,
        started_at, ended_at, spend_cap_micros
      )
      SELECT
        id, command_id, definition_id, ordinal, status, assembled_blob_id,
        assembled_hash, assembled_bytes, config_json, input_tokens,
        output_tokens, cost_micros, outcome_proof_json, failure_reason, pinned,
        started_at, ended_at, spend_cap_micros
      FROM runs;

      DROP TABLE runs;
      ALTER TABLE runs_new RENAME TO runs;

      -- Named this time, matching what schema.ts has always declared; migration
      -- 5 created the same constraint as an anonymous table-level UNIQUE.
      CREATE UNIQUE INDEX runs_ordinal_idx ON runs (command_id, ordinal);
      CREATE INDEX runs_definition_idx ON runs (definition_id, started_at);
      CREATE INDEX runs_retention_idx ON runs (pinned, started_at);
    `,
  },
  {
    id: 10,
    name: "feedback_conditions",
    sql: `
      -- §3.5's loop hands a failing condition back to the session, and the
      -- transcript entry for it names the conditions "rather than paraphrased"
      -- (§6.1's \`feedback\` entry kind). The feedback text is a sentence; these
      -- are the ids behind it, kept so the record can be read structurally
      -- instead of parsed back out of prose.
      --
      -- NULL for a steering injection, which fails no conditions because it
      -- proves nothing — it is somebody's intent (§6.5).
      ALTER TABLE session_injections ADD COLUMN failed_condition_ids_json TEXT;
    `,
  },
];
