import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type PlotroomDatabase } from "./client.js";
import { SearchIndex, toLiteralFtsQuery } from "./search.js";

describe("toLiteralFtsQuery (grammar isolation)", () => {
  it("quotes a single term as one FTS5 phrase", () => {
    expect(toLiteralFtsQuery("flaky")).toBe('"flaky"');
  });

  it("quotes a hyphenated term rather than letting FTS5 read the hyphen as NOT", () => {
    expect(toLiteralFtsQuery("PROJ-123")).toBe('"PROJ-123"');
  });

  it("quotes a slash-bearing term (a branch name) as one literal phrase", () => {
    expect(toLiteralFtsQuery("feat/x-y")).toBe('"feat/x-y"');
  });

  it("quotes each whitespace-separated word and joins them with FTS5's default AND", () => {
    expect(toLiteralFtsQuery("PROJ-123 ticket")).toBe('"PROJ-123" "ticket"');
  });

  it("escapes an internal double quote by doubling it, never closing the phrase early", () => {
    expect(toLiteralFtsQuery('say "hi"')).toBe('"say" """hi"""');
  });

  it("neutralizes parens and asterisks by quoting them as literal text", () => {
    expect(toLiteralFtsQuery("foo(bar")).toBe('"foo(bar"');
    expect(toLiteralFtsQuery("foo*bar*")).toBe('"foo*bar*"');
  });

  it("returns null for a blank query rather than an empty MATCH expression", () => {
    expect(toLiteralFtsQuery("")).toBeNull();
    expect(toLiteralFtsQuery("   ")).toBeNull();
    expect(toLiteralFtsQuery("\t\n")).toBeNull();
  });

  it("collapses repeated whitespace between terms", () => {
    expect(toLiteralFtsQuery("foo   bar")).toBe('"foo" "bar"');
  });
});

describe("SearchIndex.query (route-independent grammar safety)", () => {
  let dir: string;
  let state: PlotroomDatabase;
  let index: SearchIndex;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plotroom-search-"));
    state = openDatabase({ stateDir: dir });
    index = new SearchIndex(state);
  });

  afterEach(() => {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seed() {
    index.index({
      title: "PROJ-123 fix the flaky login test",
      location: "feat/x-y",
      body: "the login test fails intermittently",
      kind: "session",
      refKind: "session",
      refId: "sess_1",
    });
  }

  it("finds a hyphenated ticket id as literal text rather than raising a SqliteError", () => {
    seed();
    const hits = index.query("PROJ-123");
    expect(hits.map((hit) => hit.refId)).toContain("sess_1");
  });

  it("finds a slash-bearing branch-like term in the location column", () => {
    seed();
    const hits = index.query("feat/x-y");
    expect(hits.map((hit) => hit.refId)).toContain("sess_1");
  });

  it("treats an unbalanced quote as literal text instead of raising 'unterminated string'", () => {
    seed();
    expect(() => index.query('"unterminated')).not.toThrow();
  });

  it("treats a stray paren as literal text instead of raising a syntax error", () => {
    seed();
    expect(() => index.query("foo(bar")).not.toThrow();
  });

  it("treats a stray asterisk as literal text instead of a prefix-query wildcard", () => {
    seed();
    expect(() => index.query("foo*bar*")).not.toThrow();
  });

  it("returns no hits (never throws) for a query that sanitizes to nothing", () => {
    expect(index.query("   ")).toEqual([]);
  });

  it("still matches every word for a multi-word query (AND semantics preserved)", () => {
    seed();
    expect(index.query("PROJ-123 flaky").map((hit) => hit.refId)).toContain(
      "sess_1",
    );
    expect(
      index.query("PROJ-123 nonexistentword").map((hit) => hit.refId),
    ).not.toContain("sess_1");
  });
});
