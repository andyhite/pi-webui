import { sql } from "drizzle-orm";
import {
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Content storage is hybrid: bytes at or below INLINE_MAX_BYTES live in the
 * row, larger content spills to a content-addressed file under the state
 * directory's blobs/ tree. Callers never choose — see blob-store.ts.
 */
export const INLINE_MAX_BYTES = 64 * 1024;

export const blobs = sqliteTable(
  "blobs",
  {
    id: text("id").primaryKey(),
    /** sha256 of the bytes; identity for dedup. */
    hash: text("hash").notNull().unique(),
    size: integer("size").notNull(),
    encoding: text("encoding", { enum: ["utf8", "binary"] }).notNull(),
    /** What kind of content this is, for search filtering and reporting. */
    kind: text("kind").notNull(),
    /** Present when the content is stored inline (size <= INLINE_MAX_BYTES). */
    inlineBytes: blob("inline_bytes", { mode: "buffer" }),
    /** 1 when the bytes live in blobs/<hash> rather than inline. */
    isExternal: integer("is_external", { mode: "boolean" })
      .notNull()
      .default(false),
    /**
     * Spec §6.1: a long transcript releases its largest old tool outputs. The
     * row survives so the marker can be drawn and the content reloaded;
     * nothing is silently deleted.
     */
    releasedAt: integer("released_at"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("blobs_kind_idx").on(table.kind),
    index("blobs_size_idx").on(table.size),
  ],
);

/**
 * Explicit references make retention a query rather than a guess (spec §3.2,
 * §4.4): content referenced by any run or pinned run is retained, and
 * unreferenced content is what compaction may remove.
 */
export const blobRefs = sqliteTable(
  "blob_refs",
  {
    blobId: text("blob_id")
      .notNull()
      .references(() => blobs.id, { onDelete: "cascade" }),
    /** e.g. "run_input", "run_output", "transcript_part", "note_version". */
    ownerKind: text("owner_kind").notNull(),
    ownerId: text("owner_id").notNull(),
    /** 1 when this reference must never be compacted (a pinned run). */
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.blobId, table.ownerKind, table.ownerId] }),
    index("blob_refs_owner_idx").on(table.ownerKind, table.ownerId),
  ],
);

/**
 * Spec §3.1: one generic object table. Integrations populate the concepts that
 * exist; they never add new ones.
 */
export const objects = sqliteTable(
  "objects",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    scope: text("scope", { enum: ["world", "local"] }).notNull(),
    /** Set for local objects; null once promoted to world scope (§3.2). */
    workstreamId: text("workstream_id"),
    /** External identity survives re-reads, so refresh reconciles (§3.1). */
    externalSystem: text("external_system"),
    externalId: text("external_id"),
    title: text("title").notNull(),
    latestVersionId: text("latest_version_id"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
    promotedAt: integer("promoted_at"),
    /** Soft delete: authored state is recoverable (principle 10). */
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    uniqueIndex("objects_external_idx")
      .on(table.externalSystem, table.externalId)
      .where(sql`external_system IS NOT NULL`),
    index("objects_kind_idx").on(table.kind),
    index("objects_workstream_idx").on(table.workstreamId),
    index("objects_deleted_idx").on(table.deletedAt),
  ],
);

/**
 * Spec §3.2: a change to an object's content produces a new version. Retention
 * metadata (§15 invariant 3) is present from the first write — retrofitting it
 * leaves the product unable to say which past versions were safe to drop.
 */
export const objectVersions = sqliteTable(
  "object_versions",
  {
    id: text("id").primaryKey(),
    objectId: text("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    contentHash: text("content_hash").notNull(),
    contentBlobId: text("content_blob_id")
      .notNull()
      .references(() => blobs.id),
    cardJson: text("card_json").notNull(),
    summary: text("summary").notNull(),
    deltaSummary: text("delta_summary"),
    deltaBlobId: text("delta_blob_id").references(() => blobs.id),
    runReferenced: integer("run_referenced", { mode: "boolean" })
      .notNull()
      .default(false),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("object_versions_ordinal_idx").on(
      table.objectId,
      table.ordinal,
    ),
    index("object_versions_object_idx").on(table.objectId, table.ordinal),
    index("object_versions_retention_idx").on(
      table.runReferenced,
      table.pinned,
      table.createdAt,
    ),
  ],
);

/** A placed node on the graph: content, a command, or a session (§3.7). */
export const nodes = sqliteTable(
  "nodes",
  {
    id: text("id").primaryKey(),
    role: text("role", {
      enum: ["content", "command", "session"],
    }).notNull(),
    /** The object, command, or session this node stands for. */
    refId: text("ref_id").notNull(),
    workstreamId: text("workstream_id"),
    running: integer("running", { mode: "boolean" }).notNull().default(false),
    /**
     * Durable placement (§5). Null means no authored position: a derived
     * initial arrangement decides where the node starts, and resetting the
     * arrangement returns these to null rather than to coordinates of its own.
     */
    x: real("x"),
    y: real("y"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
    /** Soft delete: authored state is recoverable (principle 10). */
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    uniqueIndex("nodes_role_ref_idx").on(table.role, table.refId),
    index("nodes_workstream_idx").on(table.workstreamId),
  ],
);

/**
 * Context and provenance edges (§3.7).
 *
 * `authorKind` is NOT NULL by design — §15 invariant 2. Provenance edges are
 * recorded by the system rather than authored, and carry the reserved author
 * "system"; that is a statement about who recorded it, not an unknown.
 */
export const edges = sqliteTable(
  "edges",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["context", "provenance"] }).notNull(),
    fromNode: text("from_node")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    toNode: text("to_node")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    authorKind: text("author_kind", {
      enum: ["human", "session", "system"],
    }).notNull(),
    authorSession: text("author_session"),
    /** Context edges only: assembly order into the target (§3.5). */
    ordinal: integer("ordinal"),
    /** Provenance edges only: what the relationship means. */
    relation: text("relation"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    index("edges_to_idx").on(table.toNode, table.kind),
    index("edges_from_idx").on(table.fromNode, table.kind),
  ],
);

