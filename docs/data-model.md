# PlotRoom — Data Model

**Scope.** This doc owns the persisted record inventory: what SQLite actually holds, in `packages/db/src/schema.ts` and `packages/db/src/migrations.ts`, and the domain types in `packages/core/src/*.ts` that give those rows meaning — object identity and reconciliation, the full version/run/blob retention story, the graph tables, run history, the output address grammar, session-adjacent records, and an inventory of claim/budget/approval/triage/settings tables. It defers claim/budget/approval/lineage _mechanics_ to [enforcement.md](enforcement.md), session flow to [session-lifecycle.md](session-lifecycle.md), run flow to [run-lifecycle.md](run-lifecycle.md), and attention derivation to [attention-derivation.md](attention-derivation.md). Details spec §3 (objects, versions, sessions), §4 (commands, runs, output addressing), §6 (steering, approvals, search), §7 (attention routing), and §15 (the four schema-shaped invariants).

## 1. Objects: the one content table, and how identity reconciles

`packages/core/src/objects.ts` defines the closed array `OBJECT_KINDS` — nine kinds: `ticket`, `pull_request`, `review`, `document`, `diff`, `commit`, `note`, `transcript`, `collection` — and nothing else. Every one of them is a row in one table, `objects` (`packages/db/src/schema.ts`). Integrations populate these nine kinds; they never add a tenth (spec §3.1, `packages/core/src/objects.ts`).

**Scope.** `ObjectScope` is `"world" | "local"` (`packages/core/src/objects.ts`): a world object can be context for many workstreams; a local object belongs to the workstream that produced it (`workstreamId`, non-null only for local objects). Locality is a default, not a definition — `ObjectStore.promote` lifts a local object to world scope in one gesture, clearing `workstreamId` and stamping `promotedAt` (`packages/db/src/object-store.ts`).

**External identity reconciles, never duplicates.** `ExternalIdentity` is `{ system, id }` (`packages/core/src/objects.ts`) — the integration and the identity in that integration's own system. The `objects` table carries this as two nullable columns with a partial unique index:

`packages/db/src/schema.ts`:

```typescript
  (table) => [
    uniqueIndex("objects_external_idx")
      .on(table.externalSystem, table.externalId)
      .where(sql`external_system IS NOT NULL`),
```

`ObjectStore.write` looks the incoming external identity up via `findByExternal` (`packages/db/src/object-store.ts`) before doing anything else; a match calls `appendTo` on the existing row rather than inserting a new one. A caller-supplied `objectId` that already exists is treated the same way — "the same gesture arriving twice, not a collision" (`packages/db/src/object-store.ts`), which is what makes a retried write idempotent (principle 9). Content identical to the latest version writes no new version at all (`appendTo`, `packages/db/src/object-store.ts`): a re-read that changed nothing is not a change.

Every write goes through the blob store rather than storing content in the row directly, so a large document spills to a content-addressed file and identical content across versions is stored once (`packages/db/src/object-store.ts`, §8 below).

## 2. Versions and the unified retention story

### 2.1 What a version is

A change to an object's content produces a new version, `object_versions` (`packages/db/src/schema.ts`), ordinal 1-based and monotonic per object (`ordinal`, unique on `(object_id, ordinal)` at `packages/db/src/schema.ts`). Each version row carries its own `content_hash`, a pointer to its content blob, a card/summary rendering, an optional delta against the prior version, and two retention flags present since the very first migration:

`packages/core/src/versions.ts`:

```typescript
export interface RetentionMetadata {
  /** A run consumed this version; run history must stay comparable (§4.4). */
  readonly runReferenced: boolean;
  /** Referenced by a pinned run — the human's word for "never compact this". */
  readonly pinned: boolean;
}
```

### 2.2 The compaction predicate

The rule lives as one pure function, asserted directly in tests, so no store restates it:

`packages/core/src/versions.ts`:

```typescript
export function isCompactable(
  version: ObjectVersion,
  context: {
    readonly isLatest: boolean;
    readonly now: number;
    readonly policy: CompactionPolicy;
  },
): boolean {
  if (context.isLatest) return false;
  if (version.pinned) return false;
  if (version.runReferenced) return false;
  return version.createdAt < context.now - context.policy.windowSeconds;
}
```

