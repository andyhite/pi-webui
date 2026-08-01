# Batch report — Weeks 6–7 (Batch 1: Server)

**Scope:** Epic 2.1 + 2.2 (Track A), Epic 3.4 + finish 3.0 (Track B), Epic 4.3
(Track C). **Gate (Sync 2): passed** — the canvas loads live server state via
`GET /api/snapshot` and applies `/ws` DomainEvents, proven by
`apps/web/src/data-source/live.integration.test.ts` against a real spawned
server (illegal-edge refusal included).

## Merged (fast-forward, in order)

1. `feat/git-workspaces` → `45763ed` (3 commits) — workspace-kind contract,
   git kind (provisioning, readiness, live status, divergence, discovery,
   cost), host-auth invariant enforced by tests.
2. `feat/server-api` → `3e0435d` (16 commits) — Hono backbone, one DomainEvent
   vocabulary + `/ws`, operator credential, loopback-default bind, origin/host
   validation, structured logs with redaction, full graph/workstream API with
   attribution, predicate-backed refusals, undo/restore; plus review follow-ups
   (event-cascade publication, deleted-node refusals, provenance-not-authored,
   constant-time credential compare) and two Epic 1.4 deferrals fixed
   (deleted command refused from running; transactional run/command writes).
3. `feat/server-snapshot` → `3671a6e` (2 commits) — `GET /api/snapshot` with
   `seq`, transaction-consistent, documented WS resync recipe.
4. `feat/palette-and-shell` → `7d2202e` (30 commits) — palette rail, command
   palette, dock rail + panel registry, machine-readable graph warnings (all
   five §5 kinds incl. content-budget), single-origin transport + dev proxy,
   port/state-dir knob, Electron spawn-or-attach (single-instance lock,
   crash listener), fixtures→live API switch, Sync 2 gate test.

All reviews by fresh-context Fable reviewers; one blocking finding total
(Track B plan-tick overclaiming the state-dir clause) — fixed and re-verified.
`pnpm verify` green on main after every merge; all worktrees removed, branches
deleted.

## Non-blocking findings recorded (not fixed, tracked)

- **Workspaces:** host-auth _source-scan_ tests are evadable tripwires (the
  behavioral env assertion covers provisioning only — extend to every kind
  method later); `ReadinessRecord` is not per-root (decide `rootKey` or
  attempts-as-list **before** Phase-2 persistence schematizes it); default-
  branch protection silently inert when git exposes no default; `occupied`
  provision reason declared but never produced; `mirrorCacheKey` can collide;
  `checkRootOwnership` normalizes trailing slash only (server must
  canonicalize paths); registry re-register silently overwrites;
  `HOST_GIT_ENV_ALLOWLIST` omits `GIT_SSH_COMMAND`/`GIT_CONFIG_GLOBAL`.
- **Server:** `X-PlotRoom-Actor` forgeable — carried into Epic 4.5 as a plan
  note (runtime layer must set the actor); WS credential travels as a query
  param (redacted from our logs; note for proxied deployments).
- **UI:** PlotCanvas's additive sync doesn't reconcile live _deletions_ into
  an open canvas without reload; per-event object-content fetches are N+1 and
  a failed fetch under-sizes the content-budget warning silently; palette
  unblocked-first ordering inert (no blocks relationship in the model yet);
  sessions absent from palette (no sessions API yet); integration tests use
  fixed port bases rather than port 0.

## Residual risks

- Sessions/transcripts/drift still have **no persistence** (deferred from 1.5
  to Phase 2 by design); Batch 2's runs work and Batch 3's steering need the
  sessions schema — first call on Track A in Batch 2.
- Epic 3.1's durable-placement item remains localStorage-backed; server-side
  placement persistence is now possible and should ride a Batch 2 B slot.
- Electron verified via one manual xvfb run + automated spawn/attach logic
  tests; no packaged build yet (Epic 8.4; tooling decided: electron-builder).

## Operator decisions

- **Electron packaging: electron-builder** — decided under the operator's
  standing autonomous-judgment directive, recorded in AGENTS.md.