/**
 * Spec §3.3: the container between "a node" and "the graph". Subject and
 * lifecycle are authored; the attention columns cache the derived rollup for
 * the collapsed card and are never authored.
 */
export const workstreams = sqliteTable(
  "workstreams",
  {
    id: text("id").primaryKey(),
    /** Authored and optional; a subject-less scratch workstream is legal. */
    subjectObjectId: text("subject_object_id").references(() => objects.id),
    status: text("status", { enum: ["active", "done", "abandoned"] })
      .notNull()
      .default("active"),
    /** The archive gesture: off the board, searchable, recoverable (§3.3). */
    archivedAt: integer("archived_at"),
    attentionStatus: text("attention_status"),
    attentionJson: text("attention_json"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
    /**
     * Soft delete, distinct from the archive gesture: archived is "off the
     * board, still searchable, reported as archived"; deleted is "undone, and
     * undoable" (§3.3, principle 10).
     */
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    index("workstreams_board_idx").on(table.status, table.archivedAt),
    index("workstreams_deleted_idx").on(table.deletedAt),
  ],
);

/**
 * The attribution trail for authored workstream mutations (§3.3,
 * principle 10). No 'system' author exists here: the product only suggests.
 */
export const workstreamEvents = sqliteTable(
  "workstream_events",
  {
    id: text("id").primaryKey(),
    workstreamId: text("workstream_id")
      .notNull()
      .references(() => workstreams.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: [
        "created",
        "subject_set",
        "status_set",
        "archived",
        "unarchived",
        "deleted",
        "restored",
      ],
    }).notNull(),
    value: text("value"),
    authorKind: text("author_kind", { enum: ["human", "session"] }).notNull(),
    authorSession: text("author_session"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("workstream_events_stream_idx").on(
      table.workstreamId,
      table.createdAt,
    ),
  ],
);

/** Initiation chains; a null parent means a human gesture (principle 1). */
export const sessionLineage = sqliteTable(
  "session_lineage",
  {
    sessionId: text("session_id").primaryKey(),
    initiatedBy: text("initiated_by"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("session_lineage_parent_idx").on(table.initiatedBy)],
);

/**
 * Spec §3.5: reusable, editable content, not code. `outcomeJson` is present
 * exactly when the lifecycle is producing — the two lifecycles are a schema
 * constraint, not a convention (see migration 5).
 */
export const commandDefinitions = sqliteTable(
  "command_definitions",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    instruction: text("instruction").notNull(),
    model: text("model").notNull(),
    effort: text("effort", { enum: ["low", "medium", "high"] }).notNull(),
    permissionsJson: text("permissions_json").notNull(),
    askPointsJson: text("ask_points_json").notNull(),
    lifecycle: text("lifecycle", { enum: ["producing", "open"] }).notNull(),
    outcomeJson: text("outcome_json"),
    parametersJson: text("parameters_json").notNull(),
    budgetJson: text("budget_json").notNull(),
    source: text("source", { enum: ["builtin", "user", "plugin"] }).notNull(),
    /** Organization is authored: a user-named folder, or the top level. */
    folder: text("folder"),
    duplicatedFrom: text("duplicated_from"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql`(unixepoch())`),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    index("command_definitions_folder_idx").on(table.folder, table.name),
  ],
);

/** A command node: a definition plus its wiring, inside one workstream (§3.5). */
export const commands = sqliteTable(
  "commands",
  {
    id: text("id").primaryKey(),
    definitionId: text("definition_id")
      .notNull()
      .references(() => commandDefinitions.id),
    /** NOT NULL: a command never leaves its workstream (§3.3). */
    workstreamId: text("workstream_id")
      .notNull()
      .references(() => workstreams.id, { onDelete: "cascade" }),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    index("commands_workstream_idx").on(table.workstreamId),
    index("commands_definition_idx").on(table.definitionId),
  ],
);

/**
 * Spec §3.5: a derived default is a proposal the user confirms, never a guess
 * applied silently. A `proposed` row carries no `confirmedAt`, which is what
 * stops a reader from treating a proposal as a value.
 */
export const commandParameterBindings = sqliteTable(
  "command_parameter_bindings",
  {
    commandId: text("command_id")
      .notNull()
      .references(() => commands.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    state: text("state", { enum: ["proposed", "confirmed"] }).notNull(),
    valueJson: text("value_json").notNull(),
    derivedFrom: text("derived_from"),
    confirmedAt: integer("confirmed_at"),
  },
  (table) => [primaryKey({ columns: [table.commandId, table.name] })],
);

/**
 * Spec §3.5: a producing command's output exists before any run as a typed
 * placeholder and binds to what was produced after. `publishedAt` is the
 * publish verb; promoting the produced object is the other one (§3.2).
 */
export const commandOutputs = sqliteTable(
  "command_outputs",
  {
    id: text("id").primaryKey(),
    commandId: text("command_id")
      .notNull()
      .references(() => commands.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    structureJson: text("structure_json"),
    publishedAt: integer("published_at"),
    boundObjectId: text("bound_object_id").references(() => objects.id),
    boundRunId: text("bound_run_id"),
    boundAt: integer("bound_at"),
    /** Set when a pre-bind producer was deleted: visibly broken, never gone. */
    brokenAt: integer("broken_at"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("command_outputs_unique_name_idx").on(
      table.commandId,
      table.name,
    ),
    index("command_outputs_command_idx").on(table.commandId),
  ],
);

/**
 * Spec §15 invariant 1: the full assembled content AND the configuration.
 * Both are NOT NULL — a run that could exist without them is the uncomparable
 * record the invariant exists to prevent.
 *
 * Spec §15 invariant 4: `ordinal` is the n in output@n. No column here records
 * which run is latest; that is resolved by ordering.
 */
export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    commandId: text("command_id")
      .notNull()
      .references(() => commands.id, { onDelete: "cascade" }),
    definitionId: text("definition_id")
      .notNull()
      .references(() => commandDefinitions.id),
    ordinal: integer("ordinal").notNull(),
    status: text("status", {
      enum: [
        "running",
        "completed",
        "failed",
        "out_of_budget",
        "stopped",
        "interrupted",
      ],
    }).notNull(),
    assembledBlobId: text("assembled_blob_id")
      .notNull()
      .references(() => blobs.id),
    assembledHash: text("assembled_hash").notNull(),
    assembledBytes: integer("assembled_bytes").notNull(),
    configJson: text("config_json").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costMicros: integer("cost_micros").notNull().default(0),
    outcomeProofJson: text("outcome_proof_json"),
    failureReason: text("failure_reason"),
    /**
     * The cap the operator accepted at the preview (§4.1, §8). Null means none
     * was accepted; Phase 6 enforces it, and this records what was agreed.
     */
    spendCapMicros: integer("spend_cap_micros"),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    startedAt: integer("started_at")
      .notNull()
      .default(sql`(unixepoch())`),
    endedAt: integer("ended_at"),
  },
  (table) => [
    uniqueIndex("runs_ordinal_idx").on(table.commandId, table.ordinal),
    index("runs_definition_idx").on(table.definitionId, table.startedAt),
    index("runs_retention_idx").on(table.pinned, table.startedAt),
  ],
);

/**
 * The exact ordered content that went in (§15 invariant 1). The version
 * foreign key is what makes §15 invariant 3's interplay enforced rather than
 * hoped for: a version a run consumed cannot be deleted while the run exists.
 */
export const runInputs = sqliteTable(
  "run_inputs",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    nodeId: text("node_id"),
    objectId: text("object_id")
      .notNull()
      .references(() => objects.id),
    versionId: text("version_id")
      .notNull()
      .references(() => objectVersions.id),
    contentHash: text("content_hash").notNull(),
    bytes: integer("bytes").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.ordinal] }),
    index("run_inputs_version_idx").on(table.versionId),
  ],
);