A version is compactable only when it is an unreferenced, non-latest, non-pinned **intermediate**, older than the window — `DEFAULT_COMPACTION_POLICY.windowSeconds` is `30 * 24 * 60 * 60` (`packages/core/src/versions.ts`), i.e. 30 days. `ObjectStore.compactVersions` mirrors the predicate as a query — never the latest version of its object, not run-referenced, not pinned, older than the cutoff (`packages/db/src/object-store.ts`) — and removes each candidate's version row and blob references inside its own transaction, one per candidate rather than one for the whole sweep, "because a partial sweep is fine, a partial _candidate_ is not" (`packages/db/src/object-store.ts`). `markRunReferenced` and `setPinned` are what a run and a pin write into these flags (`packages/db/src/object-store.ts`).

This rule bounds **connector churn only** — the sync-every-five-minutes noise on world objects (spec §3.2). Nothing is retained forever by default and nothing referenced is ever lost — both deliberate (`packages/core/src/versions.ts`, spec §3.2).

### 2.3 Run-history retention (the second half of the same story)

Run history has its **own** rule, over `runs` rather than `object_versions`, because a version compacted for one reason must not silently make a run uncomparable (spec §4.4). It keeps the last N runs per command _definition_, plus everything inside a window, plus anything pinned, plus — critically — anything a live `@latest` address currently resolves to:

`packages/core/src/runs.ts`:

```typescript
export function isRunCompactable(
  run: RunRetentionFacts,
  context: { readonly now: number; readonly policy: RunRetentionPolicy },
): boolean {
  if (run.pinned) return false;
  if (run.addressedByLatest) return false;
  if (run.recencyRank <= context.policy.keepPerDefinition) return false;
  return run.startedAt < context.now - context.policy.windowSeconds;
}
```

Defaults: `keepPerDefinition: 20`, `windowSeconds: 30 * 24 * 60 * 60` — "the window matches version compaction so the two rules cannot disagree about how old 'old' is" (`packages/core/src/runs.ts`). `RunStore.compactRuns` ranks all runs per definition (newest first), computes which run ids `output@latest` currently resolves to (`addressedByLatest`), and deletes each doomed run's blob reference and row inside its own transaction (`packages/db/src/run-store.ts`).

Pinning is the human's word for "never compact this," and it is transitive: `RunStore.pin` marks the run's own row, re-references its assembled-content blob as pinned, and calls `objectStore.setPinned` over every version the run referenced (`packages/db/src/run-store.ts`) — a pinned run and everything it references is never compacted (spec §3.2, §15 invariant 3).

### 2.4 Transcript blob release (bounded transcripts, not version compaction)

A long transcript is bounded by a **different mechanism again** — not version compaction, not run retention, but blob release. `BlobStore.release` (`packages/db/src/blob-store.ts`) drops only the external file for a blob whose size warranted spilling to disk (never inline content — "releasing 64KB buys nothing"), keeping the row itself so a marker can be drawn and the content reloaded. `releaseCandidates(ownerKind, ownerId, limit)` returns the largest referenced, still-external, unreleased blobs first (`packages/db/src/blob-store.ts`) — "releases the largest old tool outputs" (spec §6.1). Reading a released blob throws `BlobReleasedError` rather than returning nothing (`packages/db/src/blob-store.ts`); re-`put`ting the same content restores it transparently (`packages/db/src/blob-store.ts`). Nothing here deletes a row, and nothing here is version or run compaction — it is a third, independent retention mechanism scoped to one owner's blobs.

### 2.5 Triage windows

Triage decisions (acknowledge/snooze/mute) are persisted per attention item, not time-boxed by any compaction job — see §7 below; there is no separate "triage retention" rule to state here, and none is asserted in the code.

### 2.6 The three mechanisms, side by side

| Mechanism             | Governs                   | Predicate                                                                   | Default window                   |
| --------------------- | ------------------------- | --------------------------------------------------------------------------- | -------------------------------- |
| Version compaction    | `object_versions`         | `isCompactable` (`packages/core/src/versions.ts`)                           | 30 days                          |
| Run-history retention | `runs`                    | `isRunCompactable` (`packages/core/src/runs.ts`)                            | 30 days, last 20 per definition  |
| Blob release          | `blobs.is_external` bytes | `BlobStore.release` / `releaseCandidates` (`packages/db/src/blob-store.ts`) | none — driven by size, on demand |

