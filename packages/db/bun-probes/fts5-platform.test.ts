// FTS5 platform gate for the bun:sqlite swap (#312, gating #313).
//
// Bun's own docs make no promise about FTS5 or which SQLite compile flags its
// bundled build carries. Linux and Windows link Bun's static SQLite; macOS
// links Apple's system SQLite (Bun's `bun:sqlite` docs: "on macOS, the
// system-provided libsqlite3 is used"). Platform variance is plausible, not
// hypothetical, so this measures it rather than assuming it.
//
// Deliberately **not** under `src/`: `vitest.base.config.ts` collects
// `src/**/*.test.ts` and would try to run this file under Node/Vitest, where
// `bun:sqlite` does not resolve. This probe only runs under `bun test`,
// invoked directly — see `.github/workflows/install.yml` and this package's
// `probe:fts5` script.
//
// This is a measurement, not a behavioral spec: there is no "implementation"
// this test drives green by construction, the way a feature test does. Its
// only job is to fail honestly if a platform's `bun:sqlite` lacks FTS5, and
// the assertions below are exactly the surface `packages/db/src/search.ts`
// depends on — the schema shape (migration 30, `search_titled`), the
// weighted `bm25()` call, and `snippet()` — so a pass here is a real
// guarantee about that file, not a generic "FTS5 exists somewhere" check.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

describe("fts5 platform gate", () => {
  test("sqlite_compileoption_used('ENABLE_FTS5') reports true", () => {
    const sqlite = new Database(":memory:");
    try {
      const row = sqlite
        .query("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled")
        .get() as { enabled: number };
      expect(row.enabled).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  test("an fts5 virtual table can be created, matching search.ts's shape", () => {
    const sqlite = new Database(":memory:");
    try {
      expect(() => {
        sqlite.exec(`
          CREATE VIRTUAL TABLE search USING fts5(
            title,
            location,
            body,
            kind UNINDEXED,
            ref_kind UNINDEXED,
            ref_id UNINDEXED
          );
        `);
      }).not.toThrow();
    } finally {
      sqlite.close();
    }
  });

  test("MATCH, weighted bm25(), and snippet() all work together — the exact query search.ts runs", () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(`
        CREATE VIRTUAL TABLE search USING fts5(
          title,
          location,
          body,
          kind UNINDEXED,
          ref_kind UNINDEXED,
          ref_id UNINDEXED
        );
      `);

      const insert = sqlite.query(
        "INSERT INTO search (title, location, body, kind, ref_kind, ref_id) VALUES (?, ?, ?, ?, ?, ?)",
      );
      insert.run(
        "Quarterly budget review",
        "workstream/finance",
        "We discussed the quarterly numbers and next steps for the budget.",
        "session",
        "session",
        "s1",
      );
      insert.run(
        "Design sync",
        "workstream/design",
        "Nothing about money here, just component specs.",
        "session",
        "session",
        "s2",
      );
      insert.run(
        "Weekly notes",
        "workstream/finance",
        "A passing mention of the budget process, buried in a long transcript.",
        "session",
        "session",
        "s3",
      );

      // Title/location/body weighting, exactly as `packages/db/src/search.ts`
      // calls it: a title match should outrank a body-only match.
      const TITLE_WEIGHT = 10.0;
      const LOCATION_WEIGHT = 4.0;
      const BODY_WEIGHT = 1.0;

      const rows = sqlite
        .query(
          `SELECT ref_id AS refId,
                  snippet(search, 2, '[', ']', '…', 12) AS snippet,
                  bm25(search, ?, ?, ?) AS rank
             FROM search
            WHERE search MATCH ?
            ORDER BY rank`,
        )
        .all(TITLE_WEIGHT, LOCATION_WEIGHT, BODY_WEIGHT, '"budget"') as {
        refId: string;
        snippet: string;
        rank: number;
      }[];

      expect(rows.map((row) => row.refId)).toEqual(["s1", "s3"]);
      expect(rows[0]!.rank).toBeLessThan(rows[1]!.rank); // bm25: lower is better
      expect(rows[0]!.snippet).toContain("[budget]");
      expect(rows[1]!.snippet.toLowerCase()).toContain("[budget]");
    } finally {
      sqlite.close();
    }
  });
});