/** Spec §15 invariant 4: one row per produced output, per run. */
export const runOutputs = sqliteTable(
  "run_outputs",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    objectId: text("object_id")
      .notNull()
      .references(() => objects.id),
    versionId: text("version_id")
      .notNull()
      .references(() => objectVersions.id),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.name] }),
    index("run_outputs_name_idx").on(table.name, table.runId),
  ],
);

/**
 * One workstream's workspace (§3.4). The boundary — exactly one live workspace
 * per workstream, and no path shared across workstreams — is a predicate in
 * `@plotroom/core`; the partial unique index in migration 7 is the same rule
 * made unrepresentable. Timestamps here are milliseconds, matching the
 * workspace record's own vocabulary.
 */
export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    workstreamId: text("workstream_id")
      .notNull()
      .references(() => workstreams.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    /** Opaque to the product; the kind validated it (§10.1). */
    configJson: text("config_json").notNull(),
    rootsJson: text("roots_json").notNull().default("[]"),
    /** The readiness record whole, last setup attempt's output included. */
    readinessJson: text("readiness_json").notNull(),
    createdByKind: text("created_by_kind", {
      enum: ["human", "session"],
    }).notNull(),
    createdBySession: text("created_by_session"),
    createdAt: integer("created_at").notNull(),
    /** Null until the first run provisions it (§3.4, §3.5). */
    provisionedAt: integer("provisioned_at"),
    provisionCostJson: text("provision_cost_json"),
    lastFingerprintJson: text("last_fingerprint_json"),
    removedAt: integer("removed_at"),
  },
  (table) => [
    uniqueIndex("workspaces_workstream_idx")
      .on(table.workstreamId)
      .where(sql`removed_at IS NULL`),
  ],
);

/**
 * Spec §3.6: a session is a live or completed agent run inside a workstream,
 * and one record either way. Everything derived from observation — the phase,
 * the accounting totals — is a snapshot here; `session_observations` is the
 * truth it folds from, so a restart recomputes rather than trusts it
 * (principle 7).
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    workstreamId: text("workstream_id")
      .notNull()
      .references(() => workstreams.id, { onDelete: "cascade" }),
    commandId: text("command_id").references(() => commands.id),
    /**
     * Run retention (§4.4) may reclaim the run; a session record is readable,
     * resumable, and forkable *always* (§3.6), so the link goes null and the
     * record stays rather than the reverse.
     */
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    workspaceId: text("workspace_id").references(() => workspaces.id),
    mode: text("mode", { enum: ["producing", "open"] }).notNull(),
    model: text("model").notNull(),
    effort: text("effort", {
      enum: ["off", "minimal", "low", "medium", "high", "max"],
    }).notNull(),
    /** Null inherits the app's tools; a list narrows them, never widens (§3.6). */
    allowedToolsJson: text("allowed_tools_json"),
    initiatedByKind: text("initiated_by_kind", {
      enum: ["human", "session"],
    }).notNull(),
    initiatedBySession: text("initiated_by_session"),
    adapterId: text("adapter_id").notNull(),
    runtimeRef: text("runtime_ref").notNull(),
    /**
     * How a forked session came to exist: the branch that actually ran, `native` or
     * `seeded` (§6.3). Null for a session that is not a fork.
     */
    runtimeMode: text("runtime_mode", { enum: ["native", "seeded"] }),
    /** The transcript as content (§3.6): versioned on the checkpoint rule. */
    transcriptObjectId: text("transcript_object_id").references(
      () => objects.id,
    ),
    /** Derived by PlotRoom, never agent-reported (principle 7). */
    phaseJson: text("phase_json").notNull(),
    turns: integer("turns").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    /** Integer micros, like `runs.cost_micros`: spend is never a float row. */
    costMicros: integer("cost_micros").notNull().default(0),
    costBasis: text("cost_basis", {
      enum: ["runtime-reported", "priced-from-tokens", "none"],
    })
      .notNull()
      .default("none"),
    contextUsedTokens: integer("context_used_tokens"),
    contextMaxTokens: integer("context_max_tokens"),
    contextBasis: text("context_basis", { enum: ["reported", "estimated"] }),
    startedAt: integer("started_at").notNull(),
    lastActivityAt: integer("last_activity_at").notNull(),
    /**
     * The closed taxonomy (§3.6, principle 11): out-of-budget is distinct from
     * failed, interrupted from both, and a null `endKind` is what live means.
     */
    endKind: text("end_kind", {
      enum: [
        "completed",
        "ended-by-user",
        "stopped",
        "out-of-budget",
        "failed",
        "interrupted",
      ],
    }),
    endJson: text("end_json"),
    endedAt: integer("ended_at"),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    index("sessions_workstream_idx").on(table.workstreamId),
    index("sessions_command_idx").on(table.commandId),
    index("sessions_run_idx").on(table.runId),
    index("sessions_live_idx").on(table.endKind, table.deletedAt),
  ],
);

