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

export type NodeRow = typeof nodes.$inferSelect;
export type EdgeRow = typeof edges.$inferSelect;
export type SessionLineageRow = typeof sessionLineage.$inferSelect;
export type BlobRow = typeof blobs.$inferSelect;
export type BlobRefRow = typeof blobRefs.$inferSelect;
export type ObjectRow = typeof objects.$inferSelect;
export type ObjectVersionRow = typeof objectVersions.$inferSelect;
