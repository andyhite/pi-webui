# Plugin contract — v1, frozen (Epic 7.1)

**Status: frozen.** `CONTRACT_VERSION = 1`. The types live in
[`packages/plugin-sdk/src/contract/`](../packages/plugin-sdk/src/contract/) and are
exported from the package root; the host that runs them is `host.ts`, `registry.ts`,
`worker-entry.ts`. The draft (`draft.*`, `CONTRACT_VERSION = 0`) is gone — this
document replaces `plugin-contract-draft.md`.

Behavior is defined by [`product-spec.md`](product-spec.md) §10 (with §9 for
integrations and §3.4 for workspaces). This document says what the contract _is_,
what the host **enforces** versus what it only **documents**, and what changed from
the draft — because Track A is building the integration substrate against the draft
in parallel, and every rename it has to absorb is listed in one place below.

---

## 1. What a plugin is

A plugin is an ES module whose default export is a `PluginManifest`:

```ts
import type { PluginManifest } from "@plotroom/plugin-sdk";

export default {
  id: "github",
  name: "GitHub",
  version: "1.0.0",
  contractVersion: 1,
  permissions: [/* PermissionRequest[] */],
  contributions: {/* the twelve points, all optional */},
} satisfies PluginManifest;
```

Every plugin runs in **its own worker thread**. Its handlers stay in the worker; the
host sees a `PluginDescriptor` — the same declaration with the functions removed —
and reaches a handler by **contribution point plus id**. That is why every
contribution carries an id (an agent tool uses `name`, which the host normalizes).

A plugin compiles against the SDK alone. Nothing under `contract/` imports
`@plotroom/core`.

---

## 2. The twelve contribution points (§10.1)

| §10.1 contribution  | Type                            | Native counterpart it was reconciled against                                                      |
| ------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| concept producers   | `ConceptProducer`               | `ObjectStore` external-identity reconciliation (Epic 1.1); git reads (Epic 4.4)                   |
| write actions       | `WriteAction`                   | write intents + `ToolWorldDeclaration` + `toolCallAsk` (Epics 5.4, 6.3)                           |
| agent tools         | `AgentTool`                     | `AGENT_TOOL_CATALOG` / `AgentTool` (Epic 4.5)                                                     |
| content renderers   | `ContentRenderer`               | `ObjectRenderings` + the version delta model (Epic 1.1)                                           |
| card renderers      | `CardRenderer`                  | the canvas node renderers in `@plotroom/ui` (Epic 3.x)                                            |
| panels              | `Panel`                         | the dock rail's panel registry (Epic 3.4)                                                         |
| palette entries     | `PaletteEntry`                  | the command palette (Epics 3.4, 8.1)                                                              |
| workspace kinds     | `WorkspaceKind`                 | `@plotroom/core`'s `workspaces/`: `kind`, `readiness`, `divergence`, `lifecycle` (Epic 4.4)       |
| condition checks    | `ConditionCheck`                | the server's world-condition registry behind `checkProvenCompletion` (Epic 4.3)                   |
| notification routes | `NotificationRoute`             | outbound routing (Epic 6.1)                                                                       |
| command definitions | `CommandDefinitionContribution` | `CommandDefinition` (Epic 1.4)                                                                    |
| themes              | `Theme`                         | none — the UI styling approach is still an open decision (AGENTS.md), so only the shape is frozen |

Three shapes carry the weight:

- **Write actions ← write intents + reversibility.** `reversibility` is required and
  includes `"unknown"`, treated as irreversible (principle 7). Conformance refuses a
  write action without it, because an action that forgot to declare would be
  pre-grantable by omission — the hole §6.6 closes.
- **Workspace kinds ← core's `workspaces/`.** The git kind is the most demanding
  contribution in §10.1, so the plugin-facing kind is core's kind narrowed to what
  crosses a worker boundary as JSON: opaque config the kind validates itself,
  multi-root units (§13), provisioning cost and typed failure reasons, readiness
  states, and a **fingerprint** rather than a verdict — divergence is derived by core
  from fingerprints, and a root that could not be read reports itself unreadable
  rather than clean (principle 7).
- **Condition checks ← the condition registry.** `"unknown"` is a distinct answer
  from `"unmet"`: a check that could not run has not disproved completion.

### What the contract refuses to make expressible

- **No new concept kinds.** `CONCEPT_KINDS` is closed (§3.1).
- **No authoring.** Nothing returns or accepts a context edge, no core capability
  draws one, and `HOST_INJECTED_CAPABILITIES` is two names long (§10.2,
  principle 1). A test asserts the capability lists are edge-free.
- **No actor a plugin chooses.** `PluginCallContext.actor` is the host's, is
  non-null only for a tool call, and is typed `CoreId` — which a plugin cannot
  construct.