/**
 * PlotRoom's own observation records — not vendor payloads (§3.6, decision
 * 0001). Phases, accounting, transcripts, resume, and fork are all derived
 * from this log, so all of them survive vendor churn.
 */
export const sessionObservations = sqliteTable(
  "session_observations",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** 1-based per session; the ordering primitive. */
    seq: integer("seq").notNull(),
    /** Milliseconds, as the adapter stamped it at observation time. */
    at: integer("at").notNull(),
    kind: text("kind").notNull(),
    observationJson: text("observation_json").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.seq] }),
    index("session_observations_kind_idx").on(table.sessionId, table.kind),
  ],
);

/** One published transcript version — the checkpoint rule's record (§3.6). */
export const sessionTranscriptPublications = sqliteTable(
  "session_transcript_publications",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    throughTurn: integer("through_turn").notNull(),
    trigger: text("trigger", {
      enum: ["checkpoint", "session-end"],
    }).notNull(),
    byKind: text("by_kind", { enum: ["human", "session"] }),
    bySession: text("by_session"),
    objectId: text("object_id")
      .notNull()
      .references(() => objects.id),
    versionId: text("version_id")
      .notNull()
      .references(() => objectVersions.id),
    at: integer("at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.ordinal] })],
);

/**
 * The injection ledger (§6.5): queue acceptance and delivery are two facts,
 * kept apart, so "queued" is honest instead of optimistic. `origin`
 * distinguishes authored steering — which leaves a permanent content node —
 * from the product's own world-condition feedback, which authors nothing.
 */
export const sessionInjections = sqliteTable(
  "session_injections",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    origin: text("origin", {
      enum: ["steering", "condition-feedback", "budget-notice"],
    }).notNull(),
    authorKind: text("author_kind", { enum: ["human", "session"] }),
    authorSession: text("author_session"),
    nodeId: text("node_id").references(() => nodes.id),
    text: text("text").notNull(),
    /**
     * The declared conditions behind a `condition-feedback` entry, named so the
     * transcript can render them structurally (§3.5, §6.1). Null for steering,
     * which proves nothing and so fails nothing.
     */
    failedConditionIdsJson: text("failed_condition_ids_json"),
    queuedAt: integer("queued_at").notNull(),
    deliveredAt: integer("delivered_at"),
    refusedAt: integer("refused_at"),
    refusedReason: text("refused_reason"),
  },
  (table) => [
    index("session_injections_session_idx").on(table.sessionId, table.queuedAt),
  ],
);

/**
 * The producing completion loop (§3.5, principle 3): every submission attempt,
 * with what was checked and what held. Proof is point-in-time and recorded on
 * the run; this is the record of how many tries it took and why.
 */
export const runSubmissions = sqliteTable(
  "run_submissions",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    at: integer("at").notNull(),
    accepted: integer("accepted", { mode: "boolean" }).notNull(),
    evaluationsJson: text("evaluations_json").notNull(),
    feedback: text("feedback"),
  },
  (table) => [primaryKey({ columns: [table.runId, table.ordinal] })],
);

/**
 * Idempotent initiation (principle 9): one gesture is one run and one session,
 * across retries and reconnects. The key is client-supplied, so a resent
 * request is recognisable as the same gesture rather than as a second one.
 */
export const runInitiations = sqliteTable(
  "run_initiations",
  {
    initiationKey: text("initiation_key").primaryKey(),
    /**
     * The command this initiation ran, or null where there was no command: a fork,
     * a handoff, and a resume each spend a key without producing a run (§6.3).
     */
    commandId: text("command_id").references(() => commands.id, {
      onDelete: "cascade",
    }),
    runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    /**
     * Which gesture spent this key (§6.3, §4.1). Compared on every claim, because a
     * key is one *gesture* and a run of a command is not a fork of one of its
     * sessions however much they agree about the command.
     */
    kind: text("kind", {
      enum: ["run", "resume", "fork", "handoff"],
    })
      .notNull()
      .default("run"),
    /**
     * What the gesture was about: the session a resume resumes, the source a fork
     * forks, the brief a handoff sends. Null for a run, whose subject is the command
     * `commandId` already names.
     *
     * Compared on every claim. A settled key that named only its kind and its
     * command named only part of its gesture, and the part it left out is what a
     * reused key silently corrupted.
     */
    subjectId: text("subject_id"),
    createdAt: integer("created_at").notNull(),
    settledAt: integer("settled_at"),
  },
  (table) => [index("run_initiations_command_idx").on(table.commandId)],
);

