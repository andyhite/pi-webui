/**
 * The twelve contribution points (§10.1) — **contract v1, frozen**.
 *
 * This is the reconciliation the draft was drawn for: every point below already has
 * a native implementation in the product, and each interface names the one it was
 * checked against, so Epic 7.3's port of the in-box four is a port rather than a
 * rediscovery.
 *
 * ## Three rules that constrain every point
 *
 * 1. **Plugins populate first-class concepts; they never add one** (§3.1). There is
 *    no `defineConceptKind` here and there will not be one.
 * 2. **Plugins cannot author intent** (principle 1, §10.2). Nothing a plugin
 *    contributes may draw a context edge, and no handler takes an actor it can
 *    choose: {@link PluginCallContext.actor} is the host's, supplied per call, and
 *    `CoreId` is unconstructible from a plugin.
 * 3. **A throwing plugin is an unavailable plugin** (§10.2). Every handler is
 *    invoked across the worker boundary, so every one returns a promise and none is
 *    load-bearing for the product starting.
 *
 * ## Handlers are functions here and declarations at the host
 *
 * A contribution is one object carrying both what it declares and what it does. The
 * declaration crosses the worker boundary as JSON (a {@link ContributionDescriptor}
 * in `manifest.ts`); the function stays in the worker and is reached by
 * point-plus-id over the RPC. That split is why every id below is required — the
 * draft's renderers had none, and a renderer the host cannot name is a renderer the
 * host cannot call.
 */
import type { ContributionId, CoreId, EpochMillis } from "./ids.js";
import type { PermissionId, PluginActor } from "./permissions.js";

/* -------------------------------------------------------------- call context */

/**
 * What the host injects into every handler call. The complete list of a plugin's
 * host-given reach is `HOST_INJECTED_CAPABILITIES` in `permissions.ts`: this
 * record and one log function. There is no transport here, no store handle, and
 * nothing that authors an edge.
 */
export interface PluginCallContext {
  /** Unique per call, so a plugin's log lines can be correlated with the host's. */
  readonly invocationId: string;
  /**
   * Who the call acts as — **non-null only for an agent tool call**, where it is
   * the calling session (principle 1). A plugin cannot set it, and a plugin that
   * ignores it acts as nobody rather than as itself.
   */
  readonly actor: PluginActor | null;
  /**
   * Credential values for this call only, keyed by credential id (§9.3). Contains
   * exactly the granted credentials the invoked contribution declared, and nothing
   * else. Values injected here are redacted out of anything the handler returns.
   */
  readonly credentials: Readonly<Record<string, string>>;
  /** The permissions currently granted to this plugin, by id. */
  readonly grants: readonly PermissionId[];
  /** A line into PlotRoom's structured log. Never a channel back into the graph. */
  log(message: string): void;
}

/* ------------------------------------------------------------ shared vocabulary */

/**
 * The first-class concept kinds a producer may populate (§3.1).
 *
 * Mirrors `@plotroom/core`'s object kinds — the same members with the same
 * spellings, so a producer's declared kind is a core kind without translation.
 * Closed rather than open because "an integration populates first-class
 * concepts; it never adds new ones" is only enforceable if the set is closed.
 */
export const CONCEPT_KINDS = [
  "ticket",
  "pull_request",
  "review",
  "document",
  "diff",
  "commit",
  "note",
  "transcript",
  "collection",
] as const;

export type ConceptKind = (typeof CONCEPT_KINDS)[number];

/**
 * The three renderings every object owes (§3.2), supplied by its producer.
 *
 * Native counterpart: `ObjectRenderings` in `@plotroom/core` (Epic 1.1).
 */
export interface Renderings {
  readonly card: string;
  readonly summary: string;
  readonly agentContent: string;
}

export const TOOL_INPUT_TYPES = [
  "string",
  "number",
  "boolean",
  "string[]",
  "object",
] as const;

export type ToolInputType = (typeof TOOL_INPUT_TYPES)[number];

export interface ToolInputField {
  readonly type: ToolInputType;
  readonly required: boolean;
  readonly description: string;
}