- **No credential values.** No field in this contract carries one (§9.3).
- **No silent truncation.** `RenderedContent.truncated` is a fact the renderer
  reports (principle 12).
- **No timers.** `RefreshMode` schedules **reads**; nothing contributed starts a
  session (principle 2). `PermissionState` has no `"expired"`.
- **No markup.** Card renderers and panels return a declarative `CardView` the host
  draws, so a plugin cannot break focus management for the whole board (§11).

---

## 3. What the host enforces, and what it only documents

§10.2's promises are worth nothing if the reader cannot tell which are in force.

| Promise                                         | v1 status                     | How                                                                                                             |
| ----------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Failure isolation (throw / hang / load-fail)    | **Enforced**                  | Per-plugin worker; every failure becomes `health: unavailable` with a reason. Tested for each case.             |
| Contract versioning: refusal or warning         | **Enforced**                  | `checkContractVersion` at load. Newer major refused, older supported warns, both numbers named in the sentence. |
| Conformance                                     | **Enforced**                  | `checkConformance` at load; problems are listed, not thrown.                                                    |
| Credentials never exposed                       | **Enforced**                  | Injected per call for granted names only; every injected value is redacted out of the result.                   |
| Core capabilities                               | **Enforced**                  | They gate what the host does with returned values; the worker is handed no function that performs one.          |
| Tools act as the calling session                | **Enforced**                  | Actor supplied per call by the host; a tool call with no actor is refused.                                      |
| Bounded restarts                                | **Enforced**                  | `DEFAULT_RESTART_POLICY` (2 restarts, backoff); a plugin that never loaded is not retried.                      |
| Install / enable / disable / remove, no restart | **Enforced**                  | `PluginRegistry`, plus a configured plugins directory.                                                          |
| Network scope                                   | **Documented, not sandboxed** | Declared, displayed, and granted — but the worker has Node's ordinary socket reach.                             |
| Filesystem scope                                | **Documented, not sandboxed** | Same: declared and granted, not confined.                                                                       |

**Network and filesystem sandboxing is future work**, and saying so is the point: a
declaration the operator reads as a boundary when it is a promise is worse than no
declaration. Confining a plugin needs a child process under Node's permission model
(or equivalent), which is a packaging and performance decision Epic 7.1 did not make.
What v1 does give is honest: the operator sees exactly what a plugin claims it will
reach, granting is their act, and a plugin that reaches past its grants for anything
the host mediates — credentials, core capabilities — is refused.

---

## 4. Declared permissions and grants (§10.2, §9.3)

A `PermissionRequest` names its `kind`, a `scope` of that kind, a required `reason`
shown verbatim, and whether it is `requiredToLoad` — so the host decides degradation
and a plugin cannot make itself essential. States are `granted` / `denied` /
`never-asked`: no `"partial"` (a plugin operating on half a grant is the silent reach
§10.2 rules out) and no `"expired"` (a grant lapsing on a clock would change what a
plugin may do with nobody behind it).

### The operator decision, recorded

**Grants are operator-only acts, made through the API or configuration at
install/enable time.** There is no agent tool that grants a permission, for the same
reason there is none that raises a budget (principle 1).

**A plugin's runtime reach for an ungranted permission raises through the existing
approvals channel (§6.6)** rather than through a bespoke plugin dialog. The host
refuses the call with a `PluginCallRefusedError` carrying a `PermissionRaise` whose
field names are §6.6's own (`kind`, `trigger`, `tool`, `summary`, `writeExtent`,
`paths`, `world`, `target`), so the server maps it onto an `ApprovalAsk` with no
translation table. Consequences worth stating:

- The call is **blocked**, like a question — a refusal sent alongside the raise would
  settle it before anybody was asked.
- A permission the operator already **denied** raises nothing: it was answered, and
  re-raising it would be asking again with nobody having changed anything.
- Grants take effect on the next call (`PluginHost.setGrants`); nothing is re-run.

Bespoke grant UX — an install-time dialog, a trusted-publisher tier, what an update
that widens a request does — waits for the design package. The five questions the
draft recorded are still the right questions; this decision answers only _where the
runtime ask goes_, which is what unblocked the freeze.

### Credentials

A plugin requests the **use** of a credential by id and system. The host holds the
secret, injects it into `context.credentials` for that one call, and scans whatever
the handler returns for the values it injected, replacing each with
`[redacted:<credentialId>]`. A plugin that echoes its token into a tool result hands
the calling session a marker. Values shorter than `MINIMUM_REDACTABLE_LENGTH` (4) are
not redacted — a one-character "credential" would corrupt every result that contained
that character, and is not a credential.

A granted credential the host does not have stored **refuses the call, saying so**: a
broken or expired connection is an integration health problem, never mysteriously
missing data (§9.3).

---

## 5. Lifecycle, health, and distribution (§10.2)

