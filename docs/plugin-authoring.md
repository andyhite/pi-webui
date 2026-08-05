# PlotRoom — Plugin Authoring Guide

**Scope.** A working guide for building a PlotRoom plugin — the manifest shape, the twelve contribution points, permissions and credentials, lifecycle and health, the constitutional limits every contribution operates inside, and a worked example against a real in-box plugin (spec §9, §10). The contract's normative source is `packages/plugin-sdk/src/contract/`; what plugins may never do is enforced where [enforcement](enforcement.md) says it is.

---

## 1. The manifest

A plugin is a module whose default export is a `PluginManifest` (`packages/plugin-sdk/src/contract/manifest.ts`):

```ts
interface PluginManifest {
  readonly id: PluginId;
  readonly name: string;
  readonly version: string;
  readonly contractVersion: number;
  readonly permissions: readonly PermissionRequest[];
  readonly contributions: PluginContributions;
  dispose?(): void | Promise<void>;
}
```

- **`id`** — stable, unique across installed plugins. The host namespaces everything (grants, health, log lines) by it.
- **`name`**, **`version`** — free text, shown on the health surface.
- **`contractVersion`** — the integer contract version the plugin was built against (today, `1`, `CONTRACT_VERSION`). The host compares it to what it implements and returns one of three verdicts (`checkContractVersion` in `versioning.ts`): `ok`, `warn` (older but still supported — the plugin loads, flagged out of date rather than broken), or `refuse` (newer than the host implements, or older than the host still supports — refused before it can fail somewhere obscure). Every verdict names both version numbers.
- **`permissions`** — the plugin's declared reach; see §3.
- **`contributions`** — an object with one optional array per contribution point (`conceptProducers`, `writeActions`, `agentTools`, `contentRenderers`, `cardRenderers`, `panels`, `paletteEntries`, `workspaceKinds`, `conditionChecks`, `notificationRoutes`, `commandDefinitions`, `themes`). Every key is optional: a plugin that contributes one thing declares one thing.
- **`dispose`** — called before the worker is torn down. A plugin that throws here is ignored; disposal is best-effort cleanup, not a gate.

### Conformance

Handlers are functions and cannot cross the worker boundary, so the host never sees your manifest — it sees a `PluginDescriptor`: the same declaration with every function replaced by nothing, sent from the worker as JSON. `readDescriptor` parses that JSON defensively (a malformed export becomes a list of `problems`, never a throw), and `checkConformance` then checks the semantic rules a schema alone can't:

- Every permission request states a non-empty `reason`, and its `scope.kind` matches its own `kind`.
- No two contributions at the same point share an `id` (an agent tool's `name` is normalized to `id` here), and no contribution's `id` is empty.
- A contribution asks only for permissions the manifest itself declared — a request nobody can see is the silent reach the contract rules out.
- A `write-action` declares a real `reversibility` (`"reversible"`, `"irreversible"`, or `"unknown"`) — an action that forgot would be pre-grantable by omission.
- A `command-definition` with `lifecycle: "producing"` names an `expectedOutcome`; one with `lifecycle: "open"` carries none.

A manifest that fails conformance makes **that plugin** unavailable with the problems listed. It never makes the product fail to start, and it never partially loads — conformance is all-or-nothing at the boundary.

---

## 2. The twelve contribution points

All twelve live in `packages/plugin-sdk/src/contract/contributions.ts`, addressed by the manifest key in `CONTRIBUTION_KEY_BY_POINT`. Every handler is invoked across the worker boundary and returns a promise; a throw makes the plugin unavailable rather than failing the one call.

1. **Concept producer** (`conceptProducers` → `ConceptProducer`) — how a plugin reads the outside world into objects. Declares the `kinds: ConceptKind[]` it populates (from the nine first-class kinds, §3.1), a `refresh: RefreshMode` (`on-demand`, `interval` with a period, or `observed` — the plugin notices something and tells the host, still a read), and a `scoping: ScopingDeclaration` (the source's own query language plus one example, e.g. JQL for Jira). `read(request, context)` returns whole objects keyed by stable `externalId`, so a re-read reconciles rather than duplicating; concepts are present or absent, never degraded — an object the read couldn't answer for is named in `unavailable` with why, not returned half-filled.

2. **Write action** (`writeActions` → `WriteAction`) — a write into the outside system, available as both a UI action and an agent tool. Declares `action` (a verb like `"merge"`, `"transition"`, `"comment"`, `"request-review"`), `system`, `input: ToolInputSchema`, and **must declare `reversibility`** (`"reversible" | "irreversible" | "unknown"`) — not optional, because an action that omitted it would be pre-grantable by omission. This is the load-bearing declaration behind §6.6's irreversibility approvals and §6.3's outside-world markers: `"unknown"` is treated as irreversible rather than silently becoming reversible. `perform(input, context)` returns a `WriteResult` whose `readBack` is what a re-read now says happened — the result is read back, never assumed, because external automation can move the target somewhere the request didn't ask for.

3. **Agent tool** (`agentTools` → `AgentTool`) — a tool in the session's catalog. Declares `input`, `output` (a one-line description for the catalog), and `requires: { mutates, writeActionId, permissions }` — a deliberate _subset_ of the host's own `ToolRequirements`: a plugin states what it needs, never its own reflexivity class or an exemption from it. `call(input, context)`'s `context.actor` is the calling session, supplied by the host and unsettable by the plugin (principle 1); its returned `content` has any credential value the host injected redacted out before it can reach the session.

4. **Content renderer** (`contentRenderers` → `ContentRenderer`) — agent-ready content for an object, plus its delta against a prior version. Declares the `kinds` it covers. `renderAgentContent` renders one version; `renderDelta(previous, next, context)` renders what changed — kind-specific, because "what's new" on a pull request isn't a diff of its description. Both return `RenderedContent { content, truncated }`, and `truncated` is a fact the renderer reports (never a silent cap, principle 12).

5. **Card renderer** (`cardRenderers` → `CardRenderer`) — the canvas card for an object, compact and expanded (`CardDetail`). `renderCard(object, detail, context)` returns a declarative `CardView { title, lines, actions }` the host draws — never markup, never a DOM handle — so a plugin card can't break focus management for the whole board. A `CardAction` with a non-null `writeActionId` routes through §6.6 exactly like any other write.

6. **Panel** (`panels` → `Panel`) — an entry in the dock rail. Declares `placement: "right" | "bottom"`; `render(context)` returns a `CardView`, same shape as a card.

7. **Palette entry** (`paletteEntries` → `PaletteEntry`) — a command-palette entry. Declares `label` and `description` (every binding is documented in the shortcuts overlay, so the entry supplies its own description); `invoke(context)` runs it.

8. **Workspace kind** (`workspaceKinds` → `WorkspaceKind`) — a workspace mechanism (git worktree, a plain directory, a composite) with its own provisioning, readiness, and divergence. Five handlers: `checkConfig` validates an opaque JSON `WorkspaceKindConfig` and **refuses with a reason rather than throwing**; `provision` creates the mechanism (called at first run, never at workstream creation) and returns roots, cost, and a log; `runSetup` runs the declared setup step feeding core's readiness gate; `status` reads live state per root (`WorkspaceUnitStatus[]` — never a cached belief); `fingerprint` returns the comparable snapshot divergence detection works over, reporting a root it couldn't read as `unreadable` rather than clean (divergence is observed, never inferred); `remove` tears down, honestly refusable. Multi-root is in the shape from the start (§13) — a composite kind reports N units, git reports one.

9. **Condition check** (`conditionChecks` → `ConditionCheck`) — a predicate for _proving_ completion (§10.1, principle 3). It reads, and only the host calls it — a check that could start work would be the product originating work. `check(input, context)` returns a `ConditionResult` with a three-way `state`: `"met"`, `"unmet"`, or `"unknown"` — `"unknown"` is distinct from `"unmet"`, so a check that couldn't run (no credential, no CI configured) never reads as disproved work.

10. **Notification route** (`notificationRoutes` → `NotificationRoute`) — an outbound destination. `send(payload, context)` receives a `Notification { title, body, at }` where `body` is **already whitelisted by the host** — a route never receives the full object content and is never trusted to redact it itself.

11. **Command definition** (`commandDefinitions` → `CommandDefinitionContribution`) — a starting-point command definition the operator can edit afterward; the host copies it in rather than the plugin owning it live. Declares `lifecycle: "producing" | "open"` and, exactly when `"producing"`, an `expectedOutcome`; `conditionCheckIds` names the checks (its own or another plugin's) that prove it.

12. **Theme** (`themes` → `Theme`) — named design tokens (`Record<string, string>`) the host applies as CSS custom properties. Values, never a stylesheet — same reasoning as the card renderer's declarative view.

Three rules constrain every one of the twelve (stated in `contributions.ts`'s own header, and expanded in §5 below): plugins populate first-class concepts and never add one; nothing a plugin contributes may draw a context edge or supply its own actor; a throwing handler is an unavailable plugin, never a crashed host.

---

## 3. Permissions and credentials

Declared in `packages/plugin-sdk/src/contract/permissions.ts`. A `PermissionRequest` is:

```ts
interface PermissionRequest {
  readonly id: PermissionId;
  readonly kind: PermissionKind; // "network" | "filesystem" | "credential" | "core-capability"
  readonly scope: PermissionScope; // matches kind
  readonly reason: string; // shown to the operator verbatim
  readonly requiredToLoad: boolean; // the host decides degradation from this
}
```

Four kinds of scope, each a shape rather than a policy:

- **`network`** — the hosts it will reach (`hosts: string[]`; `["*"]` is expressible and reads as blanket).
- **`filesystem`** — the roots it will read or write outside the state directory, with `access: "read" | "read-write"`.
- **`credential`** — a credential named **by id and system, never by value**. There is no variant of `PermissionScope` that carries a secret; the host holds it and injects the value into `context.credentials` at the call boundary, for granted names only, for that one call.
- **`core-capability`** — one of a short, closed list (`write-objects`, `read-objects`, `agent-tools`, `workspaces`, `notify`): a statement about what the _host_ will do with what the plugin returned, never a function handed into the worker. Deliberately missing anything that would author a context edge — that reach doesn't exist to request, grant, or add later.

Grants are the operator's act, always — three states and no fourth (`granted`, `denied`, `never-asked`; no `partial`, no `expired`, because a grant that could lapse silently would change what a plugin may do with nobody behind it). A call that reaches for an unanswered permission raises through the existing §6.6 approvals channel (`permissionRaise`) rather than a bespoke dialog — it blocks the call, exactly like a question, until the operator answers.

**Injected credential values never leave the host boundary.** They arrive in `context.credentials` for one call; the host redacts any of those values out of whatever the handler returns (`redactCredentials` in `credentials.ts`) before the result reaches an agent tool's caller or anywhere else. A session, another plugin, or a tool result never sees the secret — only the plugin's own call, for the duration of that call.

### What's enforced vs declarative-only in v1

Stated plainly, from the module's own header:

- **Credentials: enforced.** The worker starts with no ambient credential material; values are injected per call for granted ids only, and redacted out of results.
- **Core capabilities: enforced.** They gate what the host does with a plugin's return value; the worker is never handed a function that performs one itself.
- **Network and filesystem: declarative trust in v1.** The worker runs in the host process's own thread pool with Node's ordinary reach. PlotRoom records and displays these declarations and refuses ungranted _credentialed_ access, but it does **not** yet sandbox sockets or the filesystem. Full sandboxing (a permission-model child process) is future work, written down as such rather than implied to already be in force.

---

## 4. Lifecycle and health

**One worker thread per plugin** (`packages/plugin-sdk/src/host.ts`, class `PluginHost`). A plugin that throws, hangs, fails to load, declares a contract version this host doesn't implement, or fails conformance degrades to _that plugin_ being unavailable with a reported reason — never a crashed host, never a product that won't start. `PluginHost.load` always resolves.

Health is one of five states (`PluginHealth`):

| Status        | Meaning                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `loading`     | Worker starting, manifest not yet read.                                                            |
| `ready`       | Descriptor read and conformant; `warnings` carries an out-of-date contract-version notice, if any. |
| `restarting`  | Crashed after having loaded once; will retry, with `reason` and `attempt`.                         |
| `unavailable` | Failed to load, failed conformance, or exhausted its restart budget — `reason` says why.           |
| `disposed`    | Torn down deliberately.                                                                            |

Two enforced boundaries:

- **Bounded restarts.** A plugin that loaded and then crashed is restarted up to `RestartPolicy.maxRestarts` (default 2) with backoff (`DEFAULT_RESTART_POLICY`: `[200, 1000]` ms, last value repeating), then gives up and reports it. A plugin that _never_ loaded is not retried at all — retrying a deterministic load failure is exactly the infinite restart principle 11 rules out.
- **Bounded timeouts.** Loading has a timeout (`loadTimeoutMs`, default 5000ms); each invocation has one too (`callTimeoutMs`, default 5000ms). Either firing fails the plugin with a stated reason rather than hanging the caller.

Every invocation also enforces permissions before the plugin ever sees the call: an ungranted-but-answered (`denied`) permission simply refuses; an unanswered one raises the §6.6 approval and blocks until answered. A tool call's `context.actor` is always the calling session, supplied by the host — there is no invocation shape by which a plugin supplies its own.

### Install / enable / disable / remove, without restarting the product

`PluginRegistry` (`packages/plugin-sdk/src/registry.ts`) is the state machine, and nothing else — it decides nothing about permissions or the contract, just which plugins exist and which have a running `PluginHost`. Four verbs, each a real state transition, none requiring the product to restart:

- **`install(entry, origin)`** reads the manifest in a throwaway worker and records what the plugin _is_ — it does not run it. A plugin the operator hasn't enabled must not be reachable, so `installed` is a state in its own right, not a synonym for "disabled with a worker already up."
- **`enable(pluginId)`** starts the worker. Failure isn't an exception here either: an enabled plugin that can't load is `enabled` with `unavailable` health.
- **`disable(pluginId)`** disposes the worker and keeps the record, so re-enabling costs no rediscovery.
- **`remove(pluginId)`** disposes and forgets the record. It deletes no files — the plugin came from a directory the operator owns, and deleting from it would be destroying authored state without asking (principle 10, §6.6).

### Distribution (§10.2, §13)

Two sources are real in v1 (`PLUGIN_ORIGINS`):

- **`in-box`** — entries the app ships (`filesystem`, `git`, `github`, `jira`).
- **`directory`** — a configured plugins directory, scanned on demand via `installFromDirectory` — never on a timer (principle 2). A subdirectory needs a recognized entry file (`index.js`, `index.mjs`, `plugin.js`, or `index.ts`); an unreadable one is reported, not silently dropped. A plugin's id always comes from its own manifest, never from the directory name — a name the operator can rename is not identity.

**A remote source — a registry or URL a plugin is fetched from — is deferred**, directionally noted but not built: it needs a fetch mechanism, a verification story, and an update path that must not silently widen permissions, none of which is decided yet.

---

## 5. The constitutional limits

These are not conventions a plugin author can choose to follow loosely — they are enforced in the type system, the conformance checks, or the host, and restated here because they shape every decision above:

- **Plugins populate the nine first-class concepts; they never add one.** `ConceptKind` (`CONCEPT_KINDS` in `contributions.ts`) is closed: `ticket`, `pull_request`, `review`, `document`, `diff`, `commit`, `note`, `transcript`, `collection`. There is no `defineConceptKind` anywhere in the contract, and there will not be one. A Jira ticket is not a first-class thing — a _ticket_ is, and the Jira plugin knows how to produce tickets from Jira.
- **Plugins cannot author intent.** No handler anywhere in the contract draws a context edge, and none takes an actor it can choose. `PluginCallContext.actor` is the host's, supplied per call — non-null only for an agent tool call, where it is the calling session — and `CoreId` (the type every core-minted id carries) is unconstructible from a plugin. `CORE_CAPABILITIES` is deliberately short and is asserted edge-free by test: there is no capability that authors a connection between things.
- **Write results are read back, never assumed.** Every `WriteAction.perform` returns a `WriteResult` whose `readBack` is what the plugin found by re-reading the target afterward — not what the request implied should have happened. External systems have their own automation; the state asked for is not reliably the state received, so the host never trusts its own request over a fresh read.

---

## 6. Worked example: the GitHub plugin

`packages/plugins/github/src/plugin.ts` builds the manifest with `createGitHubPlugin(deps: { transport: HttpTransport })`. The transport is injected so every test in the repository runs against a recorded one and none can reach real GitHub.

### Permissions

Two declarations carry the entire trust story:

```ts
permissions: [
  {
    id: "github-api", // NETWORK_PERMISSION
    kind: "network",
    scope: { kind: "network", hosts: ["api.github.com"] },
    reason:
      "read pull requests, reviews, issues and repository metadata, and perform the writes you ask for",
    requiredToLoad: false,
  },
  {
    id: "github-token", // CREDENTIAL_PERMISSION
    kind: "credential",
    scope: {
      kind: "credential",
      credentialId: GITHUB_CREDENTIAL_ID,
      system: GITHUB_CREDENTIAL_SYSTEM,
    },
    reason: "authenticate to GitHub as you",
    requiredToLoad: false,
  },
],
```

Neither is `requiredToLoad`, so the host — not the plugin — decides that an ungranted GitHub plugin degrades rather than refuses to start. Nothing in the package reads `process.env`; the token only ever arrives through `context.credentials`, injected per call.

### A concept producer

`createPullRequestProducer` (`packages/plugins/github/src/producers.ts`) declares:

```ts
{
  id: "pull-requests",                     // PULL_REQUEST_PRODUCER_ID
  kinds: ["pull_request"],
  refresh: { kind: "on-demand" },
  scoping: { language: GITHUB_SCOPE_LANGUAGE, example: GITHUB_SCOPE_EXAMPLE },
  permissions: ["github-api", "github-token"],
  async read(request, context) { /* … */ },
}
```

`read` resolves the scope (a repository plus filters, in GitHub's own query shorthand) or a single `externalId` for a per-object refresh, connects via `GitHubApi.connect(transport, context.credentials)`, and calls the GitHub REST API. Every failure — an unparsable scope, no connection, GitHub's own error — is reported through `unavailable: [{ externalId, why }]`, never as a half-filled pull request.

### A write action with declared reversibility

`createGitHubWriteActions` (`packages/plugins/github/src/writes.ts`) contributes four actions; two illustrate the reversibility spectrum:

```ts
{
  id: "comment",                     // COMMENT_ACTION
  action: "comment",
  system: "github",
  reversibility: "reversible",       // a comment can be deleted, restoring prior state
  input: { repository, number, body },
  permissions: ["github-api", "github-token"],
  async perform(input, context) { /* posts, then reads the issue back */ },
}
```

```ts
{
  id: "merge",                       // MERGE_ACTION
  action: "merge",
  system: "github",
  reversibility: "irreversible",     // the commits land in the base branch; other work builds on them
  input: { repository, number, method },
  permissions: ["github-api", "github-token"],
  async perform(input, context) { /* merges, then reads the pull request back */ },
}
```

`merge` is declared `irreversible` rather than `unknown` deliberately — it's knowable, and `unknown` would be treated as irreversible anyway, which would hide a fact the plugin author actually has. Every `perform` here ends by re-reading the target (`readBackPullRequest` / `readBackIssue`) and returning that as `readBack` — GitHub's own automation can move a merged pull request or a transitioned issue somewhere the request didn't specify, and the write result reflects what's true, not what was asked for.

### A condition check

`pullRequestExistsCheck` (`packages/plugins/github/src/conditions.ts`) proves — never claims — that an open pull request exists from a named branch:

```ts
export const PULL_REQUEST_EXISTS_CHECK = "github_pull_request_exists";
// ...
{
  id: PULL_REQUEST_EXISTS_CHECK,
  summary: "an open pull request exists from a named branch",
  input: { repository, branch },
  permissions,
  async check(raw, context) { /* … */ },
}
```

If the repository or branch is missing from the input, or the connection can't be made, it returns `state: "unknown"` with an explanation — not `"unmet"`, because nothing was actually checked, and reporting a missing connection as failed work would be exactly the kind of inference principle 7 rules out. Only a successful GitHub answer with zero matching pull requests earns `"unmet"`.

### A shipped command definition

The manifest ships one `producing` command definition that names the two condition checks (its own `pull_request_exists` plus `checks_green`) that prove it:

```ts
commandDefinitions: [
  {
    id: "github-review-a-pull-request",
    name: "Review a pull request",
    instruction:
      "Read the pull request and its diff, then leave a review comment naming what must change and why. Do not merge.",
    lifecycle: "producing",
    expectedOutcome:
      "a review comment exists on the pull request, and its checks are green",
    conditionCheckIds: [PULL_REQUEST_EXISTS_CHECK, CHECKS_GREEN_CHECK],
  },
],
```

This is a starting point the operator can edit afterward, not a locked definition the plugin owns forever — the host copies it into the operator's command library at install time.

Together these four contributions — a producer that reads GitHub into `pull_request` and `ticket` objects, a write with an honest reversibility declaration and a mandatory read-back, a condition check that distinguishes "unproven" from "failed," and a command definition that names the checks proving it — are the same shape every in-box and third-party plugin builds against: nothing here reaches outside the twelve contribution points, and nothing here draws an edge the plugin didn't earn through a declared, granted permission.