/** Declared inputs (§10.1), as a record so a schema is data rather than code. */
export type ToolInputSchema = Readonly<Record<string, ToolInputField>>;

/* --------------------------------------------------------- concept producers */

/**
 * A concept producer: how a plugin reads the outside world into objects (§9.1,
 * §10.1).
 *
 * Native counterpart: the git workspace reads (Epic 4.4) and the object store's
 * external-identity reconciliation (Epic 1.1). `externalId` is uniquely indexed in
 * the store, so **a re-read reconciles rather than duplicating** — which is why
 * `read` returns whole objects and never a diff it computed itself, and why an
 * object without a stable external id cannot be produced.
 *
 * **Scheduled reads are fine; scheduled runs are not** (principle 2). `refresh`
 * describes when the *host* may call `read`; a producer never starts work.
 */
export interface ConceptProducer {
  readonly id: ContributionId;
  readonly kinds: readonly ConceptKind[];
  readonly refresh: RefreshMode;
  /** The source's own query language, runtime-configurable (§9.1). */
  readonly scoping: ScopingDeclaration;
  /** Which declared permissions this producer needs (§10.2). */
  readonly permissions: readonly PermissionId[];
  read(
    request: ReadRequest,
    context: PluginCallContext,
  ): Promise<ReadResult> | ReadResult;
}

export type RefreshMode =
  | { readonly kind: "on-demand" }
  | { readonly kind: "interval"; readonly seconds: number }
  /** The plugin observes something and tells the host; still a read, never a run. */
  | { readonly kind: "observed"; readonly what: string };

export interface ScopingDeclaration {
  /** How the query is written, for the settings surface: "jql", "gh-search". */
  readonly language: string;
  readonly example: string;
}

export interface ReadRequest {
  /** The configured scope, in the source's own query language (§9.1). */
  readonly scope: string | null;
  /** Present for a per-object refresh; absent for a whole-integration one (§9.1). */
  readonly externalId: string | null;
}

export interface ProducedObject {
  readonly kind: ConceptKind;
  /** Stable in the source system. The host reconciles on it (§3.1). */
  readonly externalId: string;
  readonly title: string;
  readonly renderings: Renderings;
}

export interface ReadResult {
  readonly objects: readonly ProducedObject[];
  /**
   * Concepts are **present or absent, never degraded** (§3.1). A read that could
   * not answer says so here; it does not return a half-filled object.
   */
  readonly unavailable: readonly {
    readonly externalId: string;
    readonly why: string;
  }[];
}

/* ------------------------------------------------------------- write actions */

/**
 * Reversibility, declared per write action (§9.2).
 *
 * Native counterpart: `WriteReversibility` in `@plotroom/core`
 * (`sessions/outside-world.ts`), and this is the load-bearing declaration — the
 * same one drives §6.6's irreversibility approvals *and* §6.3's outside-world
 * markers. `"unknown"` exists and is treated as irreversible (principle 7), so an
 * author who cannot tell has an honest answer that does not silently become
 * "reversible".
 */
export type WriteReversibility = "reversible" | "irreversible" | "unknown";

/**
 * One write action, available as a UI action *and* an agent tool (§9.2,
 * principle 8).
 *
 * Native counterpart: the approval ask built by `toolCallAsk` from a write intent
 * plus a `ToolWorldDeclaration` (Epic 6.3). Two properties the freeze keeps:
 *
 * - **`reversibility` is not optional.** An action that forgot to declare would be
 *   pre-grantable by omission, which is exactly the hole §6.6 closes.
 * - **The result is read back, never assumed** (§9.2): `perform` returns what the
 *   system says happened, including a rejection's own error text, and the host
 *   re-reads rather than trusting the request it sent.
 */
export interface WriteAction {
  readonly id: ContributionId;
  /** As §9.2 words them: "merge", "transition", "comment", "request-review". */
  readonly action: string;
  readonly system: string;
  readonly reversibility: WriteReversibility;
  readonly input: ToolInputSchema;
  readonly permissions: readonly PermissionId[];
  perform(
    input: unknown,
    context: PluginCallContext,
  ): Promise<WriteResult> | WriteResult;
}