`PluginRegistry` is the state machine: `installed` → `enabled` ⇄ `disabled`, plus
remove. Installing reads the manifest in a throwaway worker and runs nothing;
enabling starts the worker and **health arrives as its own event**; disabling
disposes and keeps the record; removing disposes, forgets, and **deletes nothing on
disk** — the directory is the operator's (principle 10).

Health is `loading` / `ready` (with warnings) / `restarting` / `unavailable` (with a
reason) / `disposed`. Every transition is a `PluginRegistryEvent` for the server to
publish.

**Distribution:** v1 covers **in the box** (entries the app ships) and **from a
directory** (a configured plugins directory, one subdirectory per plugin, scanned on
demand — never on a timer, principle 2; the plugin's id comes from its manifest, not
from the directory name). **From a source the user configures** is **deferred**: it
needs fetching, verification, and an update path that must not silently widen
permissions, none of which Epic 7.1 decided.

---

## 6. Invocation

The host dispatches fourteen typed invocation kinds:

`concept.read` · `write.perform` · `tool.call` · `condition.check` ·
`content.render` · `content.delta` · `card.render` ·
`workspace.checkConfig` · `workspace.provision` · `workspace.runSetup` ·
`workspace.status` · `workspace.fingerprint` · `workspace.remove` ·
`palette.invoke`

Each is answered within `callTimeoutMs` or the plugin degrades to unavailable. **A
throw is a fault, not a result**: a handler that wants to report failure returns
`ok: false`; a handler that throws makes the plugin unavailable (§10.2).

The seven after `card.render` landed with Epic 7.3's in-box ports, exactly where this
section said they would: the git plugin is a real caller for a workspace kind, and
clone-from-a-pull-request is a real caller for a palette entry. **No contract type
changed** — `CONTRACT_VERSION` is still 1 — because dispatch is the host learning to
call a method the frozen contract already declared; a plugin built against v1 before
this is a plugin whose declared methods are now reachable.

One consequence is worth stating rather than discovering: **a palette entry answers
nothing and holds no reach**, so `palette.invoke` can only make a plugin log. An
entry that needs the host to _do_ something has no way to say so in v1; a card
action's `writeActionId` is the one route from a rendered surface into a host
operation, and it goes through §6.6 like any other write.

**Not yet dispatched, declaration-only in v1:** `Panel.render`,
`NotificationRoute.send`, and command definitions (which are copied in rather than
called). The types are frozen; the wiring lands with the substrate (Epic 7.2), where
there is a real caller to prove it against. Also deferred: `probeAncestry` — core's
`deriveDivergence` needs a reachability probe per root, and the kind contract the
plugin boundary narrows to JSON does not carry it, so a plugin-supplied kind cannot
distinguish a rebase from new commits (Epic 7.2's finding to close, and reported as
such by the git port).

---

## 7. Deviations from the draft

Track A is building against `draft.*`. Everything that changed, in one list:

1. **`Draft` prefix dropped, `draft.*` namespace gone.** Types export from the
   package root: `DraftConceptProducer` → `ConceptProducer`, and so on for all twelve.
2. **`DraftId` → `CoreId`** (branded, unconstructible by a plugin);
   `DraftEpochMillis` → `EpochMillis`.
3. **The manifest gained `id`** (the plugin's identity; `name` is now the display
   name) and **nests its contributions under `contributions`** rather than carrying
   twelve optional arrays at the top level.
4. **Every contribution has an id.** Content renderers and card renderers had none in
   the draft; a renderer the host cannot name is a renderer the host cannot call.
   Agent tools keep `name`.
5. **Handlers take a `PluginCallContext` as their last argument** — `call(input,
context)`, `read(request, context)`, `perform(input, context)`, and so on. It
   carries `invocationId`, `actor`, `credentials`, `grants`, and `log`.
6. **`AgentTool` gained `output: ToolOutputDeclaration`** — §10.1 says "declared
   inputs, **outputs**, permission requirements" and the draft declared no outputs.
7. **Permissions are declared per contribution**, not only on agent tools:
   `ConceptProducer`, `WriteAction`, `ConditionCheck`, `NotificationRoute` and
   `WorkspaceKind` each carry `permissions: PermissionId[]`. The host gates by the
   invoked contribution's list.
8. **`WorkspaceKind` was rebuilt against core's kind contract.** The draft's
   `provision` / `readiness` / `divergence` / `release` over paths became
   `checkConfig` / `provision` / `runSetup` / `status` / `fingerprint` / `remove`
   over an opaque config and multi-root units, with `ProvisionCost`,
   `PROVISION_FAILURE_REASONS`, `READINESS_STATES`, `WorkspaceFingerprint` and
   `RemovalOutcome` mirroring core's names. `divergence()` is gone: a kind reports a
   fingerprint and core derives the verdict.
