import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type PlotroomDatabase } from "./client.js";

/**
 * The §15 invariants as a **schema census** (Epic 8.5, cross-cutting rule 1).
 *
 * The behavioural half of this suite is `apps/server/src/invariants.integration.test.ts`,
 * which drives the real API against a live store. This is the other half, and it
 * exists because those tests can only reach the tables a scenario touches: they
 * prove that the endpoint wrote the row, never that the *teeth are still on the
 * column*. A migration that made `runs.config_json` nullable, or dropped a
 * foreign key, or denormalized "which run is latest" onto some third table would
 * leave every scenario in that file passing — the store would simply have become
 * able to represent the record §15 says must be impossible.
 *
 * So this asks the migrated schema about itself, across every table at once:
 *
 *   1. the columns run history is recorded in are NOT NULL, and the version a run
 *      consumed is held by a real foreign key;
 *   2. `edges.author_kind` is NOT NULL and its CHECKs make an unattributed
 *      context edge — and an authored provenance edge — unrepresentable;
 *   3. every version carries the retention metadata the compaction rule reads;
 *   4. nothing anywhere records which run is `latest`.
 *
 * A failure here reads as what it is: the schema has stopped enforcing an
 * invariant, whatever the tests over today's code paths still say.
 */

let dir: string;
let state: PlotroomDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-invariants-"));
  state = openDatabase({ stateDir: dir });
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

interface ColumnFact {
  readonly table: string;
  readonly column: string;
  readonly notNull: boolean;
}

function columns(): readonly ColumnFact[] {
  return state.sqlite
    .prepare<[], { tbl: string; col: string; nn: number }>(
      `SELECT m.name AS tbl, p.name AS col, p."notnull" AS nn
         FROM sqlite_master m JOIN pragma_table_info(m.name) p
        WHERE m.type = 'table'`,
    )
    .all()
    .map((row) => ({
      table: row.tbl,
      column: row.col,
      notNull: row.nn === 1,
    }));
}

function nullable(table: string, column: string): boolean {
  const found = columns().find(
    (fact) => fact.table === table && fact.column === column,
  );
  if (found === undefined) {
    throw new Error(`${table}.${column} does not exist`);
  }
  return !found.notNull;
}

function foreignKeys(
  table: string,
): readonly { readonly from: string; readonly to: string }[] {
  return state.sqlite
    .prepare<[string], { from: string; table: string }>(
      'SELECT p."from" AS "from", p."table" AS "table" FROM pragma_foreign_key_list(?) p',
    )
    .all(table)
    .map((row) => ({ from: row.from, to: row.table }));
}

describe("§15-1: the schema cannot represent a run without its record", () => {
  it("keeps both halves NOT NULL, and the bytes measured beside them", () => {
    // Not "there is a column for it": a nullable column is exactly the state
    // that lets one unattributed write through, and one is enough (§15).
    for (const column of [
      "assembled_blob_id",
      "assembled_hash",
      "assembled_bytes",
      "config_json",
      "ordinal",
      "definition_id",
    ]) {
      expect(nullable("runs", column), `runs.${column}`).toBe(false);
    }
  });

  it("holds every consumed version by a real foreign key, not by convention", () => {
    // §15-3's interplay, stated in the schema: a version a run consumed cannot
    // be deleted while the run exists, so compaction can never eat run history.
    expect(foreignKeys("run_inputs")).toEqual(
      expect.arrayContaining([
        { from: "version_id", to: "object_versions" },
        { from: "object_id", to: "objects" },
        { from: "run_id", to: "runs" },
      ]),
    );
    expect(nullable("run_inputs", "version_id")).toBe(false);
    expect(nullable("run_inputs", "content_hash")).toBe(false);

    // Outputs are held the same way, or `output@n` could resolve to a version
    // nothing retains (§15-4 depends on §15-3).
    expect(foreignKeys("run_outputs")).toEqual(
      expect.arrayContaining([
        { from: "version_id", to: "object_versions" },
        { from: "object_id", to: "objects" },
      ]),
    );

    // `node_id` is the deliberate exception and is asserted as such: a standing
    // instruction reaches a run at assembly rather than through an edge, so it
    // has no node — and that is why nullability here is a decision, not a gap.
    expect(nullable("run_inputs", "node_id")).toBe(true);
  });
});

