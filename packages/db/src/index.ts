/**
 * @plotroom/db — durable, portable state (spec §12).
 *
 * SQLite in a single file plus a content-addressed blobs/ tree, together in one
 * state directory that is the unit of backup and movement. Access is via
 * Drizzle; content goes through BlobStore, which hides the inline/external
 * split. Search is an index-only FTS5 table populated on write.
 *
 * The schema must satisfy the four §15 invariants from day one:
 *   1. runs store the full assembled content AND the configuration used
 *   2. edges.author_id is NOT NULL and distinguishes human vs session
 *   3. versions carry retention metadata so compaction is implementable
 *   4. outputs are addressed per run; `latest` is a derived view
 */

export * from "./client.js";
export * from "./errors.js";
export * from "./paths.js";
export * from "./schema.js";
export * from "./blob-store.js";
export * from "./search.js";
export * from "./object-store.js";
export * from "./graph-store.js";
export * from "./workstream-store.js";
export * from "./command-store.js";
export * from "./run-store.js";
export * from "./workspace-store.js";
export * from "./session-transcript.js";
export * from "./session-store.js";
export { migrations, type Migration } from "./migrations.js";
