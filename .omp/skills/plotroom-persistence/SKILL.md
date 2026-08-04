---
name: plotroom-persistence
description: Why PlotRoom's schema and content storage are shaped the way they are — the state directory, the 64KB inline-vs-blob bound every caller reuses, migrations, maintenance and reset, objects and versions, retention defaults, and search. Read before editing packages/db, writing a migration, or storing content anywhere, including from a plugin producer.
---

# How PlotRoom stores state

These are the decisions behind `packages/db` and the state directory. Where a paragraph states a rule, the rule is binding: change the predicate and its mirror together, and never add a second place a rule is stated.

The schema must satisfy the four §15 invariants from day one:

- `edges.author_id` is `NOT NULL` and distinguishes human vs session authors.
- `runs` stores the full assembled content **and** the configuration it ran under.
- outputs are addressed per run (`output@n`); `latest` is a derived view, never the only address.
- versions carry retention metadata so the compaction rule is implementable, not retrofitted.

**Content storage is hybrid, decided.** One state directory is the unit of
backup and movement:

```
<state-dir>/
  plotroom.db          rows, indexes, FTS index, inline content
  blobs/ab/cdef0123…   content-addressed files, large content only
```

- Bytes at or below `INLINE_MAX_BYTES` (64KB) live inline in the `blobs` row;
  larger content spills to `blobs/<hash>`. Callers never choose — everything
  goes through `BlobStore` in `packages/db`.
- Blobs are identified by sha256, so identical content is stored once. Assembled
  run content repeats heavily across runs; dedup is load-bearing, not an
  optimization.
- `blob_refs` makes retention a query, not a guess: anything referenced is
  retained, `compact()` removes only what nothing points at, and `pinned` marks
  what must never be compacted.
- Transcript release (§6.1) deletes the external file and keeps the row, so a
  marker can be drawn and the content reloaded. Nothing is silently deleted.
- Migrations are embedded in `src/migrations.ts` (append-only, never edit a
  shipped one), not read from disk — a packaged build cannot ship without its
  schema. A migration that must change a CHECK constraint sets
  `rebuildsTable: true`, and the runner then does SQLite's documented rebuild
  properly: foreign keys off **before** the transaction begins (the pragma is a
  no-op inside one, and a `DROP TABLE` with them on cascades every child row
  away), then back on plus `PRAGMA foreign_key_check`. Migration 9 is the
  worked example, and its test upgrades a seeded store to prove no child row is
  lost.
- **Durability and cleanup** live in `Maintenance` (`packages/db`) and
  `apps/server/src/maintenance/`. The portable unit is the state directory's
  `plotroom.db` plus `blobs/`; `workspaces/`, `git-cache/`, and `runtime/` sit
  inside it but are derived and excluded from the backup story, which
  `GET /api/maintenance/state` states rather than leaves to be inferred. Every
  reset verb is a plan and an execution: an unconfirmed `POST /api/reset`
  answers with the plan and removes nothing, and the plan asks git which
  checkouts hold uncommitted, untracked, or unpushed work so it can name what
  deleting them would destroy (an unreadable checkout is reported as unreadable,
  never as clean). The compaction job schedules the
  sweep (injected timers, `PLOTROOM_COMPACTION_INTERVAL_SECONDS`, `0` disables
  the schedule but never the endpoint) and decides nothing — the rules stay the
  predicates in `@plotroom/core`, and the sweep order is runs → versions →
  blobs, because each step is what releases the next one's references.

**Objects and versions** live in `objects` / `object_versions`. External
identity is uniquely indexed so a re-read reconciles rather than duplicating;
content identical to the latest version writes no version. The compaction rule
is a pure predicate (`isCompactable` in `@plotroom/core`) mirrored by
`ObjectStore.compactVersions` — change both together, and keep the predicate as
the place the rule is stated.

**Retention policy defaults, decided.** Run history keeps the **last 20 runs
per command definition**, plus every pinned run and everything it references,
plus everything inside a **30-day window** — the same window as version
compaction, so the two rules cannot disagree about how old "old" is
(`DEFAULT_RUN_RETENTION_POLICY` in `@plotroom/core`). Retention never makes a
live address stop answering: the run `latest` currently resolves to is not
compactable at any age.

`AGENTS.md` states the rule about the injectable clock the retention rules above
are tested through; it is not repeated here.

**Search** is an index-only FTS5 table populated on write, so inline and
external content are equally searchable and archived sessions stay findable
(§6.8).