export interface WriteResult {
  readonly ok: boolean;
  /** The source's own text on a rejection, unedited (§9.2). */
  readonly message: string;
  /** What a read-back found afterwards, when the plugin performed one (§9.2). */
  readonly readBack: ProducedObject | null;
}

/* --------------------------------------------------------------- agent tools */

/**
 * An agent tool a plugin contributes: declared inputs, outputs, and permission
 * requirements (§10.1, §10.2).
 *
 * Native counterpart: `AgentTool` in `@plotroom/core`'s catalog (Epic 4.5) — and
 * `requires` is deliberately a *subset* of `ToolRequirements`. A plugin declares
 * what it needs; it does not declare its own reflexivity class or claim exemptions,
 * because those are the enforced asymmetry (principle 8) and a plugin that could
 * set them could opt out of them.
 *
 * `call` receives a context whose `actor` is the **calling session** (principle 1),
 * supplied by the host and unsettable from here.
 */
export interface AgentTool {
  readonly name: ContributionId;
  readonly summary: string;
  readonly input: ToolInputSchema;
  /** What the tool returns, declared so the catalog can say (§10.1). */
  readonly output: ToolOutputDeclaration;
  readonly requires: {
    /** Whether it writes; the host routes writes through §6.6 and §3.4. */
    readonly mutates: boolean;
    /** Set when this tool is a write action, so reversibility comes from there. */
    readonly writeActionId: ContributionId | null;
    /** Which declared permissions it needs (§10.2). */
    readonly permissions: readonly PermissionId[];
  };
  call(
    input: unknown,
    context: PluginCallContext,
  ): Promise<ToolResult> | ToolResult;
}

export interface ToolOutputDeclaration {
  /** One line describing what comes back, shown in the tool catalog. */
  readonly description: string;
}

export interface ToolResult {
  readonly ok: boolean;
  /**
   * What the calling session sees. The host redacts any credential value it
   * injected out of this before it leaves the boundary (§9.3) — a plugin cannot
   * hand a session a secret, by accident or otherwise.
   */
  readonly content: string;
}

/* ------------------------------------------------------------------ renderers */

/**
 * Content renderers: agent-ready content **and its delta** against a prior version
 * (§10.1, §3.2).
 *
 * Native counterpart: `ObjectRenderings` plus the version delta model (Epic 1.1).
 * The delta is a contribution point rather than a host computation because "what's
 * new" is kind-specific — a PR's delta is not a diff of its description — and
 * **never silently truncating** (principle 12) is the renderer's obligation too:
 * `truncated` is a fact it reports, not something the host discovers.
 */
export interface ContentRenderer {
  readonly id: ContributionId;
  readonly kinds: readonly ConceptKind[];
  renderAgentContent(
    object: ProducedObject,
    context: PluginCallContext,
  ): Promise<RenderedContent> | RenderedContent;
  renderDelta(
    previous: ProducedObject,
    next: ProducedObject,
    context: PluginCallContext,
  ): Promise<RenderedContent> | RenderedContent;
}

export interface RenderedContent {
  readonly content: string;
  /** Never a silent cap (principle 12): the host warns with what was dropped. */
  readonly truncated: {
    readonly omittedBytes: number;
    readonly why: string;
  } | null;
}

/**
 * Card renderers, compact and expanded, including in-canvas interactive surfaces
 * (§10.1, §5).
 *
 * Native counterpart: the canvas node renderers in `@plotroom/ui` (Epic 3.x), which
 * switch by zoom level. Nodes stay DOM-based so plugin cards and keyboard
 * accessibility both work (§11) — so this returns a **declarative view the host
 * draws**, not markup and not a component: a plugin cannot be handed the DOM
 * without also being handed the ability to break focus management for the whole
 * board.
 */
export interface CardRenderer {
  readonly id: ContributionId;
  readonly kinds: readonly ConceptKind[];
  renderCard(
    object: ProducedObject,
    detail: CardDetail,
    context: PluginCallContext,
  ): Promise<CardView> | CardView;
}

