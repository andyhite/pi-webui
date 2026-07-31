/**
 * @plotroom/db — durable, portable state (spec §12).
 *
 * SQLite in a single file, accessed via Drizzle. Owns the schema, migrations,
 * and the retention/compaction rule (§3.2, §4.4).
 *
 * The schema must satisfy the four §15 invariants from day one:
 *   1. runs store the full assembled content AND the configuration used
 *   2. edges.author_id is NOT NULL and distinguishes human vs session
 *   3. versions carry retention metadata so compaction is implementable
 *   4. outputs are addressed per run; `latest` is a derived view
 */

export const SCHEMA_VERSION = 0;
