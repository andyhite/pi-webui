# Batch report — Weeks 15–18 (Batch 4: Attention & money)

**Scope:** Epic 6.2 + 6.4 (Track A), Epic 6.1 (Track B + Track A stage 2),
Epic 6.3 + 7.1 draft (Track C). **Gate: PASSED and in CI** —
`apps/web/e2e/batch4-gate.spec.ts`: an operator-set run cap binds a
delegated child transitively and the capped session ends **out-of-budget,
rendered distinctly from failed** on every surface; the queue answers a
question, an approval (unblocking the session's real blocked call), and a
drift item in-row with the Conversation panel provably never opened.
Break-verified twice (author + reviewer independently).

## Merged (fast-forward, in order)

1. `feat/approvals` → `3f9b0e2` — approval domain (branded PreGrantableAsk:
   irreversibility pierces pre-grants structurally; reversible external
   writes ask unless pre-granted — review-forced fix; destruction-class
   catalog metadata; unknown reversibility = irreversible; settlesAsk
   tool+target matching) + the Epic 7.1 DRAFT contract (all twelve §10.1
   contribution points as draft types; permission-grant UX marked open).
2. `feat/attention-queue` stage 1 → `db9c656` — queue/what-changed/fleet/
   timeline panels, all attention surfaces from ONE data source, Electron
   badge over a minimal contextBridge, edge-triggered notifications,
   Batch-3 carry-overs (handoff UI, continue-vs-fresh UI, question
   reconnect fix), docs/attention-contract.md (snooze semantics made
   normative in review).
3. `feat/budgets` → `0cef7a1` — transitive budget enforcement (tightest
   binding wins; ancestors' attributed totals; batch caps made transitive
   in review — the delegated-spend evasion; broadcast charge re-key fixing
   clobber AND double-charge), $25/day shipped default global ceiling
   (migration 20, AGENTS.md), near-cap one-shot notices, out-of-budget end
   state end-to-end, run comparison + cross-run outcomes.
4. `feat/attention-backend` → `5f320cb` — server attention derivation (six
   feeds, id-stable, hide-at-source), health alerts from observation only
   (idle/spinning/conflict-predicted both forms/unanswered/blocked-on-you),
   approvals endpoints + destruction guard (202 raise, session-attributed
   execution), outbound webhook routes (state-attached, edge-triggered,
   redaction whitelist, persistent fire ledger), fleet/activity endpoints;
   review-forced: deny-re-raise wedge fix, blocked-call approval loop
   e2e tests, checkDeletion backstop, route-read actor gating.
5. `feat/attention-queue` stage 2 → `87920f4` — live attention/fleet/
   activity wiring + the batch gate.

## Non-blocking findings recorded

- Spinning health alert can false-positive for sessions under unbounded
  pre-grants (no path rows recorded — direction disclosed as safer).
- Health thresholds configurable in code only (env knobs → Epic 8.3).
- Batch cap can count one turn twice when siblings broadcast to each other
  (conservative direction); overlapping broadcast induced windows can
  over-charge (bounded by the 3/hr rate limit).
- A rewritten broadcast core test carries a misleading comment (production
  path correct; spec property covered elsewhere).
- batch4-gate spec doc-comment overstates which assertion fails on break
  (plan doc has it right).
- Triage accepts nonexistent item ids silently; live list() overwrite race
  (nothing calls it); bubble/dock-rail z-order overlap awaits the design
  pass; no settings UI for notification routes yet (Epic 8.3).
- Per-session `waiting-approval` phase while a 202 destruction is pending
  (phase-accuracy quibble, disclosed).

## Carry-overs → Batch 5

- None structural. Notification-route settings UI and threshold env knobs
  belong to Epic 8.3 (Batch 6 Track A).

## Residual risks

- Real-pi end-to-end still spike-only (standing item since Batch 2).
- Plugin contract is DRAFT — Batch 5 freezes it; the §10.1 shapes got a
  full Fable review this batch, reducing freeze risk.

## Operator decisions

None new. Orchestrator decisions recorded: $25/day default global ceiling
(AGENTS.md); reversible external writes must-ask unless pre-granted (spec
reading, in code + plan note); absent world declaration ≠ irreversible
(judgement call recorded in plan note).