/** Compact is the zoomed-out card; expanded is the open one (§5, §10.1). */
export type CardDetail = "compact" | "expanded";

export interface CardView {
  readonly title: string;
  readonly lines: readonly string[];
  /** Interactive surfaces are actions the host draws and dispatches (§10.1). */
  readonly actions: readonly CardAction[];
}

export interface CardAction {
  readonly id: ContributionId;
  readonly label: string;
  /** Set when the action is a write, so §6.6 applies to a card button too. */
  readonly writeActionId: ContributionId | null;
}

/* ------------------------------------------------- panels, palette, themes */

/** A panel in the dock rail's registry (§10.1, §11). Native counterpart: Epic 3.4. */
export interface Panel {
  readonly id: ContributionId;
  readonly title: string;
  /** Where it can live, so the host places it rather than the plugin. */
  readonly placement: "right" | "bottom";
  render(context: PluginCallContext): Promise<CardView> | CardView;
}

/**
 * A palette or command-palette entry (§10.1, §11).
 *
 * Native counterpart: the command palette (Epics 3.4, 8.1). Every binding is
 * documented in the shortcuts overlay — "a binding cannot exist undocumented"
 * (§11) — so a contributed entry supplies its own description and the overlay
 * lists it.
 */
export interface PaletteEntry {
  readonly id: ContributionId;
  readonly label: string;
  readonly description: string;
  invoke(context: PluginCallContext): Promise<void> | void;
}

/**
 * A theme (§10.1): named design tokens the host applies.
 *
 * Tokens are values, not stylesheets, for the same reason a card view is not
 * markup. The styling approach for the UI package is still an open decision
 * (AGENTS.md), so the *token names* are not frozen here — the shape is.
 */
export interface Theme {
  readonly id: ContributionId;
  readonly name: string;
  readonly tokens: Readonly<Record<string, string>>;
}

/* ----------------------------------------------------------- workspace kinds */

/**
 * A workspace kind, with its own provisioning, readiness, and divergence rules
 * (§10.1, §3.4).
 *
 * Native counterpart: `@plotroom/core`'s `workspaces/` subtree — `kind.ts`,
 * `lifecycle.ts`, `readiness.ts`, `divergence.ts` (Epic 4.4). This is the most
 * demanding contribution in §10.1 and the closest thing to a proof the contract is
 * real, so the shapes below are core's, narrowed to what crosses a worker boundary
 * as JSON:
 *
 * - **Configuration is an opaque JSON record the kind validates itself**, because a
 *   plugin kind's config crosses the boundary as JSON and only the kind knows what
 *   is in it. A kind **refuses bad configuration with a reason; it never throws its
 *   way out of the product**.
 * - **Multi-root is in the shape** (§13): status and fingerprints are lists of
 *   units, one per root. Git reports one; a composite kind reports two.
 * - **Divergence is observed, never inferred** (principle 7): a fingerprint is a
 *   change detector, and a root that could not be read is reported as unreadable
 *   rather than as clean.
 *
 * The *boundary* — one workstream owns exactly one workspace — is the product's and
 * no kind is asked about it (§3.4). Only the mechanism is here.
 */
export interface WorkspaceKind {
  readonly id: ContributionId;
  readonly label: string;
  readonly permissions: readonly PermissionId[];
  /** Validate configuration before anything is created. Never throws; refuses. */
  checkConfig(
    config: WorkspaceKindConfig,
    context: PluginCallContext,
  ): Promise<WorkspaceConfigCheck> | WorkspaceConfigCheck;
  /** Create the mechanism. Called at first run, never at workstream creation. */
  provision(
    request: ProvisionRequest,
    context: PluginCallContext,
  ): Promise<ProvisionOutcome> | ProvisionOutcome;
  /** Run the declared setup step; the readiness gate that consumes it is core's. */
  runSetup(
    request: SetupRequest,
    context: PluginCallContext,
  ): Promise<SetupAttemptResult> | SetupAttemptResult;
  /** Live status, read from the mechanism — never from a cached belief (§3.4). */
  status(
    workspace: WorkspaceRef,
    context: PluginCallContext,
  ): Promise<WorkspaceStatus> | WorkspaceStatus;
  /** The comparable snapshot divergence detection works over (§3.4, §4.3). */
  fingerprint(
    workspace: WorkspaceRef,
    context: PluginCallContext,
  ): Promise<WorkspaceFingerprint> | WorkspaceFingerprint;
  remove(
    workspace: WorkspaceRef,
    options: { readonly force: boolean },
    context: PluginCallContext,
  ): Promise<RemovalOutcome> | RemovalOutcome;
}