/**
 * Path claims at rest (§3.4, migration 11).
 *
 * `@plotroom/core`'s `ClaimState` plus its `ClaimEffect` list is the persistence
 * contract; these tables are that state's rows and nothing more. No rule is
 * restated here — the claim manager decides, `ClaimStore` applies the effects.
 */
export const claims = sqliteTable(
  "claims",
  {
    id: text("id").primaryKey(),
    workstreamId: text("workstream_id")
      .notNull()
      .references(() => workstreams.id, { onDelete: "cascade" }),
    /** Canonical, NFC-normalized, case-folded. The workspace root is "". */
    pathKey: text("path_key").notNull(),
    pathDisplay: text("path_display").notNull(),
    holderKind: text("holder_kind", { enum: ["human", "session"] }).notNull(),
    holderSession: text("holder_session").references(() => sessions.id, {
      onDelete: "cascade",
    }),
    /** Null only for the workstream's root claim, held by the operator. */
    grantedFromClaimId: text("granted_from_claim_id"),
    grantedByKind: text("granted_by_kind", {
      enum: ["human", "session"],
    }).notNull(),
    grantedBySession: text("granted_by_session"),
    grantedAt: integer("granted_at").notNull(),
    lastActivityAt: integer("last_activity_at").notNull(),
    /** Null is forever, and only the root claim may be (`violatesLeasePolicy`). */
    leaseSeconds: integer("lease_seconds"),
    releasedAt: integer("released_at"),
    releaseReason: text("release_reason"),
  },
  (table) => [
    index("claims_live_idx").on(table.workstreamId, table.releasedAt),
    index("claims_holder_idx").on(table.holderSession, table.releasedAt),
  ],
);

