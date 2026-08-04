---
name: plotroom-governance
description: PlotRoom's governance subsystems and the rules behind their tables — attention derivation, path claims, spend attribution, budgets, approvals and pre-grants, triage, outbound routes, plugin grants, and standing instructions. Read before editing approvals, claims, budgets, attention, plugins, or standing instructions.
---

# Attention, claims, money, approvals, plugins, standing instructions

Every rule below lives as a predicate in `@plotroom/core`; the stores apply effects and decide nothing. A store that re-derives a decision is the second implementation principle 8 exists to prevent.

**Attention is one derivation** (`@plotroom/core`'s `attention/`, joined by
`apps/server/src/attention/`). Six feeds — questions, approvals, drift, health,
completions, broadcasts — become one ranked list, and **hiding is the source's job**:
a muted item never leaves the server again, a snoozed one does not leave until its
time is up, and no surface holds a ledger of its own. Every item id is derived from
the fact behind it, because the outbound edge-trigger and the queue's selection both
fold state forward by id. §7.2's five health alerts are derived **from observation
only**, with configurable thresholds. The queue is re-derived when something is
observed to change, plus a slow tick (`PLOTROOM_ATTENTION_TICK_SECONDS`, default 30)
for the two facts elapsed time alone makes true — a threshold coming due and a snooze
elapsing. That tick is a scheduled **read** and initiates nothing (principle 2); the
stance is stated in `attention/tick.ts`. Outbound routes (§7.3) attach to a state,
fire edge-triggered by item id, and carry a **whitelist**: titles and summaries pass,
content bodies never.

**Path claims** live in `claims` / `claim_waits` / `claim_policies`, with the
write ledger in `path_writes` / `path_reads` (migration 11). The tables are
`@plotroom/core`'s `ClaimState` at rest and nothing more: `ClaimStore` applies the
`ClaimEffect` list and decides nothing, because a store that re-derived "is this
path held" would be the second implementation principle 8 exists to prevent. Two
CHECKs make an illegal state unrepresentable rather than merely refused — a holder
with no session id, and a non-root claim with no lease, since only the operator's
root claim is immortal. Rows are retired rather than deleted so a release and an
expiry stay different events. `ClaimService` (`apps/server/src/claims/`) sweeps
lapsed leases **before every decision**, publishes `claim` / `claim_wait` /
`claim_policy` on the one event stream, and enforces the operator-only verbs by the
request's actor rather than by the tool catalog's flag. Every runtime write passes
`decideToolPermission` before it runs; a driver with no gate wired **denies**.

**Spend attribution** lives in `spend_attributions` (migrations 12 and 22): one row per
(charged session, spender, **cause**), replaced rather than accumulated _within_ a
cause, because the accounting total is folded from the observation log and the same
spend observed twice must be charged once. The cause is in the key because two writers
share the table and mean different things by a number: an `accounting` row restates a
spender's **cumulative** total, a `broadcast:<id>` row is one broadcast's **increment**
(§6.5). Keyed on the pair alone, a second broadcast from one sender silently replaced
the first, and either writer could overwrite the other with a number measuring
something else. An induced charge never bills whoever the fold already bills — the
recipient and its own ancestors — so every induced row is `descendant` and a
recipient's turn reaches a workstream or fleet total once. `own` rows only for a
workstream or fleet total, or a delegated dollar would be counted once per ancestor —
but a **run or batch cap counts rows charged to** its sessions, both bases, because a
cap that counted only `own` rows is one any session walks around by delegating. Attribution happens **whenever the accounting
fold moves**, not at session end, because a fleet view that admitted a running
session's cost only once it stopped would be wrong for exactly as long as work was in
flight. Nothing ever zeroes these rows: "today's total" is a **window** over `at`
taken at read time (UTC day), never a reset, and no timer is involved (principle 2).
The data starts at the first delegation because attribution that starts later cannot
answer what an earlier chain cost.

**Budgets** live in `budgets` and `budget_notices` (migrations 20 and 21). Two scopes
are rows — workstream and global — and the **run/batch scope deliberately is not**: a
run's cap is what was accepted at its preview and already lives on the run
(`runs.spend_cap_micros`, §4.1), and a second copy of a cap is a second source of
truth about what the operator agreed to. `limit_micros` is NOT NULL and _removing_ a
budget deletes the row, so "raise or remove" is two verbs rather than a nullable
number that also means removed. Which caps bind a session, and which is tightest, is
`@plotroom/core`'s `resolveEffectiveBudget` and nothing else's — the pre-run refusal,
the session-facing read, and the mid-session enforcement all call it, so they cannot
disagree (principle 8). Binding is **transitive**: a session is bound by every
ancestor's run and batch caps as well as its own, because an ancestor's cap counts
that ancestor's attributed total, which already includes what its chain delegated. A
batch's cap counts every entry's attributed total for the same reason, and summing
them double-counts nothing because entries of one batch are siblings, never each
other's ancestors.
`budget_notices` is rows for the same reason the broadcast rate window is: a restart
between the near-cap warning and the cap must not warn the session twice, and "have I
already told it?" cannot be answered from memory. The warning and the stop notice
reach a session as an injection with `origin = 'budget-notice'` — PlotRoom answering,
authoring nothing, rendered as the transcript's `feedback` entry sourced to `budget`
(migration 21 widened that CHECK by rebuild).

