import { sql } from "drizzle-orm";
import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
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

export type BlobRow = typeof blobs.$inferSelect;
export type BlobRefRow = typeof blobRefs.$inferSelect;
