import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrations } from "./migrations.js";
import { stateLayout, type StateLayout } from "./paths.js";
import * as schema from "./schema.js";

export interface PlotroomDatabase {
  readonly db: BetterSQLite3Database<typeof schema>;
  readonly sqlite: Database.Database;
  readonly layout: StateLayout;
  close(): void;
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

  const sqlite = new Database(inMemory ? ":memory:" : layout.databaseFile);

  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");

  applyMigrations(sqlite);

  return {
    db: drizzle(sqlite, { schema }),
    sqlite,
    layout,
    close: () => sqlite.close(),
  };
}

function applyMigrations(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  const applied = new Set(
    sqlite
      .prepare<[], { id: number }>("SELECT id FROM schema_migrations")
      .all()
      .map((row) => row.id),
  );

  const record = sqlite.prepare<[number, string]>(
    "INSERT INTO schema_migrations (id, name) VALUES (?, ?)",
  );

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    const apply = sqlite.transaction(() => {
      sqlite.exec(migration.sql);
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
function applyRebuild(
  sqlite: Database.Database,
  apply: () => void,
  name: string,
): void {
  sqlite.pragma("foreign_keys = OFF");
  try {
    apply();
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }

  const violations = sqlite.pragma("foreign_key_check") as unknown[];
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
