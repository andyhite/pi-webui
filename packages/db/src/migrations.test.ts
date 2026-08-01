import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, SCHEMA_VERSION } from "./client.js";
import { migrations } from "./migrations.js";

/**
 * Migrations, and in particular the one kind SQLite cannot do in place.
 *
 * Migration 9 rebuilds `runs` to widen a CHECK constraint. A rebuild drops the
 * old table, and a drop with foreign keys enabled performs an implicit cascading
 * delete — so the thing worth testing is not that the new constraint exists but
 * that **every child row survived**: run inputs, outputs, submissions, and the
 * sessions and initiations that point at the run.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-migrations-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A store at exactly migration 8, with a run and one of everything that
 * references it — the state an existing installation is in before it upgrades.
 */
function storeAtMigration(id: number): string {
  const file = join(dir, "plotroom.db");
  const sqlite = new Database(file);
  sqlite.pragma("foreign_keys = ON");

  sqlite.exec(`
    CREATE TABLE schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  const record = sqlite.prepare<[number, string]>(
    "INSERT INTO schema_migrations (id, name) VALUES (?, ?)",
  );

  for (const migration of migrations) {
    if (migration.id > id) break;
    sqlite.exec(migration.sql);
    record.run(migration.id, migration.name);
  }

  seed(sqlite);
  sqlite.close();

  return file;
}

/** One run with every kind of row that references it. */
function seed(sqlite: Database.Database): void {
  sqlite.exec(`
    INSERT INTO blobs (id, hash, size, encoding, kind, inline_bytes)
      VALUES ('blob_1', 'hash-1', 4, 'utf8', 'assembled_content', X'74657374');
    INSERT INTO objects (id, kind, scope, title, latest_version_id)
      VALUES ('obj_1', 'note', 'world', 'note', 'ver_1');
    INSERT INTO object_versions
      (id, object_id, ordinal, content_hash, content_blob_id, card_json, summary)
      VALUES ('ver_1', 'obj_1', 1, 'hash-1', 'blob_1', '{}', 'note');
    INSERT INTO workstreams (id) VALUES ('ws_1');
    INSERT INTO command_definitions
      (id, name, instruction, model, effort, permissions_json, ask_points_json,
       lifecycle, outcome_json, parameters_json, budget_json, source)
      VALUES ('def_1', 'Implement', 'Do it.', 'm', 'medium', '{}', '[]',
              'producing', '{}', '[]', '{}', 'user');
    INSERT INTO commands (id, definition_id, workstream_id)
      VALUES ('cmd_1', 'def_1', 'ws_1');
    INSERT INTO runs
      (id, command_id, definition_id, ordinal, status, assembled_blob_id,
       assembled_hash, assembled_bytes, config_json, spend_cap_micros, pinned,
       started_at)
      VALUES ('run_1', 'cmd_1', 'def_1', 1, 'running', 'blob_1', 'hash-1', 4,
              '{"definitionId":"def_1"}', 250000, 1, 1000);
    INSERT INTO run_inputs
      (run_id, ordinal, object_id, version_id, content_hash, bytes)
      VALUES ('run_1', 1, 'obj_1', 'ver_1', 'hash-1', 4);
    INSERT INTO run_outputs (run_id, name, object_id, version_id)
      VALUES ('run_1', 'result', 'obj_1', 'ver_1');
    INSERT INTO sessions
      (id, workstream_id, command_id, run_id, mode, model, effort,
       initiated_by_kind, adapter_id, runtime_ref, phase_json, started_at,
       last_activity_at)
      VALUES ('sess_1', 'ws_1', 'cmd_1', 'run_1', 'producing', 'm', 'medium',
              'human', 'scripted', 'native-1', '{"kind":"idle"}', 1000, 1000);
    INSERT INTO run_submissions
      (run_id, ordinal, session_id, at, accepted, evaluations_json, feedback)
      VALUES ('run_1', 1, 'sess_1', 1000, 0, '[]', 'not yet');
    INSERT INTO run_initiations
      (initiation_key, command_id, run_id, session_id, created_at, settled_at)
      VALUES ('gesture', 'cmd_1', 'run_1', 'sess_1', 1000, 1000);
  `);
}

describe("migration 9 rebuilds runs without eating its children", () => {
  it("keeps every row that references the rebuilt table", () => {
    storeAtMigration(8);

    const state = openDatabase({ stateDir: dir });
    try {
      const count = (table: string): number =>
        (
          state.sqlite
            .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
            .get() as { n: number }
        ).n;

      // The whole point: a DROP with foreign keys on would have cascaded these
      // away and reported success.
      expect(count("runs")).toBe(1);
      expect(count("run_inputs")).toBe(1);
      expect(count("run_outputs")).toBe(1);
      expect(count("run_submissions")).toBe(1);
      expect(count("sessions")).toBe(1);
      expect(count("run_initiations")).toBe(1);

      // The links still point at the run, rather than having been nulled out.
      const session = state.sqlite
        .prepare<[], { run_id: string | null }>(
          "SELECT run_id FROM sessions WHERE id = 'sess_1'",
        )
        .get() as { run_id: string | null };
      expect(session.run_id).toBe("run_1");

      // Every column came across, including the one migration 8 added.
      const run = state.sqlite
        .prepare<[], Record<string, unknown>>(
          "SELECT * FROM runs WHERE id = 'run_1'",
        )
        .get() as Record<string, unknown>;
      expect(run["spend_cap_micros"]).toBe(250000);
      expect(run["pinned"]).toBe(1);
      expect(run["assembled_hash"]).toBe("hash-1");
      expect(run["config_json"]).toBe('{"definitionId":"def_1"}');

      expect(state.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      state.close();
    }
  });

  it("accepts the interrupted status it was rebuilt for, and still refuses a made-up one", () => {
    storeAtMigration(8);

    const state = openDatabase({ stateDir: dir });
    try {
      state.sqlite
        .prepare("UPDATE runs SET status = 'interrupted' WHERE id = 'run_1'")
        .run();

      expect(
        (
          state.sqlite
            .prepare<[], { status: string }>(
              "SELECT status FROM runs WHERE id = 'run_1'",
            )
            .get() as { status: string }
        ).status,
      ).toBe("interrupted");

      // The constraint was widened, not removed.
      expect(() =>
        state.sqlite
          .prepare("UPDATE runs SET status = 'vibes' WHERE id = 'run_1'")
          .run(),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      state.close();
    }
  });

  it("restores foreign key enforcement after the rebuild", () => {
    storeAtMigration(8);

    const state = openDatabase({ stateDir: dir });
    try {
      expect(state.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
      // A child pointing at a run that does not exist is refused again.
      expect(() =>
        state.sqlite
          .prepare(
            `INSERT INTO run_inputs
               (run_id, ordinal, object_id, version_id, content_hash, bytes)
             VALUES ('run_nope', 9, 'obj_1', 'ver_1', 'hash-1', 4)`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      state.close();
    }
  });

  it("leaves a fresh store at the newest schema version, indexes included", () => {
    const state = openDatabase({ stateDir: dir });
    try {
      const version = state.sqlite
        .prepare<[], { max: number }>(
          "SELECT MAX(id) AS max FROM schema_migrations",
        )
        .get() as { max: number };
      expect(version.max).toBe(SCHEMA_VERSION);

      const indexes = state.sqlite
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runs'",
        )
        .all()
        .map((row) => row.name);

      expect(indexes).toContain("runs_ordinal_idx");
      expect(indexes).toContain("runs_definition_idx");
      expect(indexes).toContain("runs_retention_idx");
    } finally {
      state.close();
    }
  });
});