9. **`DraftCommandDefinition` → `CommandDefinitionContribution`** (the unqualified
   name is core's, and prose about both was ambiguous).
10. **`DraftPermissionGrant` → `PermissionGrant` and gained `pluginId`**; a grant is
    identified across plugins, not within one.
11. **New surface the draft did not have:** `PermissionRaise` / `permissionRaise`
    (the operator decision above), `HOST_INJECTED_CAPABILITIES`,
    `CONTRIBUTION_POINTS` / `PluginDescriptor` / `ContributionDescriptor`,
    `readDescriptor` / `checkConformance`, `checkContractVersion`, `PluginRegistry`
    and its events, `redactCredentials`.
12. **`PluginModule` (the old ping-based host interface) is gone**, along with
    `PluginHost.ping`. `PluginHost.invoke` replaces it, and `PluginHealth.ready` now
    carries the descriptor and any version warnings rather than a bare name.
13. **`CONCEPT_KINDS` now mirrors core's `ObjectKind` spellings exactly.** The draft
    spelled the pull request kind `pull-request` while `@plotroom/core` spells it
    `pull_request`, so the draft's own claim to mirror core's object kinds was false
    for that one member. The contract member is `pull_request`; the two lists are now
    the same members with the same spellings, and a producer's declared kind is a core
    kind without translation. Track B built its renderer registry against the draft
    and translates at the boundary (`toDraftConceptKind`); that translation becomes
    the identity function at its rebase and should be deleted there. Corrected before
    the freeze rather than after, because a frozen misspelling is a translation every
    call site owes forever.

Unchanged from the draft, deliberately: the permission model's four properties and
three states, `RefreshMode`, `ScopingDeclaration`, `ReadResult`'s
present-or-absent `unavailable` list, `WriteResult`'s read-back, `RenderedContent`,
`CardView`, `ConditionResult`, `Notification`, and `Theme`.

---

## 8. Wiring contract for the server (Track A)

Nothing here is wired to `apps/server` yet; this is what the substrate mounts.

**Mounting.** One `PluginRegistry` per server:

```ts
new PluginRegistry({
  host: { credentials: (c) => credentialStore.value(c.system, c.credentialId) },
  grantsFor: (pluginId) => grantStore.forPlugin(pluginId), // PermissionGrant[]
  onEvent: (event) => bus.publish(event), // { type: "plugin", ... }
  now: () => clock.nowMillis(),
});
```

then `install(entry, "in-box")` for shipped plugins and `installFromDirectory(dir)`
for the configured plugins directory, both at boot and on an operator gesture.

**Endpoints** (all operator-only; there is no agent tool for any of them):

- `GET /api/plugins` — `registry.list()`, which is the §10.2 health surface.
- `POST /api/plugins/install` `{ entry }` → `InstallResult`; a failure is a 200 with
  the reason, not a 500.
- `POST /api/plugins/:id/enable`, `POST /api/plugins/:id/disable`,
  `DELETE /api/plugins/:id`.
- `POST /api/plugins/:id/grants` `{ permissionId, state }` → persist and
  `host.setGrants(...)`.

**Events.** `PluginRegistryEvent` is already the publish shape: `type: "plugin"`,
`pluginId`, `state`, `health`, `at`.

**Approvals.** Catch `PluginCallRefusedError`; when `error.raise` is non-null, raise a
§6.6 approval from it (the fields are `ApprovalAsk`'s) against the calling session,
and re-invoke when it settles as approved. When `raise` is null the call is simply
refused with `error.reason`.

**Agent tools.** Descriptor contributions with `point: "agent-tool"` become catalog
entries under a plugin-namespaced name; invoke with
`host.invoke({ kind: "tool.call", ... }, { actor })` where the actor is the
**request's** actor. A tool call with no actor is refused by the host, which is the
principle-1 backstop, not the primary check.

**Persisted grant shape.** One row per (plugin id, permission id): `state`
(`granted` / `denied`; absent means never-asked) and `answered_at`. Removing a grant
is deleting the row, not writing a third state — same shape as budgets.

## 9. Wiring contract for the renderer (Track B)

- **Cards:** `host.invoke({ kind: "card.render", contributionId, object, detail })`
  where `detail` is `"compact" | "expanded"`, answering `CardView`
  (`title`, `lines`, `actions[]`). An action with a non-null `writeActionId` goes
  through §6.6 exactly as a UI write does. Nodes stay DOM-based: the host draws the
  `CardView`, a plugin never supplies markup or a component.
- **Content:** `content.render` and `content.delta` answer `RenderedContent`, whose
  `truncated` is a fact to display, never to hide (principle 12).
- **Panels and palette entries** are declarations in v1 (`Panel.placement` is
  `"right" | "bottom"`; a `PaletteEntry` supplies its own description so the
  shortcuts overlay can list it). Their invocation lands with the substrate.