**Approvals, triage, and outbound routes** live in `approvals`, `pre_grants`,
`attention_triage`, `notification_routes` and `notification_route_fires`
(migration 23). An approval is a row because it **outlives the call it blocks**
(§6.6), and it is matched by what it blocks rather than by whose it is: `settlesAsk`
compares tool and target, so a target-less ask matches on the tool alone — the gate
therefore matches by **call id** (unique per session and call, so a re-raise finds
the row already waiting), the queue answers by **approval id**, and only a
destruction ask is matched by target. A raised approval leaves the runtime call
**blocked**, like a question: sending the refusal that accompanies a raise would
settle the call before anybody was asked. Pre-grants have no expiry column, because
one that lapsed on a clock would change what an agent may do with nobody behind it
(principle 2), and are withdrawn rather than deleted. `attention_triage` is
`@plotroom/core`'s `TriageLedger` at rest, keyed by the attention item's own stable
id for **every** feed rather than for drift alone — durable because a snooze held in
memory returns the moment the server does. A notification route attaches to a
**state** and has no node column beside it (§7.3); what it has already sent is rows,
so a restart cannot re-fire every open item, and a delivery failure is route health
rather than an exception.

**Plugin grants** live in `plugin_grants` (migration 25), and the only other thing about
a plugin that is persisted is whether the operator **disabled** it
(`plugin_disablements`, migration 28 — a row means disabled, an absence means enabled,
and removing the plugin deletes the row). Nothing else: which plugins exist is the
build's (in-box) or the operator's directory's, and health is a running worker's
property, so a row for either would be a second source of truth about something
observable. A disable is not in that category — it is a **decision**, and one held only
in the registry came back undone at the next boot. Two states and an absence: a
`granted` or `denied` row, and **no row means never-asked** — the state that raises
through §6.6 the moment a plugin reaches for the permission, so removing a grant is
deleting the row rather than writing a third state (the same "grant or remove" shape
budgets use). No expiry column, because a grant lapsing on a clock would change what a
plugin may do with nobody behind it (principle 2), which is also why the contract's
`PermissionState` has no `expired` member. Every write to this table is the operator's
(`POST /api/plugins/:id/grants`, or answering the §6.6 approval a raise produced) and
there is **no agent tool for any plugin verb at all** — principle 1, the same reason
there is none that raises a budget. The server-side wiring is
`apps/server/src/plugins/`: one `PluginRegistry`, one worker per enabled plugin, every
producer read and write action performed through `PluginHost.invoke`, and
`plugins/raise.ts` holding the compile-time assertion that `PermissionRaise` stays
assignable to `ApprovalAsk` — the server is the only package that can see both types,
so enum drift on either side breaks the build.

**Standing instructions** live in `standing_instructions` /
`standing_instruction_opt_ins` and `proposals` (migration 26). A standing instruction is
a **marker on a world object, never a tenth `ObjectKind`**, so the table names an object
and holds no content of its own; `declared_by_kind` can only say `human` and
`decided_by_kind` on a proposal likewise, because a store reached without the predicate
must not be able to write the fact principle 1 exists to prevent. A partial unique index
on a live `object_id` makes `already_standing` unrepresentable as well as refused. Markers
retire and opt-ins opt out; nothing is deleted. **Availability is resolved at assembly,
not fanned out into edges**: `RunStore.plan` prepends `resolveStandingInstructions`'s
answer before the wired inputs (and `start()` reads that same plan), so a run's recorded
assembled content already contains them (§15-1) — which is also why a standing input's
`run_inputs.node_id` is null and why input ordinals are sequential over the whole
assembly rather than copied from the edge. `proposals` is `ToolProposal` at rest with
`decideProposal` as its only transition; a pending one reaches §7.1 through the approvals
channel as the `standing-instruction` kind, and an **accepted retire** is performed by
calling `retireStandingInstruction` as the human directly, because core deliberately has
no apply helper for it.