`Maintenance.compact` (`packages/db/src/maintenance.ts`) runs all three in one deliberate order — `runStore.compactRuns` first (releases `run_referenced` from the versions they held), then `objectStore.compactVersions` (drops blob references), then `blobStore.compact()` last, "when the graph of references has finished shrinking." `BlobStore.compact()` itself removes only blobs with zero remaining `blob_refs` rows — pinned or not, a reference is a reference; retention decides which references to drop, and this only removes what nothing points at (`packages/db/src/blob-store.ts`). Rows are deleted before files, in one transaction, specifically because the opposite order can leave a row whose bytes are gone — "silent content loss," worse than wasted disk (`packages/db/src/blob-store.ts`).

## 3. The graph: nodes, edges, authorship, and session lineage

### 3.1 Nodes and edges

`nodes` (`packages/db/src/migrations.ts`, `packages/db/src/schema.ts`) is one row per placed thing on the board — `role` is `content | command | session`, `ref_id` names the object/command/session it stands for, and `deleted_at` makes placement itself an authored, undoable gesture (principle 10). `edges` (`packages/db/src/migrations.ts`, `packages/db/src/schema.ts`) is one table for both edge kinds, distinguished by a CHECK constraint that makes §15 invariant 2 — every context edge records its author — a schema fact rather than a convention:

`packages/db/src/migrations.ts`:

```typescript
        CHECK (
          (author_kind = 'session' AND author_session IS NOT NULL) OR
```

`packages/db/src/schema.ts` states the fuller shape: `authorKind` is `human | session | system`, NOT NULL by design, and provenance edges carry the reserved author `"system"` — "a statement about who recorded it, not an unknown." Context edges are unique per `(from_node, to_node)` while live (`edges_context_unique_idx`), and their `ordinal` (assembly order, §3.5) is unique per `to_node` while live (`edges_context_ordinal_idx`, both `packages/db/src/migrations.ts`). `Author` (`packages/core/src/author.ts`) is a closed union with no "unknown" variant, "which is why this type has no fallback variant — retrofitting one later would make the graph unable to say who decided what agents know" (`packages/core/src/author.ts`). `ProvenanceKind` (`packages/core/src/edges.ts`) names the seven relations the graph records with meaning: `command_declares_output`, `command_started_session`, `session_created_object`, `session_forked_from`, `session_handoff`, `session_sibling`, `session_delegated`. `checkConnection` (`packages/core/src/edges.ts`) is the one function that decides legality for every surface: content → command, content → running session, nothing else.

Provenance edges are recorded as work happens and are never authored (§3.7), so there is no gesture that removes one — `GraphStore.removeEdge` (`packages/db/src/graph-store.ts`) refuses outright for a non-context edge: "removing the record that a session created an object would make the graph lie about what happened, and no undo restores a history nobody can see is missing."

### 3.2 Session lineage: a separate table from provenance

`session_lineage` is a distinct, minimal table — one row per session, a self-referencing `initiated_by` naming the parent session or null for a human gesture:

`packages/db/src/migrations.ts`:

```typescript
      -- means a human gesture started this session.
      CREATE TABLE session_lineage (
        session_id    TEXT PRIMARY KEY,
        initiated_by  TEXT REFERENCES session_lineage (session_id),
        created_at    INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX session_lineage_parent_idx ON session_lineage (initiated_by);
```

This is deliberately separate from the richer, meaning-carrying `session_forked_from` / `session_handoff` / `session_sibling` / `session_delegated` provenance edges: `session_lineage` exists purely as the enforcement substrate for principle 1's reflexivity rule (`packages/db/src/migrations.ts`), and `GraphStore.recordLineage`/`lineageIndex` are its only writer and reader (`packages/db/src/graph-store.ts`). `LineageIndex` (`packages/core/src/lineage.ts`) exposes exactly one method, `parentOf`, and `ancestorsOf`/`isInSameChain`/`checkAuthoring` (`packages/core/src/lineage.ts`) are the pure predicates built on top of it — the enforcement side of this table is `docs/enforcement.md`'s subject, linked rather than restated here.

