import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrations } from "./migrations.js";
import { stateLayout, type StateLayout } from "./paths.js";
import * as schema from "./schema.js";

export interface PlotroomDatabase {
  readonly db: BunSQLiteDatabase<typeof schema>;
  readonly sqlite: Database;
  readonly layout: StateLayout;
  close(): void;
}

/**
 * drizzle-orm's bun-sqlite session types every query builder `.run()` as
 * `void` (its `SQLiteBunSession` extends `SQLiteSession<'sync', void, ...>`),
 * even though the underlying bun:sqlite statement it delegates to really does
 * return `{ changes, lastInsertRowid }` at runtime - confirmed empirically
 * (drizzle-orm 0.45.2), not inferred from either project's docs. A call site
 * that reads `.run().changes` casts through this type instead of `void`, so
 * the gap is named once here rather than an inline `as unknown as` at each of
 * the handful of sites that need it (`budget-store.ts`, `maintenance.ts`).
 */
export interface DrizzleRunChanges {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface OpenOptions {
  /** Directory holding plotroom.db and blobs/. Use ":memory:" for tests. */
  readonly stateDir: string;
}

export function openDatabase({ stateDir }: OpenOptions): PlotroomDatabase {
  const layout = stateLayout(stateDir);
  const inMemory = stateDir === ":memory:";

  if (!inMemory) {
    mkdirSync(layout.dir, { recursive: true });
    mkdirSync(layout.blobsDir, { recursive: true });
  }

  // `safeIntegers` left at its default (false): every INTEGER column here
  // (timestamps, ordinals, ids) fits a JS `number` well under
  // Number.MAX_SAFE_INTEGER, and better-sqlite3 - the driver this replaces -
  // defaulted to plain numbers too (its own `safeIntegers` opts *into*
  // bigint). Turning it on would flip `lastInsertRowid` and every read
  // column to `bigint`, breaking `DrizzleRunChanges` and every call site
  // typed `number` today for no behavioral gain this schema needs.
  const sqlite = new Database(inMemory ? ":memory:" : layout.databaseFile);

  // bun:sqlite has no `.pragma()` helper (better-sqlite3's own addition, not a
  // SQLite API): every PRAGMA is a plain statement through `.run()`.
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA foreign_keys = ON");
  sqlite.run("PRAGMA synchronous = NORMAL");
  sqlite.run("PRAGMA busy_timeout = 5000");

  applyMigrations(sqlite);

  return {
    db: drizzle(sqlite, { schema }),
    sqlite,
    layout,
    close: () => {
      if (!inMemory) checkpointWal(sqlite);
      sqlite.close();
    },
  };
}

/**
 * Truncates the WAL file before closing (spec Sec.12: the state directory is
 * the unit of portability, so nothing should be left mid-checkpoint in it).
 *
 * bun:sqlite links Apple's system SQLite on macOS (its own docs: chosen for a
 * ~50% performance win over the bundled build), which sets
 * `SQLITE_FCNTL_PERSIST_WAL` by default - the last connection closing does
 * **not** delete or truncate `-wal`/`-shm`, unlike the SQLite build
 * better-sqlite3 statically links everywhere. An explicit
 * `PRAGMA wal_checkpoint(TRUNCATE)` forces the checkpoint and truncates the
 * WAL to zero bytes regardless of that platform difference, so a copy of the
 * state directory taken right after `close()` is the same portable file set
 * on every OS, not one that varies by which SQLite build opened it last.
 */
function checkpointWal(sqlite: Database): void {
  sqlite.run("PRAGMA wal_checkpoint(TRUNCATE)");
}

function applyMigrations(sqlite: Database): void {
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  const applied = new Set(
    sqlite
      .prepare<{ id: number }, []>("SELECT id FROM schema_migrations")
      .all()
      .map((row) => row.id),
  );

  const record = sqlite.prepare<unknown, [number, string]>(
    "INSERT INTO schema_migrations (id, name) VALUES (?, ?)",
  );

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    const apply = sqlite.transaction(() => {
      sqlite.run(migration.sql);
      record.run(migration.id, migration.name);
    });

    if (migration.rebuildsTable !== true) {
      apply();
      continue;
    }

    applyRebuild(sqlite, apply, migration.name);
  }
}

/**
 * A table rebuild, done the way SQLite documents it.
 *
 * Rebuilding a table means dropping the old one, and a `DROP TABLE` with foreign
 * keys enabled performs an implicit cascading delete — which would take every
 * child row with it and call the migration a success. So foreign keys go off
 * first. `PRAGMA foreign_keys` is a no-op *inside* a transaction, which is why it
 * is set before one begins; the rebuild itself is still one transaction, so a
 * failure rolls the whole thing back.
 *
 * Afterwards the references are checked rather than assumed: a rebuild that got a
 * foreign key wrong fails here, loudly, instead of shipping a store that lies
 * about itself.
 */
function applyRebuild(sqlite: Database, apply: () => void, name: string): void {
  sqlite.run("PRAGMA foreign_keys = OFF");
  try {
    apply();
  } finally {
    sqlite.run("PRAGMA foreign_keys = ON");
  }

  // A PRAGMA that returns rows needs `.prepare(...).all()`, not `.run()` -
  // `run()` never surfaces the result set, which is the whole point of this
  // check.
  const violations = sqlite
    .prepare<unknown, []>("PRAGMA foreign_key_check")
    .all();
  if (violations.length > 0) {
    throw new Error(
      `migration ${name} left ${violations.length} foreign key violation(s); the store was not migrated`,
    );
  }
}

/** The highest migration id this build knows about. */
export const SCHEMA_VERSION = migrations.reduce(
  (max, migration) => Math.max(max, migration.id),
  0,
);