export const claimWaits = sqliteTable(
  "claim_waits",
  {
    id: text("id").primaryKey(),
    workstreamId: text("workstream_id")
      .notNull()
      .references(() => workstreams.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    pathKey: text("path_key").notNull(),
    pathDisplay: text("path_display").notNull(),
    since: integer("since").notNull(),
    /** Availability, the first of a wait's two independent gates. */
    blockedByJson: text("blocked_by_json").notNull().default("[]"),
    grantorClaimId: text("grantor_claim_id"),
    /** Authorization, the second gate: settled by policy or by an answer. */
    authorizedAt: integer("authorized_at"),
    requestedLeaseSeconds: integer("requested_lease_seconds"),
    removedAt: integer("removed_at"),
    removedReason: text("removed_reason"),
  },
  (table) => [
    index("claim_waits_live_idx").on(table.workstreamId, table.removedAt),
    index("claim_waits_session_idx").on(table.sessionId, table.removedAt),
  ],
);

export const claimPolicies = sqliteTable(
  "claim_policies",
  {
    id: text("id").primaryKey(),
    claimId: text("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    subtreeKey: text("subtree_key").notNull(),
    subtreeDisplay: text("subtree_display").notNull(),
    effect: text("effect", { enum: ["allow", "deny"] }).notNull(),
    pattern: text("pattern").notNull(),
    declaredAt: integer("declared_at").notNull(),
    withdrawnAt: integer("withdrawn_at"),
    withdrawReason: text("withdraw_reason"),
  },
  (table) => [
    index("claim_policies_claim_idx").on(table.claimId, table.withdrawnAt),
  ],
);

/**
 * The write ledger §3.4's claim-precise divergence needs. Without these rows
 * `checkClaimContinuation` keeps Epic 4.3's conservative verdict, because
 * narrowing from an incomplete record would be inference (principle 7).
 */
export const pathWrites = sqliteTable(
  "path_writes",
  {
    id: text("id").primaryKey(),
    workstreamId: text("workstream_id")
      .notNull()
      .references(() => workstreams.id, { onDelete: "cascade" }),
    pathKey: text("path_key").notNull(),
    pathDisplay: text("path_display").notNull(),
    holderKind: text("holder_kind", { enum: ["human", "session"] }).notNull(),
    holderSession: text("holder_session"),
    /** Null for the operator's implicit holding of everything. */
    claimId: text("claim_id").references(() => claims.id, {
      onDelete: "set null",
    }),
    at: integer("at").notNull(),
  },
  (table) => [
    index("path_writes_workstream_idx").on(table.workstreamId, table.at),
  ],
);

export const pathReads = sqliteTable(
  "path_reads",
  {
    id: text("id").primaryKey(),
    workstreamId: text("workstream_id")
      .notNull()
      .references(() => workstreams.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    pathKey: text("path_key").notNull(),
    pathDisplay: text("path_display").notNull(),
    at: integer("at").notNull(),
  },
  (table) => [index("path_reads_session_idx").on(table.sessionId, table.at)],
);

/**
 * Spend attributed up the initiating chain (§3.6, principle 2, migrations 12 and
 * 22). One row per (charged session, spender, **cause**): re-attributing a grown
 * accounting total replaces that row rather than adding a second one, while two
 * broadcasts' induced charges stay two rows because they are two charges.
 */
export const spendAttributions = sqliteTable(
  "spend_attributions",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    sourceSessionId: text("source_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    workstreamId: text("workstream_id")
      .notNull()
      .references(() => workstreams.id, { onDelete: "cascade" }),
    basis: text("basis", { enum: ["own", "descendant"] }).notNull(),
    amountMicros: integer("amount_micros").notNull(),
    costBasis: text("cost_basis", { enum: ["reported", "priced"] }).notNull(),
    /**
     * Why this row exists, and therefore what its amount means (migration 22):
     * `accounting` restates a spender's cumulative total, a `broadcast:<id>` row
     * is one broadcast's induced increment (§6.5). Part of the key, because
     * sharing one let either kind silently replace the other.
     */
    cause: text("cause").notNull(),
    at: integer("at").notNull(),
  },
  (table) => [
    index("spend_attributions_session_idx").on(table.sessionId),
    index("spend_attributions_source_idx").on(table.sourceSessionId),
    index("spend_attributions_workstream_idx").on(table.workstreamId),
    uniqueIndex("spend_attributions_charge_idx").on(
      table.sessionId,
      table.sourceSessionId,
      table.cause,
    ),
  ],
);

/**
 * Budgets at workstream and global scope (§8, migration 20).
 *
 * The run/batch scope is deliberately absent: a run's cap is what was accepted at
 * its preview and lives on the run (§4.1). `limitMicros` is NOT NULL because
 * removing a budget deletes the row — "raise or remove" is two verbs, not a
 * nullable number that also means removed.
 */
export const budgets = sqliteTable(
  "budgets",
  {
    id: text("id").primaryKey(),
    scope: text("scope", { enum: ["workstream", "global"] }).notNull(),
    workstreamId: text("workstream_id").references(() => workstreams.id, {
      onDelete: "cascade",
    }),
    limitMicros: integer("limit_micros").notNull(),
    period: text("period", { enum: ["day", "total"] }).notNull(),
    warnFraction: real("warn_fraction").notNull(),
    origin: text("origin", {
      enum: ["shipped-default", "authored"],
    }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    // Both are **partial**, exactly as migration 20 creates them: one global
    // ceiling, and one budget per workstream. Declared with their predicates
    // rather than as plain unique indexes — an unqualified unique on `scope` would
    // claim "one workstream budget in the whole store", which is neither what the
    // store enforces nor what this file should say it does.
    uniqueIndex("budgets_global_idx")
      .on(table.scope)
      .where(sql`${table.scope} = 'global'`),
    uniqueIndex("budgets_workstream_idx")
      .on(table.workstreamId)
      .where(sql`${table.workstreamId} is not null`),
  ],
);

/**
 * What a session has already been told about a budget (§8, migration 20).
 *
 * Rows rather than a counter, for the reason the broadcast rate window is rows: a
 * restart between the warning and the cap must not warn the session twice, and
 * "have I already told it?" cannot be answered from memory.
 */
export const budgetNotices = sqliteTable(
  "budget_notices",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    bindingKind: text("binding_kind", {
      enum: ["run", "batch", "workstream", "global"],
    }).notNull(),
    bindingId: text("binding_id").notNull(),
    kind: text("kind", { enum: ["near-cap", "stopped"] }).notNull(),
    remainingMicros: integer("remaining_micros").notNull(),
    at: integer("at").notNull(),
  },
  (table) => [
    uniqueIndex("budget_notices_once_idx").on(
      table.sessionId,
      table.bindingKind,
      table.bindingId,
      table.kind,
    ),
  ],
);

/** One scoped gesture over many commands (§4.1, migration 13). */
export const runBatches = sqliteTable("run_batches", {
  id: text("id").primaryKey(),
  initiationKey: text("initiation_key").notNull().unique(),
  scopeKind: text("scope_kind", {
    enum: ["one", "subgraph", "missing", "drifted-workstream", "drifted-fleet"],
  }).notNull(),
  scopeId: text("scope_id"),
  state: text("state", {
    enum: ["running", "paused", "aborted", "completed"],
  }).notNull(),
  pauseReason: text("pause_reason"),
  actorKind: text("actor_kind", { enum: ["human", "session"] }).notNull(),
  actorSession: text("actor_session"),
  spendCapMicros: integer("spend_cap_micros"),
  createdAt: integer("created_at").notNull(),
  settledAt: integer("settled_at"),
});

/**
 * The concurrency queue (§4.1): admission of already-initiated work. Every
 * entry carries the contract it was admitted under, because "a queued run
 * executes exactly what it previewed".
 */
export const runQueue = sqliteTable(
  "run_queue",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id")
      .notNull()
      .references(() => runBatches.id, { onDelete: "cascade" }),
    commandId: text("command_id")
      .notNull()
      .references(() => commands.id, { onDelete: "cascade" }),
    initiationKey: text("initiation_key").notNull().unique(),
    position: integer("position").notNull(),
    state: text("state", {
      enum: [
        "queued",
        "starting",
        "running",
        "needs_reask",
        "done",
        "failed",
        /** A restart caught its session in flight; not done and not failed. */
        "interrupted",
        "cancelled",
        "paused",
      ],
    }).notNull(),
    contractHash: text("contract_hash").notNull(),
    contractJson: text("contract_json").notNull(),
    spendCapMicros: integer("spend_cap_micros"),
    /**
     * The runtime the caller named, if any. Part of what was asked for, so it
     * travels with the entry: running the same content on a different runtime is
     * a different run (§4.1).
     */
    runtimeJson: text("runtime_json"),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    detail: text("detail"),
    enqueuedAt: integer("enqueued_at").notNull(),
    startedAt: integer("started_at"),
    settledAt: integer("settled_at"),
  },
  (table) => [
    index("run_queue_state_idx").on(
      table.state,
      table.position,
      table.enqueuedAt,
    ),
    index("run_queue_batch_idx").on(table.batchId, table.position),
    index("run_queue_command_idx").on(table.commandId),
  ],
);

/**
 * Structured questions at rest (§6.4, migration 16).
 *
 * There is deliberately no default/fallback/on-timeout column: §6.4's prohibition
 * is structural in `@plotroom/core`, and a column for one here is where it would
 * come back.
 */
export const sessionQuestions = sqliteTable(
  "session_questions",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** The blocked runtime request; null when the question arrived over HTTP. */
    requestId: text("request_id"),
    text: text("text").notNull(),
    optionsJson: text("options_json").notNull(),
    freeForm: text("free_form", { enum: ["none", "allowed"] }).notNull(),
    /** Escalation only — never resolution (§6.4, principle 2). */
    attentionJson: text("attention_json"),
    askedAt: integer("asked_at").notNull(),
    answerOptionId: text("answer_option_id"),
    answerText: text("answer_text"),
    answerByKind: text("answer_by_kind", { enum: ["human"] }),
    answeredAt: integer("answered_at"),
  },
  (table) => [
    index("session_questions_session_idx").on(table.sessionId, table.askedAt),
    uniqueIndex("session_questions_request_idx")
      .on(table.requestId)
      .where(sql`${table.requestId} IS NOT NULL`),
  ],
);

/** One broadcast: one content object, whatever the number of recipients (§6.5). */
export const broadcasts = sqliteTable(
  "broadcasts",
  {
    id: text("id").primaryKey(),
    origin: text("origin", { enum: ["human", "session"] }).notNull(),
    senderSessionId: text("sender_session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    category: text("category", {
      enum: ["material-state-changed", "shared-resource-warning"],
    }),
    /** A session declares a scope; the operator names a target. Never both. */
    scopeJson: text("scope_json"),
    targetJson: text("target_json"),
    authorKind: text("author_kind", { enum: ["human", "session"] }).notNull(),
    authorSession: text("author_session"),
    text: text("text").notNull(),
    objectId: text("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    at: integer("at").notNull(),
  },
  (table) => [
    index("broadcasts_sender_idx").on(table.senderSessionId, table.at),
  ],
);

/**
 * Who received one, and the injection each receipt became. Also §7.3's
 * per-workstream activity: the workstream is on the row, so the history is a
 * query rather than a second table that could disagree with this one.
 */
export const broadcastRecipients = sqliteTable(
  "broadcast_recipients",
  {
    broadcastId: text("broadcast_id")
      .notNull()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    workstreamId: text("workstream_id")
      .notNull()
      .references(() => workstreams.id, { onDelete: "cascade" }),
    injectionId: text("injection_id").notNull(),
    /** What this recipient had spent when the broadcast reached it (§6.5). */
    baselineCostMicros: integer("baseline_cost_micros").notNull().default(0),
    /** Null until the induced turn was observed and charged; charged once. */
    inducedMicros: integer("induced_micros"),
  },
  (table) => [
    primaryKey({ columns: [table.broadcastId, table.sessionId] }),
    index("broadcast_recipients_workstream_idx").on(table.workstreamId),
  ],
);

/** The per-sender rate window (§6.5): a count cannot answer "in the last hour". */
export const broadcastSends = sqliteTable(
  "broadcast_sends",
  {
    id: text("id").primaryKey(),
    senderSessionId: text("sender_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    at: integer("at").notNull(),
  },
  (table) => [
    index("broadcast_sends_sender_idx").on(table.senderSessionId, table.at),
  ],
);

/**
 * Handoff briefs (§6.3), drafted and reviewed in one table because the
 * transition is the point: only a reviewed brief may be sent, which core makes a
 * type error and the schema makes unrepresentable.
 */
export const handoffBriefs = sqliteTable(
  "handoff_briefs",
  {
    id: text("id").primaryKey(),
    sourceSessionId: text("source_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    origin: text("origin", {
      enum: ["session-written", "derived"],
    }).notNull(),
    /** Null for a derived brief: the product extracted it and nobody wrote it. */
    draftedByKind: text("drafted_by_kind", { enum: ["human", "session"] }),
    draftedBySession: text("drafted_by_session"),
    draftedAt: integer("drafted_at").notNull(),
    reviewedByKind: text("reviewed_by_kind", { enum: ["human"] }),
    reviewedAt: integer("reviewed_at"),
    /** The draft as written, kept when the human rewrote it, and whether they did. */
    draftText: text("draft_text"),
    edited: integer("edited", { mode: "boolean" }),
    sentAt: integer("sent_at"),
  },
  (table) => [
    index("handoff_briefs_session_idx").on(
      table.sourceSessionId,
      table.draftedAt,
    ),
  ],
);

/**
 * Approvals (§6.6). The record outlives the call it blocks, which is why it is a
 * row: a surface that asked the runtime what it wanted permission for would have
 * nothing to show once the call settled.
 */
export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    workstreamId: text("workstream_id")
      .notNull()
      .references(() => workstreams.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["tool-permission", "claim", "destruction", "integration-write"],
    }).notNull(),
    /** The ask whole, as core built it — one value to every reader. */
    askJson: text("ask_json").notNull(),
    /** The blocked runtime request, when one is behind this ask. */
    requestId: text("request_id"),
    /** The adapter's call id, which is what the gate matches against. */
    callId: text("call_id"),
    /** The pre-grant irreversibility pierced, so the operator is told which rule. */
    piercedJson: text("pierced_json"),
    raisedAt: integer("raised_at").notNull(),
    answerDecision: text("answer_decision", {
      enum: ["approve-once", "deny"],
    }),
    answerReason: text("answer_reason"),
    answerByKind: text("answer_by_kind", { enum: ["human"] }),
    answeredAt: integer("answered_at"),
  },
  (table) => [
    index("approvals_session_idx").on(table.sessionId, table.raisedAt),
    uniqueIndex("approvals_call_idx")
      .on(table.sessionId, table.callId)
      .where(sql`${table.callId} IS NOT NULL`),
  ],
);