## 4. Runs: what a row captures verbatim

`runs` (`packages/db/src/schema.ts`) is one row per run, and §15 invariant 1 is enforced by what the columns are, not by convention: `commandId`/`definitionId` (FKs), `ordinal`, `status` (`running | completed | failed | out_of_budget | stopped | interrupted`), `assembledBlobId`/`assembledHash`/`assembledBytes`, and `configJson` are all NOT NULL. `assembledBlobId`/`assembledHash`/`assembledBytes` are the exact bytes handed to the agent, stored once through the blob store and hashed independently of it (§15 invariant 1: "not just versions"). `configJson` is `RunConfiguration` (`packages/core/src/runs.ts`) serialized whole — the definition name, the instruction _as it read at run time_, the model, permissions, effective ask points, lifecycle, expected outcome, confirmed parameters, and budget — because "reading the definition again later answers a different question" (`packages/core/src/runs.ts`).

Inputs and outputs are separate tables (`packages/db/src/schema.ts`), each foreign-keyed to `object_versions` rather than to `objects`, which is what makes them survive an object's later edits unchanged. `run_inputs` is PK'd `(runId, ordinal)` and carries `nodeId` (nullable), `objectId`, `versionId`, `contentHash`, `bytes` — one row per consumed version, in assembly order. `run_outputs` is PK'd `(runId, name)` and carries `objectId`/`versionId` — "one row per produced output, per run" (§15 invariant 4). `run_inputs.ordinal` records assembly order, mirroring the context edge's own `ordinal` (spec §3.5). Ordinal uniqueness on the run itself is per-command — `runs_ordinal_idx` uniques `(commandId, ordinal)` (`packages/db/src/schema.ts`) — so "the n in `output@n`" never collides across commands. `RunStore.start` writes the run row, every `run_inputs` row, and calls `objects.markRunReferenced` on every consumed version, all inside one transaction — "§15-1 is all-or-nothing: a run row without its inputs, or inputs whose versions were never marked retained, is the uncomparable half-record the invariant exists to prevent" (`packages/db/src/run-store.ts`).

## 5. The address grammar: `command/name@latest|@ordinal|@run`

`OutputAddress` (`packages/core/src/output-address.ts`) is a closed union over exactly the cases the spec names: `at: "latest"`, `at: "ordinal"` (the `runOrdinal`, 1-based per command), `at: "pinned"` (a specific pinned run id), and `at: "run"` (any specific run id). The module's own doc comment states why `latest` is one case among several, never the only one:

`packages/core/src/output-address.ts`:

```typescript
 * Spec §15 invariant 4: outputs are addressed per run. `latest` is one case of
 * a general address, never the only case — a system built on "the output"
 * cannot grow run comparison later (§4.4).
 *
 * `output@n` — the run's ordinal within its command — is the general form the
 * spec names. `latest` is written as its own variant because it is what the
 * user types, but it is *resolved* by ordering runs, never stored: nothing in
 * the schema records which run is latest.
```

`RunStore.resolve` is the one function that turns an address into a `RunOutput`: it joins `run_outputs` to `runs` on `command_id` + `name`, orders candidates by `runs.ordinal DESC`, and picks the head for `latest`, a matching `ordinal` for `at: "ordinal"`, or a matching `runId` otherwise (`packages/db/src/run-store.ts`) — "derived here and stored nowhere, so a new run never rewrites what `output@1` means" (`packages/db/src/run-store.ts`).

