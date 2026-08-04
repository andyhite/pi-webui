# 0004 — Collection membership

- **Status:** Accepted
- **Date:** 2026-08-04
- **Deciders:** operator

## Context

`collection` has been an `ObjectKind` with no way to express members — the last
schema gap in the Phase 1 model. Two in-box plugins worked around it: the Jira
plugin emits an epic as a `collection` whose **content lists each child as a
markdown line** and co-produces every child as its own `ticket` in the same read,
joined by external id; the filesystem plugin sidesteps collections entirely and
renders a directory as one `document`.

Nothing else in the product depends on membership. No store, route, assembly,
search or attention path branches on `kind === "collection"`; the only two
consumers that assume members exist are a Jira card action and a fixture-backed
demo that says so in a comment. So there is no data to migrate — only Jira to
re-read.

## Decision

Membership is **its own table relating objects** — not a column on the object (it
would be unversioned) and not part of a version's content (it would churn with
every edit). The schema already answered the analogous question once: a standing
instruction is a marker on an object in its own table, holding no content.

```
collection_members
  collection_object_id  → objects.id  NOT NULL
  member_object_id      → objects.id  NOT NULL
  ordinal               integer NOT NULL
  author_kind           text NOT NULL CHECK IN ('human','session','system')
  author_session_id     text
  at                    integer NOT NULL DEFAULT (unixepoch())
  removed_at            integer
  PRIMARY KEY (collection_object_id, member_object_id)
```

- It relates **objects, not nodes**: an edge's endpoints must both be on the board,
  and a member need not be placed to be a member.
- The payload mirrors `edges` (ordinal, author, soft removal); the enforcement
  mirrors `standing_instruction_opt_ins` (a composite primary key), so a doubled
  membership is unrepresentable rather than merely refused.
- **Every membership records its author**, in the spirit of §15 invariant 2.
  `system` is the legal value for producer-derived membership — the exception
  provenance edges already have — so "the source says these are the children" and
  "the operator pruned this one" stay different facts.
- Rows **retire rather than delete**, because a prune is an event.
- Migration 31 adds a table only: `objects.kind` carries no CHECK to widen, so no
  table rebuild is needed, and the new table carries no `latest*` column.

Three product rules land with the schema, because the schema alone does not answer
them:

1. **Producers declare membership structurally.** The Jira epic producer stops
   encoding children as content lines, and the markdown-parsing helpers are
   deleted. The child count stays in the title, because §3.1 presents a collection
   with a count — but it is derived from rows. The producer's existing refusal
   stands: a collection whose membership could not be read is not emitted at all.
2. **Wiring a collection into a command assembles its members' content**, in
   ordinal order. Assembly was kind-blind, so wiring an epic in handed the model _a
   list of ids_ — the real product bug behind the schema gap. §15-1 still records
   the assembled result, and an omission forced by a budget is stated in-band,
   never silently.
3. **Dragging a member out places it on the board without changing membership.** A
   canvas gesture must not rewrite an external system's structure. Pruning is the
   explicit removal verb, and it is what writes a `human` row.

## Prerequisite

`objects.external_system` records the **producer id** rather than the system, so
the same external record reconciles to two different object rows depending on which
producer read it. Membership resolves members by external identity, so that defect
is fixed first.
