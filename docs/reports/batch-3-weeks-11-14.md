# Batch report — Weeks 11–14 (Batch 3: Steering)

**Scope:** Epic 5.5 + claims/delegation server enforcement (Track A), Epics
5.1 finish + 5.3 (Track B), Epics 5.2 + 5.4 domain + pi inject/fork (Track C).
**Milestone gate: PASSED and in CI** — `apps/web/e2e/steering.spec.ts`: five
concurrent scripted sessions; inject mid-flight (delivered + graph content);
structured question answered inline from its bubble (break-verified twice —
author and reviewer independently — as WS-stream-dependent); stop at three
scopes with the server-enforced widest-scope confirm; stopped sessions end
`stopped`. The §15 invariant regression suite
(`apps/server/src/routes/invariants.integration.test.ts`) now runs in CI
continuously, per the batch exit criterion.

## Merged (fast-forward, in order)

1. `feat/bubbles-and-transcript` stage 1 → `6206ca4` — bubble model/placement
   engine (all five §5 constraints tested), transcript windowing (view, never
   truncation), diff/question data-source seams, checkpoint gesture. Two fix
   cycles (contained-node extents: dropped, then inert-at-call-site — fixed
   with call-site-shaped tests).
2. `feat/injection-and-forking` → `96b07c7` — injection-as-graph-act,
   structured questions (timed defaults structurally inexpressible, guards
   now actually typechecked in verify), broadcast (scope-of-material-state +
   scope_not_shared + category + rate + sender-chain spend), batch/stop/
   checkpoint/handoff/continue-vs-fresh/fork domain; pi adapter real
   inject-between-turns and fork (two live-pi defects found and fixed:
   steer-to-idle delivery, fork off-by-one). Two fix cycles.
3. `feat/scoped-runs` stage 1 → `718cff8` — claims persistence + DEFAULT-DENY
   write enforcement, delegation (provenance + spend up the chain), Epic 5.5
   (subgraph/what's-missing/re-run-drifted, global concurrency queue with
   202-queued contract, preview-is-the-contract re-ask, in-batch-inputs-are-
   the-contract rule), workspace diff endpoint, §15 invariant suite. Three
   fix cycles (queue wedge/restart-stranding/subgraph-re-ask, then two
   adjacent stranding shapes).
4. `feat/scoped-runs` stage 2 → `0150960` — all steering endpoints (inject,
   questions, broadcast, batches, stops, resume/fork/handoff, continuation
   preview), five build-time defects fixed, then three review cycles closing
   enforcement gaps (resume/fork reflexivity, handoff humanOnly) and the
   idempotency family ("a settled key names its whole gesture", migrations
   18–19), ephemeral-port test harness (kills the parallel-suite flake).
5. `feat/bubbles-and-transcript` stage 2 → `5263547` — live steering wiring
   (inject/questions/stop/diff/202-queue/resume-vs-fork-explicit), the
   node-id-vs-session-id bubble keying fix (fixture-invisible, gate-caught),
   the W14 gate.

## Non-blocking findings recorded (tracked)

- Queue: done-but-unbound producer edge takes run-path refusal (one wasted
  provision); in-batch exclusion blind spot (human edit to a produced object
  mid-wait doesn't re-ask — needs object-write authorship); cross-batch
  admission ordering documented.
- Steering: broadcast replay is sender-or-operator; refused deliveries now
  uncharged; repository-id under-inclusion documented (safe direction);
  GET /log-level now operator-only (behavior change); fork/handoff replay
  paths complete writes idempotently.
- UI: question-source reconnect re-sync is a no-op (bootstrapped guard) —
  a question raised during a WS outage waits for its next event; resume-vs-
  fork and queued-runs UI verified by inspection only; injection gate asserts
  ledger-names-a-node (edge coverage is server-side).
- pi adapter: fork mapping assumes pi's forkable-message ordering (spike is
  the canary against new pi releases); questionOutcome matches on label
  (duplicate labels now refused at authoring).

## Carry-overs → Batch 4

- Track B: handoff brief draft/review UI; continue-vs-fresh side-by-side
  preview UI (both disclosed deferrals, mechanics-level).
- Track B: question-source reconnect re-sync fix.
- PathRead capture still has no source (claim-precise divergence stays
  conservative until read extents exist).

## Residual risks

- No end-to-end test drives a REAL pi session through the server (spikes
  cover the adapter surface opt-in; the product proof is the scripted
  runtime). Standing risk item.
- Claims enforcement covers scripted write effects + pi write intents;
  agents using tools outside the declared write surface raise approvals
  (fail-safe, but UX-noisy until Phase 6 approvals land).

## Operator decisions

None outstanding. Orchestrator decisions this batch (recorded in AGENTS.md /
plan notes): concurrency limit binds initiation (202 contract) with default
4; in-batch-produced inputs are part of the queued contract; batch
stop/close/archive skip the lineage check (stopping isn't authoring intent);
repository identity = configured source; fork adapter never silently
substitutes seeded execution.