**Open extension: in-session addressing (issue [#136](https://github.com/andyhite/plotroom/issues/136)).** Today this grammar exists for the canvas and the HTTP surface only — a session has no way to name an object version, a run output, a transcript, or the queue from inside its own tool calls. Issue #136 records the gap explicitly: `apps/session-host` pins eleven filesystem-shaped tools (`read`, `write`, `edit`, …) and none of them address PlotRoom content; the proposed shape borrows omp's own internal-URL-scheme pattern (`agent://`, `artifact://`, `local://`, etc.) rather than inventing a rival mechanism, with three constraints already decided: reads must pass the same predicates and refusals as the equivalent HTTP route (principle 8), the actor is the binding's and never carried in the address itself, and an address names something already on the graph — no new content kind, no new edge kind (§3.1, §3.7).

## 6. Sessions and session-adjacent records

### 6.1 Sessions

`sessions` (`packages/db/src/schema.ts`) is one record per live-or-completed agent run — never a distinction between live and stored (spec §3.6). Everything derived from observation (phase, accounting totals) is a **fold, not a source of truth**: "`session_observations` is the truth it folds from, so a restart recomputes rather than trusts it (principle 7)." Key columns: `mode` (`producing | open`, the two lifecycles), `initiatedByKind`/`initiatedBySession` (mirrors `session_lineage` on the row itself for convenience), `runtimeMode` (`native | seeded`, how a fork actually ran), `transcriptObjectId` and `planObjectId` (both pointers into `objects` — the transcript and the plan are content, not special-cased tables), `phaseJson` ("derived by PlotRoom, never agent-reported"), and the closed `endKind` enum: `completed | ended-by-user | stopped | out-of-budget | failed | interrupted`. A null `endKind` is what "live" means (spec §3.6, principle 11 — out-of-budget and interrupted are their own outcomes, not failure).

### 6.2 Observations

`session_observations` (`packages/db/src/schema.ts`) is PlotRoom's own append-only log of what a session did — "not vendor payloads" (`packages/db/src/schema.ts`) — keyed `(session_id, seq)` with `seq` 1-based per session as the ordering primitive, `at` the adapter's own observation timestamp, and `kind` + `observation_json` for the polymorphic payload. Everything else about a session (phases, accounting, the transcript, resume, fork) is derived from replaying this log.

### 6.3 Transcript and plan publication

`session_transcript_publications` (`packages/db/src/schema.ts`) is one row per published transcript checkpoint — the spec's checkpoint rule (§3.6/§6.1: a live transcript versions on checkpoint, not on every turn). `trigger` is `checkpoint | session-end`; `objectId`/`versionId` are the transcript's own object version at that checkpoint. Migration 34 folded the plan's own object/version onto the _same_ publication row (`planObjectId`/`planVersionId`, nullable — "a session with no plan yet … publishes a transcript version with no plan version beside it," `packages/db/src/schema.ts`) rather than a second ordinal-counting mechanism (`packages/db/src/migrations.ts`).

### 6.4 Injections

`session_injections` (`packages/db/src/schema.ts`) is the steering ledger: `origin` is `steering | condition-feedback | budget-notice`, distinguishing authored human/session steering (which leaves a permanent content node, `nodeId`) from the product's own world-condition or budget feedback (which authors nothing). Queue acceptance and delivery are recorded as separate facts on the row rather than inferred (`packages/db/src/schema.ts`).

### 6.5 Questions

`session_questions` (`packages/db/src/schema.ts`) carries the options verbatim (`optionsJson`), `freeForm` (`none | allowed`), and answer fields `answerOptionId`/`answerText`/`answerByKind` (`human` only). There is deliberately no default-on-timeout column anywhere in this table — "§6.4's prohibition is structural in `@plotroom/core`, and a column for one here is where it would come back" (`packages/db/src/schema.ts`).

### 6.6 Broadcasts

Three tables. `broadcasts` (`packages/db/src/schema.ts`) is one row per broadcast regardless of recipient count, with `scopeJson` (a session's declared material-state scope) and `targetJson` (an operator's chosen target) mutually exclusive by convention. `broadcast_recipients` (`packages/db/src/schema.ts`) is who received one and the injection it became, plus `baselineCostMicros`/`inducedMicros` for the spend the broadcast caused that recipient (§6.5's "induced spend counts against the sender's budget chain"). `broadcast_sends` (`packages/db/src/schema.ts`) is the per-sender rate-limit window as rows, "because a count cannot answer 'in the last hour' after a restart" (`packages/db/src/schema.ts`).

### 6.7 Handoff briefs

`handoff_briefs` (`packages/db/src/schema.ts`) drafts and reviews in one table, because the draft→reviewed transition is the point: `draftedByKind`/`draftedBySession` versus `reviewedByKind` (`human` only), `draftText` preserved alongside the (possibly rewritten) `text`, and `edited` flagging whether the human changed it. "Only a reviewed brief may be sent, which core makes a type error and the schema makes unrepresentable" (`packages/db/src/schema.ts`).

## 7. Claims, budgets, spend, approvals, pre-grants, triage, and settings (inventory)

These tables' _enforcement_ — the claim manager's deadlock detection, the budget predicate, the approval gate, the reflexivity check — is `docs/enforcement.md`'s subject. This section is the record inventory only.

| Table                                                                                  | Key columns                                                                                                                                                   | Purpose                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claims` (`packages/db/src/schema.ts`)                                                 | `pathKey`/`pathDisplay`, `holderKind`/`holderSession`, `grantedFromClaimId`, `leaseSeconds`, `releasedAt`/`releaseReason`                                     | A path claim at rest — one writer per path, a lease not a lock (spec §3.4).                                                                                                                          |
| `claim_waits` (`packages/db/src/schema.ts`)                                            | `blockedByJson` (availability), `authorizedAt` (authorization), `grantorClaimId`                                                                              | The visible waitlist: two independent gates on one row.                                                                                                                                              |
| `claim_policies` (`packages/db/src/schema.ts`)                                         | `subtreeKey`, `effect` (`allow\|deny`), `pattern`, `withdrawnAt`                                                                                              | Pre-granted claim policy, so a subtree can be claimed without a round trip.                                                                                                                          |
| `path_writes` / `path_reads` (`packages/db/src/schema.ts`)                             | `pathKey`, `holderKind`/`sessionId`, `at`                                                                                                                     | The write/read ledger claim-precise divergence detection needs (§3.4).                                                                                                                               |
| `spend_attributions` (`packages/db/src/schema.ts`)                                     | `sessionId`, `sourceSessionId`, `basis` (`own\|descendant`), `cause`, `amountMicros`                                                                          | Spend folded up the initiating chain; `cause` distinguishes a cumulative `accounting` row from a per-broadcast `broadcast:<id>` charge (§6.5, §8).                                                   |
| `budgets` (`packages/db/src/schema.ts`)                                                | `scope` (`workstream\|global`), `limitMicros`, `period`, `warnFraction`, `origin`                                                                             | Optional budgets at workstream and global scope; run/batch scope lives on the run itself (§4.1) rather than here.                                                                                    |
| `budget_notices` (`packages/db/src/schema.ts`)                                         | `bindingKind`/`bindingId`, `kind` (`near-cap\|stopped`)                                                                                                       | What a session has already been told, as rows rather than a counter, so a restart between warning and cap does not warn twice.                                                                       |
| `approvals` (`packages/db/src/schema.ts`)                                              | `kind` (`tool-permission\|claim\|destruction\|integration-write\|standing-instruction`), `askJson`, `answerDecision`, `effectFailureMessage`/`effectFailedAt` | One row per capability ask; outlives the call it blocks (spec §6.6).                                                                                                                                 |
| `pre_grants` (`packages/db/src/schema.ts`)                                             | `scope` (`session\|workstream`), `effect` (`allow\|deny`), `toolPattern`, `extentsJson`, `withdrawnAt`                                                        | Capability granted (or refused) in advance by a human; withdrawn, never deleted, so "revoked yesterday" and "never granted" stay distinct facts.                                                     |
| `attention_triage` (`packages/db/src/schema.ts`)                                       | `(itemId, consumer)` PK, `verb` (`acknowledge\|snooze\|mute`), `snoozedUntil`, `baselineVersionId`                                                            | Triage decisions, keyed by the attention item's own stable id (§4.5).                                                                                                                                |
| `notification_routes` / `notification_route_fires` (`packages/db/src/schema.ts`)       | `state` (`blocked\|failed\|wants-decision\|anything`), `destinationUrl`, fire ledger keyed `(route, item)`                                                    | Outbound routing attaches to a _state_, never a node (§7.3); the fire ledger keeps the edge-trigger honest across restarts.                                                                          |
| `standing_instructions` / `standing_instruction_opt_ins` (`packages/db/src/schema.ts`) | `objectId` (a marker on a world object, never a tenth kind), `declaredByKind` (`human` only), per-workstream opt-in with its own author                       | Standing instructions and their opt-ins (§3.8).                                                                                                                                                      |
| `proposals` (`packages/db/src/schema.ts`)                                              | `tool`, `inputJson`, `targetKind`/`targetId`, `state` (`pending\|accepted\|rejected`), `decidedByKind` (`human` only)                                         | A session's proposal awaiting human acceptance — decides nothing itself (§3.8, principle 1).                                                                                                         |
| `settings` (`packages/db/src/schema.ts`)                                               | `key` PK, `valueJson`                                                                                                                                         | An override from its env-derived default; absence means the default applies. Stores only the current value, never the setting's shape (that catalog is code, `apps/server/src/settings/catalog.ts`). |

## 8. Blobs: content-addressed storage, dedup, and release

`blobs` (`packages/db/src/schema.ts`) is hybrid storage: content at or below `INLINE_MAX_BYTES` (64 KiB, `packages/db/src/schema.ts`) lives in the row (`inlineBytes`); larger content spills to a file under the state directory's `blobs/` tree, addressed by its sha256 `hash`. `blob_refs` (`packages/db/src/schema.ts`) makes retention a query rather than a guess: one row per `(blob_id, owner_kind, owner_id)`, with a `pinned` flag.

Dedup happens in `BlobStore.put`: an existing row with the same hash is reused and reported `deduped: true` rather than writing new bytes (`packages/db/src/blob-store.ts`) — "assembled run content repeats heavily across runs" (`packages/db/src/blob-store.ts`). Release (`packages/db/src/blob-store.ts`) and compaction (`packages/db/src/blob-store.ts`) are covered in §2.4 and §2.6 above as part of the unified retention story; they are not repeated here.

## 9. Search: FTS5 and its truncation contract

`search` is an FTS5 virtual table (`packages/db/src/search.ts`), index-only and kind-agnostic: only the `session` kind is populated as of Epic 8.2, but any future producer can write `note`, `ticket`, etc. into the same table without a schema change. Ranking weights title over location over body:

`packages/db/src/search.ts`:

```typescript
const TITLE_WEIGHT = 10.0;
const LOCATION_WEIGHT = 4.0;
const BODY_WEIGHT = 1.0;
```

matching spec §6.8's "ranked over title, location, and content." `toLiteralFtsQuery` (`packages/db/src/search.ts`) converts operator-typed free text into a literal FTS5 phrase query — every term double-quoted, doubling embedded quotes — so a hyphenated ticket id, a branch name, or a stray `*`/`(` is always search text, never accidental FTS5 grammar; there is deliberately no way through this function to reach raw FTS5 operators (`packages/db/src/search.ts`).

**The truncation contract.** `DEFAULT_SEARCH_LIMIT` is 25 (`packages/db/src/search.ts`), exported specifically so a caller that must report truncation "has to know the limit it is actually under" (no-silent-truncation, `AGENTS.md`). The route layer clamps further, to `MAX_SEARCH_LIMIT = 100` (`apps/server/src/routes/search.ts`), and — critically — never clamps silently: it asks the index for one hit past the applied limit and drops it, so `truncated` is an **observed** fact ("there are more") rather than inferred from `hits.length === limit`, which is also true of a query whose last hit is its last hit — a clamped result that said nothing about being clamped would be silent truncation, which this repository does not do. A deleted session stays findable through search — a deliberate stance (issue #77), distinct from archived: nothing removes a deleted record from the index or filters one out of a query, because deletion's one meaning everywhere is "mark the record and leave the reads alone" (`apps/server/src/routes/search.ts`). "Archived" is itself never stored in the index row; it is resolved fresh, per hit, from the referenced entity's own current record (`apps/server/src/routes/search.ts`).

## 10. Soft deletion, tombstones, and restorability

The pattern is one shape, repeated: a nullable `deleted_at` (or `removed_at`/`archived_at` for the two entities with a distinct non-delete inactive state) that a `delete`/`restore` pair flips (idempotent — deleting an already-deleted row is a no-op), plus `deleted()`/`live()` (or `restorable()`) queries over it. `ObjectStore.delete` (`packages/db/src/object-store.ts`) is the canonical instance, with the comment stating why the versions underneath are untouched: "a run that consumed this object must remain comparable (§15-1), and an undone deletion that lost the content would not be an undo" (`packages/db/src/object-store.ts`). The same shape recurs at `SessionStore.delete`/`restore`/`deleted` (`packages/db/src/session-store.ts`) and `WorkstreamStore`'s equivalent methods (`packages/db/src/workstream-store.ts`, where the archive gesture — `archivedAt` — is a distinct, separate state from deletion: "archived is 'off the board, still searchable, reported as archived'; deleted is 'undone, and undoable'," `packages/db/src/schema.ts`).

The graph is the one place deletion is a **coordinated cascade rather than a single flag**. `GraphStore.removeNode` stamps the node's own `deleted_at` and every live edge touching it with the _same_ timestamp, in one transaction, "so restoring the node puts back exactly what its removal took down and nothing a later gesture removed separately" (`packages/db/src/graph-store.ts`); `restoreNode` reads that same stamp back to find exactly those edges (`packages/db/src/graph-store.ts`). Restoring a node is refused while its own subject record is still deleted — `subject_deleted` — because a node with nothing behind it is not a restore (`packages/db/src/graph-store.ts`). Context edges can be removed and restored individually (`removeEdge`/`restoreEdge`, `packages/db/src/graph-store.ts`); provenance edges cannot be removed at all, by design (§3.1 above).

Every table with a `deleted_at` column: `objects` (`packages/db/src/schema.ts`), `nodes` (`packages/db/src/schema.ts`), `edges` (`packages/db/src/schema.ts`), `workstreams` (`packages/db/src/schema.ts`), `command_definitions` and `commands` (`packages/db/src/schema.ts` — added in the first cut, before objects/workstreams caught up: "delete a workstream" and "delete an object" had no representation that could be undone until migration 10 added it, `packages/db/src/migrations.ts`), and `sessions` (`packages/db/src/schema.ts`). Every one of these is recoverable — "deletion is recoverable for authored state — the arrangement and the topology are authored work nobody can recreate — including when an agent did the deleting" (spec principle 10).

`Maintenance.reset("everything")` is the one place all of this is bypassed rather than respected: it truncates every table in `CLEAR_ORDER` (`packages/db/src/maintenance.ts`) — a dependency-ordered list, not an inferred one, "because the order _is_ the dependency graph and an inferred one would quietly change when a table is added" (`packages/db/src/maintenance.ts`) — and states what it destroys before doing it (`resetPlan`, `packages/db/src/maintenance.ts`).

## 11. The four schema-shaped invariants, and what makes each hold

Spec §15 names four invariants as "schema-shaped rather than feature-shaped: get them wrong and every historical record is permanently degraded." Each maps to specific records and constraints above:

1. **Run history records the full assembled content and configuration.** Enforced by `runs.assembledBlobId`/`assembledHash`/`assembledBytes`/`configJson` all being NOT NULL (`packages/db/src/schema.ts`, §4 above), and by `RunStore.start` writing the run row, its `run_inputs`, and the version-retention flags inside one transaction so no partial run can exist (`packages/db/src/run-store.ts`).
2. **Every context edge records its author.** Enforced by the `edges` table's CHECK constraint tying `kind = 'context'` to a non-null `author_kind`/`author_session` pairing (`packages/db/src/migrations.ts`, `packages/db/src/schema.ts`), and by `Author` (`packages/core/src/author.ts`) having no "unknown" variant to retreat to.
3. **Version retention with the compaction rule.** Enforced by `isCompactable` (`packages/core/src/versions.ts`) as the single predicate `ObjectStore.compactVersions` mirrors, by the `runReferenced`/`pinned` flags present on every version since the first migration, and by `run_inputs`/`run_outputs` foreign-keying to `object_versions` rather than `objects` — a version a run consumed literally cannot be deleted out from under a live run row.
4. **Per-run output addressing.** Enforced by `OutputAddress` (`packages/core/src/output-address.ts`) being a closed union with `latest` as one case among four, by `runs.ordinal` being unique per command (`packages/db/src/schema.ts`) so `output@n` is stable, and by `RunStore.resolve` deriving `latest` from ordering at read time rather than storing it anywhere (`packages/db/src/run-store.ts`) — issue #136 tracks extending this same grammar to addressing from inside a session.
