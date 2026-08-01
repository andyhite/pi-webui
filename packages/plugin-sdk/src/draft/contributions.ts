/**
 * DRAFT — the plugin contribution contract (§10.1). **Unstable; wired to nothing.**
 *
 * Epic 7.1 freezes this surface in Phase 7. It is drafted here, a batch early, for
 * one reason: every contribution point below already has a **native
 * implementation** in the product, and a contract drawn without looking at those is
 * a contract the in-box four cannot be ported onto. Each interface therefore names
 * where its native counterpart lives today, so the freeze is a reconciliation
 * rather than an invention.
 *
 * Nothing here is imported by `host.ts`, `protocol.ts`, or anything in `apps/`.
 * `CONTRACT_VERSION` stays `0` and these types have no runtime presence at all —
 * the point is reviewed shapes, not a half-wired platform.
 *
 * ## Three rules that constrain every point below
 *
 * 1. **Plugins populate first-class concepts; they never add one** (§3.1). There is
 *    no `defineConceptKind` here and there will not be one.
 * 2. **Plugins cannot author intent** (principle 1, §10.2). Nothing a plugin
 *    contributes may draw a context edge. A plugin's tool **acts as the calling
 *    session**, which is why `AgentToolContribution` has no author field to set:
 *    the actor is the host's, and there is nowhere to say otherwise.
 * 3. **A throwing plugin is an unavailable plugin** (§10.2). Every contribution is
 *    invoked through the worker host, so every one of these returns a promise and
 *    none of them is allowed to be load-bearing for the product starting.
 *
 * ## Ids are strings here, on purpose
 *
 * `@plotroom/core` brands its ids, and this package does not depend on core (and
 * must not: a plugin compiles against the SDK alone). At the freeze these become
 * declared opaque aliases the host validates at the boundary; until then they are
 * strings and the asymmetry is written down rather than hidden.
 */

import type {
  DraftPermissionId,
  DraftPermissionRequest,
} from "./permissions.js";

/** DRAFT. A core id, as a plugin sees it: opaque, never constructed by a plugin. */
export type DraftId = string;

/** DRAFT. Milliseconds since the epoch, matching the observation vocabulary. */
export type DraftEpochMillis = number;

/**
 * DRAFT. The first-class concept kinds a producer may populate (§3.1).
 *
 * Mirrors `@plotroom/core`'s object kinds. Listed rather than left open because
 * "an integration populates first-class concepts; it never adds new ones" is only
 * enforceable if the set is closed.
 */
export const DRAFT_CONCEPT_KINDS = [
  "ticket",
  "pull-request",
  "review",
  "document",
  "diff",
  "commit",
  "note",
  "transcript",
  "collection",
] as const;

export type DraftConceptKind = (typeof DRAFT_CONCEPT_KINDS)[number];

/**
 * DRAFT. The three renderings every object owes (§3.2), supplied by its producer.
 *
 * Native counterpart: `ObjectRenderings` in `@plotroom/core` (Epic 1.1).
 */
export interface DraftRenderings {
  readonly card: string;
  readonly summary: string;
  readonly agentContent: string;
}

/* --------------------------------------------------------- concept producers */

/**
 * DRAFT. A concept producer: how a plugin reads the outside world into objects
 * (§9.1, §10.1).
 *
 * Native counterpart: the git workspace reads (Epic 4.4) and the object store's
 * external-identity reconciliation (Epic 1.1) — `externalId` is uniquely indexed,
 * so a re-read reconciles rather than duplicating, which is why `read` returns
 * whole objects and never a diff it computed itself.
 *
 * **Scheduled reads are fine; scheduled runs are not** (principle 2). `refresh`
 * describes when the *host* may call `read`; a producer never starts work.
 */
export interface DraftConceptProducer {
  readonly id: string;
  readonly kinds: readonly DraftConceptKind[];
  readonly refresh: DraftRefreshMode;
  /** The source's own query language, runtime-configurable (§9.1). */
  readonly scoping: DraftScopingDeclaration;
  read(request: DraftReadRequest): Promise<DraftReadResult>;
}

export type DraftRefreshMode =
  | { readonly kind: "on-demand" }
  | { readonly kind: "interval"; readonly seconds: number }
  /** The plugin observes something and tells the host; still a read, never a run. */
  | { readonly kind: "observed"; readonly what: string };