/** Capability granted (or refused) in advance, by a human (§6.6). */
export const preGrants = sqliteTable(
  "pre_grants",
  {
    id: text("id").primaryKey(),
    scope: text("scope", { enum: ["session", "workstream"] }).notNull(),
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "cascade",
    }),
    workstreamId: text("workstream_id").references(() => workstreams.id, {
      onDelete: "cascade",
    }),
    effect: text("effect", { enum: ["allow", "deny"] }).notNull(),
    kindsJson: text("kinds_json").notNull(),
    toolPattern: text("tool_pattern").notNull(),
    extentsJson: text("extents_json").notNull(),
    grantedBy: text("granted_by", { enum: ["human"] }).notNull(),
    grantedAt: integer("granted_at").notNull(),
    /** Withdrawn, never deleted: "revoked" and "never granted" differ. */
    withdrawnAt: integer("withdrawn_at"),
  },
  (table) => [
    index("pre_grants_session_idx")
      .on(table.sessionId)
      .where(sql`${table.sessionId} IS NOT NULL`),
    index("pre_grants_workstream_idx")
      .on(table.workstreamId)
      .where(sql`${table.workstreamId} IS NOT NULL`),
  ],
);

/**
 * Triage for every attention feed (§4.5), keyed by the item's own stable id —
 * one ledger, extended from drift rather than duplicated per feed.
 */
