import { sql } from "drizzle-orm";
import {
  blob,
  index,
  integer,
  primaryKey,
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
  },
  (table) => [
    uniqueIndex("objects_external_idx")
      .on(table.externalSystem, table.externalId)
      .where(sql`external_system IS NOT NULL`),
    index("objects_kind_idx").on(table.kind),
    index("objects_workstream_idx").on(table.workstreamId),
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
  },
  (table) => [
    index("workstreams_board_idx").on(table.status, table.archivedAt),
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
      enum: ["created", "subject_set", "status_set", "archived", "unarchived"],
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
      enum: ["running", "completed", "failed", "out_of_budget", "stopped"],
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
