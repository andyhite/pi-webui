# Batch 5 report — Weeks 19–23, Plugins (Phase 7)

**Range:** `5eb1a78..decc613` — 45 commits, all fast-forward merges, `pnpm verify`
green at every merge and on the final tree.

**Gate — PASSED.** All four in-box plugins (coding-git, GitHub, Filesystem, Jira)
load in their own `worker_threads` on the public contract v1 and report `ready`;
a deliberately throwing plugin (plus a crashing and a manifest-less one) degrades
to `unavailable` with its reason on `GET /api/plugins` while the server and every
other plugin keep answering. Proven by
`apps/server/src/plugins/plugins.integration.test.ts` (describe blocks named
`THE BATCH 5 GATE: …`), 107/107 in the plugins suite. The W10/W14/W18 milestone
e2e suites (`milestone`, `steering`, `batch4-gate`) re-run green on the final
tree, twice consecutively.

## What landed, by track

**Track C** (`feat/plugin-contract`, `feat/in-box-plugins`,
`feat/jira-standing-instructions`):

- Epic 7.1: the contract froze at `CONTRACT_VERSION = 1`
  (`docs/plugin-contract.md`) — all twelve §10.1 contribution points as stable
  types, host dispatch with per-invocation permission gating, per-call credential
  injection + redaction, version refusal/warning, bounded restarts, four
  lifecycle verbs without restart, and plugins-cannot-author-intent enforced
  (host-supplied `CoreId` actor, tool-without-actor refused).
- Epic 7.3: `packages/plugins/git` (workspace kind's six methods, diff/commit
  producers, condition checks, four read-only tools — deliberately **no** write
  action, so committing stays native and claim-gated), `packages/plugins/github`
  (four producers, four write actions with per-action reversibility, real
  read-backs against a recorded stateful fixture, clone-from-PR card action with
  no write action behind it), `packages/plugins/jira` (issues as tickets,
  epics-with-children as collections via content + co-produced members joined on
  external id, JQL scoping, five write actions, recorded fixture that lies to
  prove read-back honesty).
- Epic 7.4 core: `standing-instructions.ts` rules — world-scope/kind refusals,
  opt-in-only resolution, stable assembly order, self-proposal refused at gate
  and model, human-as-author on acceptance.

**Track A** (`feat/integration-substrate`, `feat/plugin-wiring`,
`feat/standing-instructions-server`):