export const attentionTriage = sqliteTable(
  "attention_triage",
  {
    itemId: text("item_id").notNull(),
    /** Whose baseline this advances; the operator today (§4.5). */
    consumer: text("consumer").notNull(),
    verb: text("verb", {
      enum: ["acknowledge", "snooze", "mute"],
    }).notNull(),
    at: integer("at").notNull(),
    byKind: text("by_kind", { enum: ["human", "session"] }).notNull(),
    bySession: text("by_session"),
    baselineVersionId: text("baseline_version_id"),
    snoozedUntil: integer("snoozed_until"),
  },
  (table) => [primaryKey({ columns: [table.itemId, table.consumer] })],
);

/**
 * An outbound notification route (§7.3). It attaches to a **state**; there is
 * deliberately no node, session, or workstream column beside `state`.
 */
export const notificationRoutes = sqliteTable("notification_routes", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  state: text("state", {
    enum: ["blocked", "failed", "wants-decision", "anything"],
  }).notNull(),
  destinationKind: text("destination_kind", { enum: ["webhook"] }).notNull(),
  destinationUrl: text("destination_url").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  /** Route health: a broken destination is reported, never thrown (§7.3). */
  lastAttemptAt: integer("last_attempt_at"),
  lastSuccessAt: integer("last_success_at"),
  lastFailureAt: integer("last_failure_at"),
  lastFailureReason: text("last_failure_reason"),
  consecutiveFailures: integer("consecutive_failures").notNull(),
});

/** What each route already sent, so the edge trigger survives a restart. */
export const notificationRouteFires = sqliteTable(
  "notification_route_fires",
  {
    routeId: text("route_id")
      .notNull()
      .references(() => notificationRoutes.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    firedAt: integer("fired_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.routeId, table.itemId] })],
);

export type ApprovalRow = typeof approvals.$inferSelect;
export type PreGrantRow = typeof preGrants.$inferSelect;
export type AttentionTriageRow = typeof attentionTriage.$inferSelect;
export type NotificationRouteRow = typeof notificationRoutes.$inferSelect;
export type NotificationRouteFireRow =
  typeof notificationRouteFires.$inferSelect;
export type NodeRow = typeof nodes.$inferSelect;
export type WorkstreamRow = typeof workstreams.$inferSelect;
export type WorkstreamEventRow = typeof workstreamEvents.$inferSelect;
export type EdgeRow = typeof edges.$inferSelect;
export type SessionLineageRow = typeof sessionLineage.$inferSelect;
export type BlobRow = typeof blobs.$inferSelect;
export type BlobRefRow = typeof blobRefs.$inferSelect;
export type ObjectRow = typeof objects.$inferSelect;
export type ObjectVersionRow = typeof objectVersions.$inferSelect;
export type CommandDefinitionRow = typeof commandDefinitions.$inferSelect;
export type CommandRow = typeof commands.$inferSelect;
export type CommandParameterBindingRow =
  typeof commandParameterBindings.$inferSelect;
export type CommandOutputRow = typeof commandOutputs.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type RunInputRow = typeof runInputs.$inferSelect;
export type RunOutputRow = typeof runOutputs.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type SessionObservationRow = typeof sessionObservations.$inferSelect;
export type SessionTranscriptPublicationRow =
  typeof sessionTranscriptPublications.$inferSelect;
export type SessionInjectionRow = typeof sessionInjections.$inferSelect;
export type RunSubmissionRow = typeof runSubmissions.$inferSelect;
export type RunInitiationRow = typeof runInitiations.$inferSelect;
export type ClaimRow = typeof claims.$inferSelect;
export type ClaimWaitRow = typeof claimWaits.$inferSelect;
export type ClaimPolicyRow = typeof claimPolicies.$inferSelect;
export type PathWriteRow = typeof pathWrites.$inferSelect;
export type PathReadRow = typeof pathReads.$inferSelect;
export type SpendAttributionRow = typeof spendAttributions.$inferSelect;
export type BudgetRow = typeof budgets.$inferSelect;
export type BudgetNoticeRow = typeof budgetNotices.$inferSelect;
export type RunBatchRow = typeof runBatches.$inferSelect;
export type RunQueueRow = typeof runQueue.$inferSelect;
export type SessionQuestionRow = typeof sessionQuestions.$inferSelect;
export type BroadcastRow = typeof broadcasts.$inferSelect;
export type BroadcastRecipientRow = typeof broadcastRecipients.$inferSelect;
export type BroadcastSendRow = typeof broadcastSends.$inferSelect;
export type HandoffBriefRow = typeof handoffBriefs.$inferSelect;