/** Opaque to the product, owned by the kind, JSON because plugins are out of process. */
export type WorkspaceKindConfig = Readonly<Record<string, unknown>>;

export type WorkspaceConfigCheck =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly refusal: {
        readonly message: string;
        /** Which configuration fields were wrong, so the UI can point at them. */
        readonly fields: readonly string[];
      };
    };

/** A workspace as a plugin sees it: the host's id and the roots it made. */
export interface WorkspaceRef {
  readonly workspaceId: CoreId;
  readonly roots: readonly WorkspaceRoot[];
  readonly config: WorkspaceKindConfig;
}

export interface WorkspaceRoot {
  /** Which root this is; a single-root kind uses one, a composite N (§13). */
  readonly rootKey: string;
  readonly path: string;
}

export interface ProvisionRequest {
  readonly workspaceId: CoreId;
  readonly workstreamId: CoreId;
  readonly config: WorkspaceKindConfig;
  readonly requestedAt: EpochMillis;
}

export type ProvisionOutcome =
  | {
      readonly provisioned: true;
      readonly roots: readonly WorkspaceRoot[];
      readonly cost: ProvisionCost;
      /** What ran, in order, so provisioning is inspectable (principle 12). */
      readonly log: readonly string[];
      /** What the kind found rather than made — an existing branch is taken as it is. */
      readonly notes: readonly string[];
    }
  | {
      readonly provisioned: false;
      readonly failure: {
        readonly reason: ProvisionFailureReason;
        /** The honest reason, including the mechanism's own error text (§3.4). */
        readonly message: string;
        readonly log: readonly string[];
      };
    };

export const PROVISION_FAILURE_REASONS = [
  "invalid_config",
  /** The host's own credentials could not authenticate (§3.4, §9.3). */
  "host_auth",
  /** The target path is occupied by something the product will not overwrite. */
  "occupied",
  /** The mechanism reported an error; `message` carries it verbatim. */
  "mechanism_failed",
] as const;

export type ProvisionFailureReason = (typeof PROVISION_FAILURE_REASONS)[number];

/** What provisioning cost (§3.4). Unknown disk usage is null, never zero. */
export interface ProvisionCost {
  readonly elapsedMillis: number;
  readonly bytesOnDisk: number | null;
  readonly sharedCache: "hit" | "miss" | "unavailable";
  /** The mechanism actually used, e.g. "worktree" or "clone". */
  readonly strategy: string;
}

export interface SetupRequest {
  readonly workspace: WorkspaceRef;
  readonly program: string;
  readonly args: readonly string[];
  /** Relative to the workspace root; empty string means the root itself. */
  readonly workingSubdirectory: string;
  readonly startedAt: EpochMillis;
}

export interface SetupAttemptResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  /** Kept whole: setup output is inspectable and never shortened (principle 12). */
  readonly output: string;
  readonly finishedAt: EpochMillis;
}

/** Readiness as §3.4 states it; the gate that consumes it is core's. */
export const READINESS_STATES = [
  "unprovisioned",
  "provisioning",
  "setup-required",
  "setup-running",
  "ready",
  "setup-failed",
  "provision-failed",
] as const;

export type ReadinessState = (typeof READINESS_STATES)[number];

export interface WorkspaceStatus {
  readonly observedAt: EpochMillis;
  readonly readiness: ReadinessState;
  readonly units: readonly WorkspaceUnitStatus[];
  /** Set when the mechanism could not be read at all; status is never faked. */
  readonly unavailable: string | null;
}