describe("§15-2: the schema cannot represent an unattributed context edge", () => {
  it("makes the author column NOT NULL", () => {
    expect(nullable("edges", "author_kind")).toBe(false);
  });

  it("refuses every shape of 'nobody authored this'", () => {
    state.sqlite
      .prepare(
        `INSERT INTO nodes (id, role, ref_id, created_at)
         VALUES ('node_from', 'content', 'obj_1', 1), ('node_to', 'command', 'cmd_1', 1)`,
      )
      .run();

    const insert = (
      kind: string,
      authorKind: string | null,
      authorSession: string | null,
      ordinal: number | null,
      relation: string | null,
    ) =>
      state.sqlite
        .prepare(
          `INSERT INTO edges (id, kind, from_node, to_node, author_kind, author_session, ordinal, relation, created_at)
           VALUES ('edge_attempt', ?, 'node_from', 'node_to', ?, ?, ?, ?, 1)`,
        )
        .run(kind, authorKind, authorSession, ordinal, relation);

    // No author at all.
    expect(() => insert("context", null, null, 1, null)).toThrow(
      /NOT NULL constraint failed: edges.author_kind/u,
    );
    // The system author, which is reserved for provenance.
    expect(() => insert("context", "system", null, 1, null)).toThrow(
      /CHECK constraint failed/u,
    );
    // A session author naming no session.
    expect(() => insert("context", "session", null, 1, null)).toThrow(
      /CHECK constraint failed/u,
    );
    // And the other direction: provenance is recorded, never authored, so it
    // cannot borrow a human's name to look like a decision somebody made.
    expect(() =>
      insert("provenance", "human", null, null, "session_delegated"),
    ).toThrow(/CHECK constraint failed/u);
    expect(() =>
      insert("provenance", "session", "sess_1", null, "session_delegated"),
    ).toThrow(/CHECK constraint failed/u);

    // The legal pair really is legal, or the five refusals above would prove
    // only that this table refuses everything.
    expect(() => insert("context", "human", null, 1, null)).not.toThrow();
  });
});

describe("§15-3: every version carries the metadata the rule reads", () => {
  it("has retention flags from the first write, not added later", () => {
    for (const column of ["run_referenced", "pinned", "created_at"]) {
      expect(
        nullable("object_versions", column),
        `object_versions.${column}`,
      ).toBe(false);
    }
    // A run's own pin is what reaches them (§4.4), so the run carries one too.
    expect(nullable("runs", "pinned")).toBe(false);
    expect(nullable("runs", "started_at")).toBe(false);
  });
});

describe("§15-4: nothing in the schema records which run is latest", () => {
  it("names exactly one latest-shaped column, and it is not an output address", () => {
    // `objects.latest_version_id` is an object's newest-version pointer (§3.2),
    // which is not an address for a run's output — every other appearance of the
    // word would be `latest` stored instead of derived, which is the failure
    // §15-4 exists to prevent, on whichever table it appeared.
    expect(
      columns()
        .filter((fact) => fact.column.includes("latest"))
        .map((fact) => `${fact.table}.${fact.column}`),
    ).toEqual(["objects.latest_version_id"]);
  });

  it("gives every run an ordinal, unique within its command", () => {
    // The `n` in `output@n`: a general address needs the ordinal to be the
    // record's own, not a position in a list somebody re-sorts.
    expect(nullable("runs", "ordinal")).toBe(false);

    // Asked of the indexes rather than of the DDL text, so a table rebuilt by a
    // future migration (the documented CHECK-widening shape) is judged on what it
    // enforces and not on how its `CREATE TABLE` happens to be written.
    const unique = state.sqlite
      .prepare<[], { name: string }>(
        "SELECT p.name FROM pragma_index_list('runs') p WHERE p.\"unique\" = 1",
      )
      .all()
      .map((index) =>
        state.sqlite
          .prepare<[string], { name: string }>(
            "SELECT i.name FROM pragma_index_info(?) i",
          )
          .all(index.name)
          .map((column) => column.name)
          .join(","),
      );
    expect(unique).toContain("command_id,ordinal");
  });
});
