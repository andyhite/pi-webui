import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { removeStateDir } from "./remove-state-dir.js";
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
  removeStateDir(dir);
});

/**
 * A store at exactly migration 8, with a run and one of everything that
 * references it — the state an existing installation is in before it upgrades.
 */
function storeAtMigration(id: number): string {
  const file = join(dir, "plotroom.db");
  const sqlite = new Database(file);
  sqlite.run("PRAGMA foreign_keys = ON");

  sqlite.run(`
    CREATE TABLE schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  const record = sqlite.prepare<unknown, [number, string]>(
    "INSERT INTO schema_migrations (id, name) VALUES (?, ?)",
  );

  for (const migration of migrations) {
    if (migration.id > id) break;
    sqlite.run(migration.sql);
    record.run(migration.id, migration.name);
  }

  seed(sqlite);
  sqlite.close();

  return file;
}

/** One run with every kind of row that references it. */
function seed(sqlite: Database): void {
  sqlite.run(`
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
            .prepare<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`)
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
        .prepare<{ run_id: string | null }, []>(
          "SELECT run_id FROM sessions WHERE id = 'sess_1'",
        )
        .get() as { run_id: string | null };
      expect(session.run_id).toBe("run_1");

      // Every column came across, including the one migration 8 added.
      const run = state.sqlite
        .prepare<Record<string, unknown>, []>(
          "SELECT * FROM runs WHERE id = 'run_1'",
        )
        .get() as Record<string, unknown>;
      expect(run["spend_cap_micros"]).toBe(250000);
      expect(run["pinned"]).toBe(1);
      expect(run["assembled_hash"]).toBe("hash-1");
      expect(run["config_json"]).toBe('{"definitionId":"def_1"}');

      expect(
        state.sqlite.query<unknown, []>("PRAGMA foreign_key_check").all(),
      ).toEqual([]);
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
            .prepare<{ status: string }, []>(
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
      expect(
        state.sqlite
          .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
          .get()?.foreign_keys,
      ).toBe(1);
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
        .prepare<{ max: number }, []>(
          "SELECT MAX(id) AS max FROM schema_migrations",
        )
        .get() as { max: number };
      expect(version.max).toBe(SCHEMA_VERSION);

      const indexes = state.sqlite
        .prepare<{ name: string }, []>(
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

describe("migration 22 re-keys the spend ledger by cause", () => {
  /** A store at 21 with one attributed dollar: what an install upgrades from. */
  function storeWithSpend(): void {
    const file = storeAtMigration(21);
    const sqlite = new Database(file);
    sqlite.run(`
      INSERT INTO spend_attributions
        (id, session_id, source_session_id, workstream_id, basis, amount_micros,
         cost_basis, at)
        VALUES ('spend_1', 'sess_1', 'sess_1', 'ws_1', 'own', 1000000,
                'reported', 1000);
    `);
    sqlite.close();
  }

  it("keeps existing rows, calling them what they are", () => {
    storeWithSpend();

    const state = openDatabase({ stateDir: dir });
    try {
      const row = state.sqlite
        .prepare<Record<string, unknown>, []>(
          "SELECT * FROM spend_attributions WHERE id = 'spend_1'",
        )
        .get() as Record<string, unknown>;

      // Nothing is lost and nothing is guessed: a row written before the column
      // existed is an accounting row, which is what almost all of them were.
      expect(row["amount_micros"]).toBe(1000000);
      expect(row["cause"]).toBe("accounting");
      expect(
        state.sqlite.query<unknown, []>("PRAGMA foreign_key_check").all(),
      ).toEqual([]);
    } finally {
      state.close();
    }
  });

  it("admits a second charge for the same pair under a different cause", () => {
    storeWithSpend();

    const state = openDatabase({ stateDir: dir });
    try {
      const insert = (id: string, cause: string) =>
        state.sqlite
          .prepare(
            `INSERT INTO spend_attributions
               (id, session_id, source_session_id, workstream_id, basis,
                amount_micros, cost_basis, cause, at)
             VALUES (?, 'sess_1', 'sess_1', 'ws_1', 'descendant', 500000,
                     'reported', ?, 2000)`,
          )
          .run(id, cause);

      // What the old key made impossible: a broadcast's induced charge beside the
      // accounting row for the same pair (§6.5).
      insert("spend_2", "broadcast:bcast_1");
      // And a second broadcast is a second charge, not a replacement of the first.
      insert("spend_3", "broadcast:bcast_2");

      // The pair is still unique *within* a cause, so a restated total cannot
      // become two rows.
      expect(() => insert("spend_4", "broadcast:bcast_2")).toThrow(
        /UNIQUE constraint failed/,
      );

      const total = state.sqlite
        .prepare<{ total: number }, []>(
          "SELECT SUM(amount_micros) AS total FROM spend_attributions",
        )
        .get() as { total: number };
      expect(total.total).toBe(2000000);
    } finally {
      state.close();
    }
  });
});

describe("migration 27 widens the approval kinds by rebuild (§3.8)", () => {
  /** A store at 26 with one open approval: what an install upgrades from. */
  function storeWithApproval(): void {
    const file = storeAtMigration(26);
    const sqlite = new Database(file);
    sqlite.run(`
      INSERT INTO approvals
        (id, session_id, workstream_id, kind, ask_json, call_id, raised_at)
        VALUES ('appr_1', 'sess_1', 'ws_1', 'tool-permission',
                '{"kind":"tool-permission"}', 'call-1', 1000);
      INSERT INTO pre_grants
        (id, scope, session_id, effect, kinds_json, tool_pattern, extents_json,
         granted_by, granted_at)
        VALUES ('pregrant_1', 'session', 'sess_1', 'allow', '["tool-permission"]',
                '**', '["none"]', 'human', 1000);
    `);
    sqlite.close();
  }

  it("keeps every approval and every row beside it, foreign keys intact", () => {
    storeWithApproval();

    const state = openDatabase({ stateDir: dir });
    try {
      const kept = state.sqlite
        .prepare<Record<string, unknown>, []>(
          "SELECT * FROM approvals WHERE id = 'appr_1'",
        )
        .get() as Record<string, unknown>;
      expect(kept["kind"]).toBe("tool-permission");
      expect(kept["call_id"]).toBe("call-1");
      // A rebuild drops the old table, and a drop with foreign keys on cascades:
      // the pre-grant beside it is what proves the pragma was off in time.
      expect(
        state.sqlite
          .prepare<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM pre_grants",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        state.sqlite.query<unknown, []>("PRAGMA foreign_key_check").all(),
      ).toEqual([]);

      // The indexes came back with the table, including the one that makes a
      // re-raised call find its own approval rather than stacking a second.
      const indexes = state.sqlite
        .prepare<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'approvals'",
        )
        .all()
        .map((row) => row.name);
      expect(indexes).toContain("approvals_call_idx");
      expect(indexes).toContain("approvals_open_idx");
    } finally {
      state.close();
    }
  });

  it("accepts the proposal kind it was rebuilt for, and still refuses a made-up one", () => {
    storeWithApproval();

    const state = openDatabase({ stateDir: dir });
    try {
      const insert = (id: string, kind: string) =>
        state.sqlite
          .prepare(
            `INSERT INTO approvals
               (id, session_id, workstream_id, kind, ask_json, raised_at)
             VALUES (?, 'sess_1', 'ws_1', ?, '{}', 2000)`,
          )
          .run(id, kind);

      insert("appr_2", "standing-instruction");
      expect(() => insert("appr_3", "invented-kind")).toThrow(
        /CHECK constraint failed/,
      );
    } finally {
      state.close();
    }
  });
});

describe("migration 33 rewrites external_system from producer id to plugin id (#85)", () => {
  /**
   * A store at 32 with two integrations of one plugin under their old,
   * per-producer `system` values — exactly what `IntegrationService.connect`
   * wrote before the fix — and the objects each one produced.
   */
  function storeWithProducerSystems(): void {
    const file = storeAtMigration(32);
    const sqlite = new Database(file);
    sqlite.run(`
      INSERT INTO integrations
        (id, plugin_id, producer_id, name, system, connection_state,
         created_at, updated_at)
        VALUES ('int_issues', 'jira', 'jira-issues', 'Issues', 'jira-issues',
                'connected', 1000, 1000);
      INSERT INTO integrations
        (id, plugin_id, producer_id, name, system, connection_state,
         created_at, updated_at)
        VALUES ('int_epics', 'jira', 'jira-epics-as-collections', 'Epics',
                'jira-epics-as-collections', 'connected', 1000, 1000);

      -- Read only by the issue producer: no collision, a plain rewrite.
      INSERT INTO objects
        (id, kind, scope, external_system, external_id, title,
         latest_version_id, created_at)
        VALUES ('obj_solo', 'ticket', 'world', 'jira-issues', 'OXY-1',
                'Solo ticket', NULL, 1000);

      -- The same ticket, produced under both systems — #85's duplicate.
      INSERT INTO objects
        (id, kind, scope, external_system, external_id, title,
         latest_version_id, created_at)
        VALUES ('obj_dup_issue', 'ticket', 'world', 'jira-issues', 'OXY-2',
                'Duplicate, via issues', NULL, 1000);
      INSERT INTO objects
        (id, kind, scope, external_system, external_id, title,
         latest_version_id, created_at)
        VALUES ('obj_dup_epic', 'ticket', 'world', 'jira-epics-as-collections',
                'OXY-2', 'Duplicate, via epics', NULL, 1000);
    `);
    sqlite.close();
  }

  it("rewrites both tables to the plugin id when no collision results", () => {
    storeWithProducerSystems();

    const state = openDatabase({ stateDir: dir });
    try {
      const integrationSystems = state.sqlite
        .prepare<{ id: string; system: string }, []>(
          "SELECT id, system FROM integrations ORDER BY id",
        )
        .all();
      expect(integrationSystems).toEqual([
        { id: "int_epics", system: "jira" },
        { id: "int_issues", system: "jira" },
      ]);

      const solo = state.sqlite
        .prepare<{ external_system: string }, []>(
          "SELECT external_system FROM objects WHERE id = 'obj_solo'",
        )
        .get() as { external_system: string };
      expect(solo.external_system).toBe("jira");

      expect(
        state.sqlite.query<unknown, []>("PRAGMA foreign_key_check").all(),
      ).toEqual([]);
    } finally {
      state.close();
    }
  });

  it("leaves a colliding pair exactly as it was rather than merging them", () => {
    storeWithProducerSystems();

    const state = openDatabase({ stateDir: dir });
    try {
      const rows = state.sqlite
        .prepare<{ id: string; external_system: string }, []>(
          "SELECT id, external_system FROM objects WHERE id IN ('obj_dup_issue', 'obj_dup_epic') ORDER BY id",
        )
        .all();

      // Rewriting either row to "jira" would collide with the other under
      // `objects_external_idx`, so this migration does not attempt to merge
      // them — the pre-existing duplicate the fix stops creating going
      // forward is left in place, under its stale system, rather than
      // silently merged.
      expect(rows).toEqual([
        { id: "obj_dup_epic", external_system: "jira-epics-as-collections" },
        { id: "obj_dup_issue", external_system: "jira-issues" },
      ]);
    } finally {
      state.close();
    }
  });
});
