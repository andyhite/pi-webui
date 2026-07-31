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

    sqlite.transaction(() => {
      sqlite.exec(migration.sql);
      record.run(migration.id, migration.name);
    })();
  }
}

/** The highest migration id this build knows about. */
export const SCHEMA_VERSION = migrations.reduce(
  (max, migration) => Math.max(max, migration.id),
  0,
);