export interface WorkspaceUnitStatus {
  readonly rootKey: string;
  readonly path: string;
  /** Null for a kind with no branches, or for a detached checkout. */
  readonly branch: string | null;
  readonly head: string | null;
  readonly upstream: string | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  /** Every changed path, complete — the product never silently truncates. */
  readonly uncommitted: readonly string[];
  readonly untracked: readonly string[];
}

export interface WorkspaceFingerprint {
  readonly observedAt: EpochMillis;
  readonly units: readonly UnitFingerprint[];
}

export interface UnitFingerprint {
  readonly rootKey: string;
  /** The committed point of work: a git commit sha, whatever a kind's is. */
  readonly head: string | null;
  readonly branch: string | null;
  readonly upstream: string | null;
  readonly upstreamHead: string | null;
  /** A digest over the uncommitted set, so hand edits are detectable. */
  readonly dirtyDigest: string;
  readonly dirtyCount: number;
  /** Observed, never inferred (principle 7): a root it could not read says so. */
  readonly unreadable: string | null;
}

export type RemovalOutcome =
  | { readonly removed: true; readonly log: readonly string[] }
  | {
      readonly removed: false;
      readonly refusal: {
        readonly message: string;
        /** Whether force-removal gets past this. Protections say false (§3.4). */
        readonly forcible: boolean;
      };
    };

/* ---------------------------------------------------------- condition checks */

/**
 * A condition check: a predicate for **proving** completion (§10.1, principle 3).
 *
 * Native counterpart: the server's world-condition registry (Epic 4.3) that
 * `checkProvenCompletion` consults. Two properties the freeze keeps:
 *
 * - It **reads**, and the host calls it. A check that could start work would be the
 *   product originating work (principle 2).
 * - `"unknown"` is a distinct answer from `"unmet"`. A check that could not run has
 *   not disproved completion, and reporting it as unmet would make a flaky check
 *   read as a failed run (§3.5).
 */
export interface ConditionCheck {
  readonly id: ContributionId;
  readonly summary: string;
  readonly input: ToolInputSchema;
  readonly permissions: readonly PermissionId[];
  check(
    input: unknown,
    context: PluginCallContext,
  ): Promise<ConditionResult> | ConditionResult;
}

export interface ConditionResult {
  readonly state: "met" | "unmet" | "unknown";
  /** The evidence, because completion is proven rather than claimed. */
  readonly evidence: string;
}

/* -------------------------------------------------------- notification routes */

/**
 * An outbound notification route (§10.1, §7.3).
 *
 * Native counterpart: outbound routing (Epic 6.1). **Redaction is the host's, not
 * the route's**: the host hands over an already-whitelisted payload — titles and
 * summaries pass, content bodies never — because a route that received the full
 * content and was trusted to redact it is a leak one bug away (§7.3, §9.3).
 */
export interface NotificationRoute {
  readonly id: ContributionId;
  readonly label: string;
  readonly permissions: readonly PermissionId[];
  send(payload: Notification, context: PluginCallContext): Promise<void> | void;
}

export interface Notification {
  readonly title: string;
  /** Already whitelisted by the host (§7.3). */
  readonly body: string;
  readonly at: EpochMillis;
}

/* --------------------------------------------------------- command definitions */

/**
 * A command definition a plugin ships (§10.1, §3.5).
 *
 * Native counterpart: `CommandDefinition` in `@plotroom/core` (Epic 1.4). A
 * contributed definition is a **starting point the operator edits**, not a locked
 * one: §3.5's definitions are user-editable content, so the host copies it in and
 * the plugin does not own it afterwards.
 */
export interface CommandDefinitionContribution {
  readonly id: ContributionId;
  readonly name: string;
  readonly instruction: string;
  readonly lifecycle: "producing" | "open";
  /** Required for `producing`, refused for `open` — the schema enforces it (§3.5). */
  readonly expectedOutcome: string | null;
  readonly conditionCheckIds: readonly ContributionId[];
}
