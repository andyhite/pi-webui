# Batch report — Weeks 8–10 (Batch 2: First run)

**Scope:** Epic 4.2 + 2.3 + the unscheduled-but-prerequisite Epic 4.1 server
integration (Track A), Epic 5.1 start + Phase 3 polish (Track B), Epics
4.4 + 4.5 (Track C). **Milestone gate: PASSED and in CI** — drop command on
ticket → run → live-streamed transcript → proven completion, as
`apps/web/e2e/milestone.spec.ts` (Playwright, real server, scripted runtime,
real temp git repo). The gate's streaming leg is break-verified: neutralizing
the WS observation branch makes it fail.

## Merged (fast-forward, in order)

1. `feat/conversation-panels` stage 1 → `0aa1db3` — Conversation/Diff panels,
   SessionDataSource seam, drafts/history, deletion reconciliation, derived
   initial arrangement + reset verb (+2 fix commits from review: export
   completeness surfaced; one-shot arrangementEpoch reset).
2. `feat/context-assembly` stage 1 → `c92e1f8` — migration 7 (sessions,
   observation log, transcript publications, injections ledger, submissions,
   initiations, workspaces), pi + scripted runtime adapters over core's seam,
   run-one with §15-1/§15-4 capture, world-condition completion loop
   (feedback → continue → proven), idempotent initiation, interrupted-on-
   restart + graceful-shutdown interruption, session/run endpoints + events.
3. `feat/path-claims` → `8d71031` — full §3.4 claim manager (leases,
   hierarchical conflict, policies, waitlists, deadlock detection with live-
   edge invariants, expiry-aware writes, NFC path canonicalization), agent
   tool catalog pinned bidirectionally to real routes, reflexivity layer,
   actor-integrity bridge, delegation/spend-attribution shapes.
4. `feat/context-assembly` stage 2 → `f5f30b4` — run preview (pure read,
   byte-identical to execution), cost estimates as ranges with named basis,
   spend-cap recording, Epic 2.3 (portable state dir proven by test, reset
   verbs with dirty-workspace warnings read from git, §15-3 compaction job),
   arrangement persistence, migration 9 (interrupted runs), scripted-runtime
   `{delay}` pacing, catalog classification of stage-2 endpoints.
5. `feat/conversation-panels` stage 2 → `d79308d` — live session wiring, run
   gesture with double-click guard, the W10 Playwright gate (stream-dependent
   after one review-forced rework).

Review cycles: C needed two fix rounds (4 executable-repro blockers in the
claim manager — grant-under-deny stomping, deadlock endured on churn and on
immediate grants, immortal waitlist leases + NaN-immortal); B needed two
(reset verb inert on open canvas; export completeness discarded; gate
timing-masked); A had zero blockers across both stages (fix batches were
non-blocking hardening). All reviews fresh-context Fable.

## Non-blocking findings recorded

- Claims: leaseSeconds clamp [1s, 24h]; ancestor-policy carve-out records
  `grantedBy` as the passive holder (audit attribution follow-up); negative
  lease untested (same clamp branch); one parallel-run server test flake
  (port/CPU contention) — fixed-port bases in server integration tests remain.
- Server: `session:<id>` actor still trusted from loopback callers (the bridge
  sets it for real sessions; renderer/operator path is honest) — Phase 4/6
  hardening note stands in the plan; delegation wiring (session_delegated
  provenance + spend attribution when POST /api/runs carries a session actor)
  is Track A's first Batch-3 item (C's shapes are ready).
- UI: run-guard relies on React eager-updater evaluation (worst case a dropped
  click); missing .catch on runCommand (network failure leaves button stuck
  "running…"); WS reconnect mid-e2e would refetch (empirically doesn't occur);
  SessionDataSource opens its own /ws (not multiplexed with graph's);
  transcript refetch has no ordering guard; DiffPanel still fixture-fed (no
  workspace-diff endpoint yet — Batch 3).
- Compaction: foreign_key_check runs post-commit (stricter pre-commit check
  possible); no endpoint-level pinned assertion (store-level exists).

## Residual risks

- The pi adapter has no end-to-end test through the server (C6 permission
  gating is spike-proven against pi 0.83.0; the spine's proof is the scripted
  runtime). First real-runtime session is a Batch 3 risk item.
- Claims are domain-complete but not yet persisted/enforced at the server
  (C's store/endpoint contract delivered; Track A wires it in Batch 3 before
  steering multiplies concurrent writers).
- Injection endpoints don't exist yet (composer send disabled-with-reason) —
  Batch 3 Track C scope.

## Operator decisions

None new. (Catalog classifications of stage-2 endpoints — preview as agent
tool; maintenance/reset/pin/arrangement operator-only — decided by the
orchestrator with spec citations in the catalog entries.)
