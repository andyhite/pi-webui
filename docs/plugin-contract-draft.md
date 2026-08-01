# Plugin contract — DRAFT (Epic 7.1)

**Status: draft, unstable, frozen by nothing.** The interfaces live in
[`packages/plugin-sdk/src/draft/`](../packages/plugin-sdk/src/draft/) and are
exported as `draft.*` from `@plotroom/plugin-sdk`. `CONTRACT_VERSION` is still
`0`; the host still speaks only load / ping / dispose. **Nothing is wired.**

Behavior remains defined by [`product-spec.md`](product-spec.md) §10. This
document is the reviewable form of a drafting exercise, not a decision record.

## Why this exists a batch early

Every contribution point in §10.1 already has a **native implementation** in the
product. Epic 7.3 then ports the in-box four onto the public contract. A contract
drawn without reading those implementations is a contract the port fails against
— and the failure arrives at the end of Phase 7, when the shape is hardest to
change. So the shapes are drafted now, each one pointing at the code that
currently does the job, and the freeze becomes a reconciliation.

## The mapping, point by point (§10.1)

| §10.1 contribution  | Draft type               | Native implementation today                                                                         |
| ------------------- | ------------------------ | --------------------------------------------------------------------------------------------------- |
| concept producers   | `DraftConceptProducer`   | `ObjectStore` external-identity reconciliation (Epic 1.1); git reads (Epic 4.4)                     |
| write actions       | `DraftWriteAction`       | `ToolWorldDeclaration` + write intents + `toolCallAsk` (Epics 5.4, 6.3)                             |
| agent tools         | `DraftAgentTool`         | `AGENT_TOOL_CATALOG` / `AgentTool` (Epic 4.5)                                                       |
| content renderers   | `DraftContentRenderer`   | `ObjectRenderings` and the version delta model (Epic 1.1)                                           |
| card renderers      | `DraftCardRenderer`      | the canvas node renderers in `@plotroom/ui` (Epic 3.x)                                              |
| panels              | `DraftPanel`             | the app's own panels (Epic 3.4)                                                                     |
| palette entries     | `DraftPaletteEntry`      | the command palette (Epics 3.4, 8.1)                                                                |
| workspace kinds     | `DraftWorkspaceKind`     | `@plotroom/core`'s `workspaces/` subtree: `kind`, `lifecycle`, `readiness`, `divergence` (Epic 4.4) |
| condition checks    | `DraftConditionCheck`    | the server's world-condition registry behind `checkProvenCompletion` (Epic 4.3)                     |
| notification routes | `DraftNotificationRoute` | outbound routing (Epic 6.1, Track B)                                                                |
| command definitions | `DraftCommandDefinition` | `CommandDefinition` (Epic 1.4)                                                                      |
| themes              | `DraftTheme`             | none — styling approach is an open decision (AGENTS.md)                                             |

Three of those are load-bearing for the freeze:

- **Write actions ← write-intents + reversibility.** `reversibility` is not
  optional and includes `"unknown"`, treated as irreversible (principle 7). This
  is the same declaration that drives §6.6's irreversibility approvals and §6.3's
  outside-world markers, so a plugin author who omitted it would be
  pre-grantable by omission — the exact hole Epic 6.3 closed.
- **Workspace kinds ← the workspaces module.** The git kind is the most demanding
  contribution in §10.1. If it cannot be expressed here, the shape is wrong
  rather than git being special. `DraftDivergence.state` includes `"unreadable"`
  because divergence is observed, never inferred.
- **Condition checks ← the condition registry.** `"unknown"` is a distinct answer
  from `"unmet"`: a check that could not run has not disproved completion, and
  collapsing the two would make a flaky check read as a failed run.

## What the draft refuses to make expressible

- **No new concept kinds.** `DraftConceptKind` is closed (§3.1).
- **No authoring.** Nothing returns or accepts a context edge, and
  `DRAFT_CORE_CAPABILITIES` has no capability that draws one — "a plugin produces
  content, offers tools, and renders things; it does not draw connections between
  them" (§10.2, principle 1). A tool `call` receives no actor: it acts as the
  calling session, supplied by the host.
- **No credential values.** `DraftPermissionScope`'s `credential` variant carries
  an id and a system, never a secret (§9.3).
- **No silent truncation.** `DraftRenderedContent.truncated` is a fact the
  renderer reports (principle 12).
- **No timers.** `DraftRefreshMode` schedules **reads**; there is no contributed
  thing that starts a session (principle 2). `DraftPermissionState` has no
  `"expired"`.
- **No markup.** Card renderers return a declarative `DraftCardView` the host
  draws, so a plugin cannot break focus management for the whole board (§11).

## Declared permissions (§10.2)

`permissions.ts`. A request names its `kind`, its `scope`, a required `reason`
shown verbatim, and whether it is `requiredToLoad` — the host decides degradation
from that declaration, so a plugin cannot make itself essential. Grants are
`granted` / `denied` / `never-asked`: no `"partial"`, because a plugin operating
on half a grant is the silent reach §10.2 rules out.

### OPEN OPERATOR DECISION — the permission-grant UX

AGENTS.md lists "Plugin distribution and permission-grant UX" as open. **It is
still open.** Nothing in this draft decides it. The questions that need answering
before the freeze, stated so they can be answered rather than discovered:

1. **When is a grant asked for** — at install, at first use, or a hybrid where
   load-time needs are asked at install and the rest in context?
2. **Is a grant revocable while a plugin is enabled**, and does the plugin see an
   error or an absent capability?
3. **What happens when an update widens the request** — refuse and keep the old
   version, run degraded, or ask again? A plugin update must never silently gain
   reach.
4. **Does a grant travel with the state directory?** The store is the unit of
   backup and movement (§12): travelling means a copied store carries capability;
   not travelling means every move re-asks.
5. **Is there a trusted-publisher tier**, or is every plugin asked about
   identically? The in-box four are the interesting case — they ship with the
   product and are not obviously the user's decision to make.

## Known gaps in the draft

Recorded so the freeze does not mistake them for settled:

- **`DraftCardView` is the weakest shape here.** §10.1 asks for "in-canvas
  interactive surfaces", and a title-plus-lines-plus-actions view is the least
  that could work. Whether it is enough is a Phase 7 question a real renderer
  contribution answers.
- **Contract versioning is a number and a comparison, and nothing else yet.**
  §10.2's "refusal or warning rather than obscure failure" needs the refusal
  _rule_ (which mismatches warn, which refuse), which is Epic 7.1's own task.
- **Ids are `string`.** Core brands its ids and this package must not depend on
  core, so at the freeze these become declared opaque aliases the host validates
  at the boundary.
- **The lifecycle verbs are absent.** Install / enable / disable / remove without
  restart (§10.2) is host-side and is not drafted here; the draft covers what a
  plugin _contributes_, not how it is administered.