export interface DraftScopingDeclaration {
  /** How the query is written, for the settings surface: "jql", "gh-search". */
  readonly language: string;
  readonly example: string;
}

export interface DraftReadRequest {
  readonly scope: string | null;
  /** Present for a per-object refresh; absent for a whole-integration one (§9.1). */
  readonly externalId: string | null;
}

export interface DraftProducedObject {
  readonly kind: DraftConceptKind;
  /** Stable in the source system. The host reconciles on it (§3.1). */
  readonly externalId: string;
  readonly title: string;
  readonly renderings: DraftRenderings;
}

export interface DraftReadResult {
  readonly objects: readonly DraftProducedObject[];
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
 * DRAFT. Reversibility, declared per write action (§9.2).
 *
 * Native counterpart: `WriteReversibility` in `@plotroom/core`
 * (`sessions/outside-world.ts`), and this is the load-bearing one — the same
 * declaration drives §6.6's irreversibility approvals *and* §6.3's outside-world
 * markers. `"unknown"` exists and is treated as irreversible (principle 7), so an
 * author who cannot tell has an honest answer that does not silently become
 * "reversible".
 */
export type DraftWriteReversibility = "reversible" | "irreversible" | "unknown";

/**
 * DRAFT. One write action, available as a UI action *and* an agent tool (§9.2,
 * principle 8).
 *
 * Native counterpart: the approval ask built by `toolCallAsk` from a write intent
 * plus a `ToolWorldDeclaration` (Epic 6.3). Two things the freeze must keep:
 *
 * - **`reversibility` is not optional.** An action that forgot to declare would be
 *   pre-grantable by omission, which is exactly the hole §6.6 closes.
 * - **The result is read back, never assumed** (§9.2): `perform` returns what the
 *   system says happened, including a rejection's own error text, and the host
 *   re-reads rather than trusting the request it sent.
 */
export interface DraftWriteAction {
  readonly id: string;
  /** As §9.2 words them: "merge", "transition", "comment", "request-review". */
  readonly action: string;
  readonly system: string;
  readonly reversibility: DraftWriteReversibility;
  readonly input: DraftToolInputSchema;
  perform(input: unknown): Promise<DraftWriteResult>;
}

export interface DraftWriteResult {
  readonly ok: boolean;
  /** The source's own text on a rejection, unedited (§9.2). */
  readonly message: string;
  /** What a read-back found afterwards, when the plugin performed one. */
  readonly readBack: DraftProducedObject | null;
}

/* --------------------------------------------------------------- agent tools */

export const DRAFT_TOOL_INPUT_TYPES = [
  "string",
  "number",
  "boolean",
  "string[]",
  "object",
] as const;

export type DraftToolInputType = (typeof DRAFT_TOOL_INPUT_TYPES)[number];

export interface DraftToolInputField {
  readonly type: DraftToolInputType;
  readonly required: boolean;
  readonly description: string;
}

export type DraftToolInputSchema = Readonly<
  Record<string, DraftToolInputField>
>;

/**
 * DRAFT. An agent tool a plugin contributes (§10.1, §10.2).
 *
 * Native counterpart: `AgentTool` in `@plotroom/core`'s catalog (Epic 4.5) — and
 * the shape of `requires` below is deliberately a *subset* of `ToolRequirements`.
 * A plugin declares what it needs; it does not get to declare its own reflexivity
 * class or claim exemptions, because those are the enforced asymmetry (principle 8)
 * and a plugin that could set them could opt out of them.
 *
 * `call` receives no actor. **The tool acts as the calling session** (principle 1),
 * which the host supplies and a plugin cannot override.
 */
export interface DraftAgentTool {
  readonly name: string;
  readonly summary: string;
  readonly input: DraftToolInputSchema;
  readonly requires: {
    /** Whether it writes; the host routes writes through §6.6 and §3.4. */
    readonly mutates: boolean;
    /** Set when this tool is a write action, so reversibility comes from there. */
    readonly writeActionId: string | null;
    /** Which declared permissions it needs (§10.2). */
    readonly permissions: readonly DraftPermissionId[];
  };
  call(input: unknown): Promise<DraftToolResult>;
}

export interface DraftToolResult {
  readonly ok: boolean;
  readonly content: string;
}

/* ---------------------------------------------------------------- renderers */

/**
 * DRAFT. Content renderers: agent-ready content **and its delta** (§10.1, §3.2).
 *
 * Native counterpart: `ObjectRenderings` plus the version delta model (Epic 1.1).
 * The delta is a contribution point rather than a host computation because "what's
 * new" is kind-specific — a PR's delta is not a diff of its description — and
 * **never silently truncating** (principle 12) is the renderer's obligation too:
 * `truncated` is a fact it reports, not something the host discovers.
 */
export interface DraftContentRenderer {
  readonly kinds: readonly DraftConceptKind[];
  renderAgentContent(
    object: DraftProducedObject,
  ): Promise<DraftRenderedContent>;
  renderDelta(
    previous: DraftProducedObject,
    next: DraftProducedObject,
  ): Promise<DraftRenderedContent>;
}

export interface DraftRenderedContent {
  readonly content: string;
  /** Never a silent cap (principle 12): the host warns with what was dropped. */
  readonly truncated: {
    readonly omittedBytes: number;
    readonly why: string;
  } | null;
}

/**
 * DRAFT. Card renderers, compact and expanded, including in-canvas interactive
 * surfaces (§10.1, §5).
 *
 * Native counterpart: the canvas node renderers in `@plotroom/ui` (Epic 3.x), which
 * switch by zoom level. Nodes stay DOM-based so plugin cards and keyboard
 * accessibility both work (§11, AGENTS.md canvas notes) — so this returns a
 * declarative description the host renders, not markup or a component: a plugin
 * cannot be handed the DOM without also being handed the ability to break focus
 * management for the whole board.
 *
 * The shape of `DraftCardView` is the biggest open question in this draft and is
 * marked as such in `docs/plugin-contract-draft.md`.
 */
export interface DraftCardRenderer {
  readonly kinds: readonly DraftConceptKind[];
  renderCard(
    object: DraftProducedObject,
    detail: "compact" | "expanded",
  ): Promise<DraftCardView>;
}

export interface DraftCardView {
  readonly title: string;
  readonly lines: readonly string[];
  /** Interactive surfaces are actions the host draws and dispatches (§10.1). */
  readonly actions: readonly {
    readonly id: string;
    readonly label: string;
    /** Set when the action is a write, so §6.6 applies to a card button too. */
    readonly writeActionId: string | null;
  }[];
}

/* ------------------------------------------------- panels, palette, themes */

/** DRAFT. A panel (§10.1, §11). Native counterpart: the app's own panels (Epic 3.4). */
export interface DraftPanel {
  readonly id: string;
  readonly title: string;
  /** Where it can live, so the host places it rather than the plugin. */
  readonly placement: "right" | "bottom";
  render(): Promise<DraftCardView>;
}

/**
 * DRAFT. A palette or command-palette entry (§10.1, §11).
 *
 * Native counterpart: the command palette (Epic 3.4/8.1). Every binding is
 * documented in the shortcuts overlay — "none undocumented" (§11) — so a
 * contributed entry supplies its own description and the overlay lists it.
 */
export interface DraftPaletteEntry {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  invoke(): Promise<void>;
}

/** DRAFT. A theme (§10.1). Styling approach is still an open decision (AGENTS.md). */
export interface DraftTheme {
  readonly id: string;
  readonly name: string;
  readonly tokens: Readonly<Record<string, string>>;
}

/* ----------------------------------------------------------- workspace kinds */

/**
 * DRAFT. A workspace kind, with its own provisioning, readiness, and divergence
 * rules (§10.1, §3.4).
 *
 * Native counterpart: `@plotroom/core`'s `workspaces/` subtree — `kind.ts`,
 * `lifecycle.ts`, `readiness.ts`, `divergence.ts` (Epic 4.4). The port is the
 * closest thing to a proof this contract is real: the git workspace kind is the
 * most demanding contribution in §10.1, and if it cannot be expressed here the
 * shape is wrong rather than git being special.
 *
 * Divergence is **observed, never inferred** (principle 7): `divergence` reports
 * what it looked at, and a state it could not read is reported as unreadable rather
 * than as clean.
 */
export interface DraftWorkspaceKind {
  readonly id: string;
  readonly label: string;
  provision(request: DraftProvisionRequest): Promise<DraftProvisionResult>;
  readiness(workspacePath: string): Promise<DraftReadiness>;
  divergence(workspacePath: string): Promise<DraftDivergence>;
  release(workspacePath: string): Promise<void>;
}

export interface DraftProvisionRequest {
  readonly workstreamId: DraftId;
  readonly source: string;
  readonly targetPath: string;
}

export interface DraftProvisionResult {
  readonly ok: boolean;
  readonly path: string | null;
  readonly message: string;
}

export interface DraftReadiness {
  readonly state: "ready" | "provisioning" | "failed";
  readonly detail: string;
}

export interface DraftDivergence {
  /** `"unknown"` is a first-class answer, not an absent one (principle 7). */
  readonly state: "clean" | "diverged" | "unreadable";
  readonly detail: string;
}

/* ------------------------------------------------------------ condition checks */

/**
 * DRAFT. A condition check: a predicate for **proving** completion (§10.1,
 * principle 3).
 *
 * Native counterpart: the server's world-condition registry (Epic 4.3) that
 * `checkProvenCompletion` consults. Two properties the freeze must keep:
 *
 * - It **reads**, and the host calls it. A check that could start work would be the
 *   product originating work (principle 2).
 * - `"unknown"` is a distinct answer from `"failed"`. A check that could not run has
 *   not disproved completion, and reporting it as failure would make a flaky check
 *   read as a failed run (§3.5).
 */
export interface DraftConditionCheck {
  readonly id: string;
  readonly summary: string;
  readonly input: DraftToolInputSchema;
  check(input: unknown): Promise<DraftConditionResult>;
}

export interface DraftConditionResult {
  readonly state: "met" | "unmet" | "unknown";
  /** The evidence, because completion is proven rather than claimed. */
  readonly evidence: string;
}

/* -------------------------------------------------------- notification routes */

/**
 * DRAFT. An outbound notification route (§10.1, §7.3).
 *
 * Native counterpart: Track B's outbound routing (Epic 6.1). Redaction is the
 * host's, not the route's: the host hands over an already-redacted payload, because
 * a route that received the full content and was trusted to redact it is a
 * credential leak one bug away (§9.3).
 */
export interface DraftNotificationRoute {
  readonly id: string;
  readonly label: string;
  send(payload: DraftNotification): Promise<void>;
}

export interface DraftNotification {
  readonly title: string;
  /** Already redacted by the host (§7.3). */
  readonly body: string;
  readonly at: DraftEpochMillis;
}

/* --------------------------------------------------------- command definitions */

/**
 * DRAFT. A command definition a plugin ships (§10.1, §3.5).
 *
 * Native counterpart: `CommandDefinition` in `@plotroom/core` (Epic 1.4). A
 * contributed definition is a **starting point the operator edits**, not a locked
 * one: §3.5's definitions are "user-editable content", so the host copies it in and
 * the plugin does not own it afterwards.
 */
export interface DraftCommandDefinition {
  readonly id: string;
  readonly name: string;
  readonly instruction: string;
  readonly lifecycle: "producing" | "open";
  /** Required for `producing`, refused for `open` — the schema enforces it (§3.5). */
  readonly expectedOutcome: string | null;
  readonly conditionCheckIds: readonly string[];
}

/* ------------------------------------------------------------- the manifest */

/**
 * DRAFT. What a plugin exports. Every field optional: a plugin that contributes one
 * thing declares one thing, and a manifest is not a checklist.
 */
export interface DraftPluginManifest {
  readonly name: string;
  readonly version: string;
  /** The contract version it was built against; the host refuses or warns (§10.2). */
  readonly contractVersion: number;
  readonly permissions: readonly DraftPermissionRequest[];
  readonly conceptProducers?: readonly DraftConceptProducer[];
  readonly writeActions?: readonly DraftWriteAction[];
  readonly agentTools?: readonly DraftAgentTool[];
  readonly contentRenderers?: readonly DraftContentRenderer[];
  readonly cardRenderers?: readonly DraftCardRenderer[];
  readonly panels?: readonly DraftPanel[];
  readonly paletteEntries?: readonly DraftPaletteEntry[];
  readonly workspaceKinds?: readonly DraftWorkspaceKind[];
  readonly conditionChecks?: readonly DraftConditionCheck[];
  readonly notificationRoutes?: readonly DraftNotificationRoute[];
  readonly commandDefinitions?: readonly DraftCommandDefinition[];
  readonly themes?: readonly DraftTheme[];
}