- Epic 7.2: the integration substrate — refresh modes (scheduled reads only,
  structurally incapable of initiating a run), runtime-configurable scoping,
  refresh → version bump → drift, write actions through the §6.6 gate with the
  read-back being the re-read (never the plugin's claim), connect flows with
  operator-only verbs enforced by actor, the `integration-broken` health alert
  derived from observed failure, `CredentialStore` with no read path but the
  per-call injection seam (migration 24).
- Plugin platform wiring: the worker host replaced the direct-invocation seam;
  `IN_BOX_PLUGINS` installed at boot plus `PLOTROOM_PLUGINS_DIR` scanned on
  gesture; `/api/plugins` lifecycle + health surface (operator-only writes, no
  agent tool — recorded rationale: no spec line grants a session plugin
  enumeration); permission raises route into §6.6 approvals with the call
  blocked until answered; `plugin_grants` (migration 25); the compile-time
  `PermissionRaise` ↔ `ApprovalAsk` assertion; persisted disable
  (`plugin_disablements`, migration 28).
- Epic 7.4 server half: migrations 26/27 (standing instructions/opt-ins/
  proposals; the approvals CHECK rebuild for the new
  `ApprovalKind 'standing-instruction'` — never pre-grantable, structurally and
  by name), the six routes + reject, assembly prepend in `RunStore.plan` (the
  run path reads the same plan), the §7.1 queue row.

**Track B** (`feat/filesystem-plugin`, `feat/register-jira-ui`):

- Renderer contribution registry (cards degrade to the host's generic rendering
  when a plugin's renderer is missing or throws), plugin panels behind a
  `plugin:` id prefix, palette entries, and the plugin health panel naming
  §10.2's states — honest-empty in LIVE until the real lifecycle stream is
  consumed.
- `packages/plugins/filesystem`: files/directories as documents keyed on
  absolute path, bounded reads reported in-band **and** through
  `RenderedContent.truncated`, on-demand refresh (observed mode deferred — no
  push seam exists).
- All four plugins' renderer contributions registered through
  `IN_BOX_PLUGIN_MODULES`.

**Cross-cutting regression fix** (`fix/batch4-gate-regression`): registering the
plugins' host manifests in the browser crashed the bundle at module scope
(`tmpdir()` under Vite's `node:os` stub) — the batch 4 gate e2e caught it. Each
plugin now ships a browser-safe `./renderer-manifest` half (identity declared
once, spread by the host manifest); guards added and break-verified (ESLint ban
on `node:*`/`Buffer`/`process` across every renderer-reachable module, a UI test
pinning renderer-contributions-only).

## Operator decisions

- **Plugin distribution + permission-grant UX** — decided and confirmed by the
  operator mid-batch; recorded in AGENTS.md. Distribution v1 = in-box +
  configured directory ("configured source" deferred with reasons); grants are
  operator-only; ungranted runtime reach raises through §6.6 with the call
  blocked; sandboxing documented as future work.
- Orchestrator-level calls within existing patterns (not operator-level):
  the contract spells `pull_request` as core does; a standing-instruction
  proposal is its own `ApprovalKind` (not an overloaded `tool-permission`);
  no `plugins_read` agent tool.

## Non-blocking findings carried forward

1. `contribution-registry.ts` "disjoint kind set" comment is now false (Jira's
   `ticket`/`document` overlap GitHub's/Filesystem's; first-registered-wins),
   and two Jira test names overstate which renderer they resolve.
2. Displayed integration state `out-of-date` vs spec §10.2's wording
   "out of date" (identifier vs display text).
3. A throwing card/content **renderer** degrades silently — the "reported" half
   of §10.2 needs the plugin health event stream consumed by the UI (the server
   publishes `plugin` events; the panel still reads honest-empty).
4. Host `invoke` has a narrow hang race (crash between `#authorize` and pending
   registration); restart bound is per failure streak, not total;
   `remove()` publishes `state: "disabled"` (no `removed` member).
5. `readPermissionIds` silently drops non-string entries; an unreadable
   plugins-root directory is indistinguishable from an empty one.
6. Epic 7.2's observed refresh mode has no push seam (manual-refresh-only), and
   a broken integration is excluded from the schedule so it never self-heals
   without an operator gesture.
7. No proposal-read tool in the catalog — a proposing session cannot poll its
   own proposal's outcome (recorded as a catalog decision, not made).
8. `ProposalService`'s proposable-tool whitelist is server policy with no core
   predicate (fine at two tools); the accepted-retire path calls
   `retireStandingInstruction` directly (core refuses it as `wrong_tool` by
   design).
9. Pre-batch-5 queue entries whose command's edge ordinals had gaps will
   one-time re-ask at admission (safe direction, §4.1).
10. The renderer/host manifest split means a contribution added only to a host
    manifest will not appear in the browser until also added to
    `renderer-manifest.ts`; the unit test catches the reverse mistake only.
    The ESLint override's file list is maintained by hand.

## Deliberately deferred (unticked, with reasons recorded in the plan)

- Epic 7.1 "from a configured source" distribution.
- Epic 7.2 per-kind delta expression.
- The git workspace kind mounted behind the six `workspace.*` invocations, and
  the `clone-from-pull-request` card-action dispatch (both recorded in Epic
  7.3's landed note with three concrete reasons each — the five contract gaps
  the port found are written down there too).

## Residual risks for sign-off

- Network/filesystem scopes are **declared trust, not a sandbox** (documented
  posture, §10.2's honest v1).
- Git mechanics now exist twice (native + plugin) by design; §3.4 rule changes
  must land in both.
- GitHub/Jira coverage is recorded-fixture-shaped; no live API schema check.
- The e2e suites serve `apps/web/dist` — a stale build can mask or manufacture
  failures (bit us once this batch); build before e2e.
