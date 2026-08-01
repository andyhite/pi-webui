/**
 * The agent tool catalog (Epic 4.5, principle 8).
 *
 * "Every gesture a human has is available to an agent as a tool, over the same
 * vocabulary, so the two surfaces cannot drift apart and there is no privileged
 * mode. The asymmetry is _reflexivity_."
 *
 * This is **one declaration** of that vocabulary: each tool names the endpoint it
 * calls, the input it takes, and what it requires — a claim, an approval, a
 * lineage check, or the operator. Nothing else in the system is allowed a second
 * list. Two mechanisms keep it honest rather than aspirational:
 *
 * 1. `catalog.test.ts` pins the catalog to the server's *mounted routes*, in both
 *    directions: a `live` tool naming an endpoint that does not exist fails, and a
 *    mutating endpoint with no tool fails unless it is declared operator-only.
 *    A gesture cannot land for one surface only.
 * 2. `availability` marks the tools whose endpoint is still Track A's to mount.
 *    A `pending` tool whose endpoint has appeared also fails the test, so the flag
 *    cannot rot into a lie.
 *
 * What is deliberately *not* pinned yet: body field names. The route schemas live
 * in `apps/server` (zod) and this package cannot import them without inverting the
 * layering, so the field lists here are declarations checked by review, and the
 * test pins method and path only. When request schemas move into `core` as shared
 * shapes, this table derives from them instead.
 */

export const HTTP_METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

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
  /**
   * True when this field fills a `:name` segment of the endpoint path rather than
   * the body. The bridge substitutes it; a missing one is a refusal, never a
   * request to a literal `:id`.
   */
  readonly inPath?: boolean;
}

export type ToolInputSchema = Readonly<Record<string, ToolInputField>>;

export const TOOL_REFLEXIVITY_CLASSES = [
  /** Nothing about this call can reach the caller's own chain. */
  "none",
  /** Authors context into whatever sessions the target feeds (principle 1). */
  "target-session",
  /** Grants or narrows capability — permissions, tool access. */
  "capability",
  /** Changes what may be spent. */
  "budget",
  /**
   * The target inherently includes the author — a standing instruction that
   * applies everywhere, a default derived for its own parameters. A session
   * proposes and a human accepts; it is never applied silently (principle 1).
   */
  "self-proposal",
] as const;

export type ToolReflexivityClass = (typeof TOOL_REFLEXIVITY_CLASSES)[number];

/**
 * The authored state a destruction-class tool removes (§6.6, principle 10).
 *
 * "Destructive gestures against authored state requested by an agent go through
 * this same channel." *Which* gestures those are is data on the tool rather than a
 * list somewhere else, so the wiring is a lookup and not a judgement: a session
 * calling a tool with `destroys` set routes through `decideDestruction`, and every
 * other tool does not.
 *
 * The kinds are the authored things — "the arrangement and the topology are
 * authored work nobody can recreate" (principle 10). A claim yielded, a queued run
 * cancelled, or a waitlist place withdrawn is also a `DELETE`, and none of them is
 * authored state: nothing is destroyed, capability is handed back. That is why this
 * is declared per tool instead of derived from the HTTP method, and why
 * `catalog.test.ts` pins it against `approval: "always"` in both directions.
 */
export const DESTRUCTION_TARGET_KINDS = [
  "workstream",
  "object",
  "node",
  "edge",
  "command",
  "command-definition",
] as const;

export type DestructionTargetKind = (typeof DESTRUCTION_TARGET_KINDS)[number];

export interface ToolRequirements {
  readonly reflexivity: ToolReflexivityClass;
  /**
   * How `ToolTargetIndex.sessionsAffected` must resolve this call's target for
   * the lineage check to mean what the spec says — the **mounting contract** for
   * whoever implements the index, carried as data beside the tool rather than as
   * a comment somewhere else. Required for every lineage-checked tool (the
   * catalog test enforces that), because a resolution nobody wrote down is a
   * refusal that fires on the wrong calls.
   */
  readonly targetResolution?: string;
  /** The operator's alone. A session calling it is refused, not advised. */
  readonly humanOnly: boolean;
  /** Names the input field carrying a workspace path a write claim is needed for (§3.4). */
  readonly claimOnInput?: string;
  /** Whether it raises an approval (§6.6). */
  readonly approval: "never" | "outside-policy" | "always";
  /**
   * Set on the destruction-class tools: what a session calling this would remove.
   * Absent means the tool destroys no authored state.
   */
  readonly destroys?: DestructionTargetKind;
  readonly mutates: boolean;
}

export interface AgentTool {
  /** Agent-facing name: snake_case, stable, greppable. */
  readonly name: string;
  readonly summary: string;
  /** The human gesture this mirrors, so the pairing is reviewable (principle 8). */
  readonly gesture: string;
  readonly method: HttpMethod;
  /** Exactly as the server mounts it, including `/api` and `:params`. */
  readonly endpoint: string;
  readonly availability: "live" | "pending";
  readonly input: ToolInputSchema;
  readonly requires: ToolRequirements;
}

/**
 * The resolution most lineage-checked tools share: what a node *feeds*.
 *
 * Authoring context into a command node reaches whatever that command runs, so
 * the check has to see through the node to the sessions behind it — otherwise
 * routing an edit through a command a session created would slip past principle
 * 1's "or route around any of this through a chain it started".
 */
const NODE_TARGETS =
  "the sessions the target node feeds: a running session directly, or every session a command node has run and would run next.";

/**
 * §3.4 exempts claims from the reflexivity rule, and says why: "a child asking
 * its parent for write access reads like a chain granting itself capability. It
 * is not — a claim can only be granted from capability the granter already
 * holds." Resolving these to the waiter would refuse the parent-to-child grant
 * the whole claim model is built on. The real bound is the claim manager's extent
 * check (`exceeds_grant`), which no grant can talk its way past.
 */
const CLAIM_EXEMPT_TARGETS =
  "the empty set: never the waiting or receiving session (§3.4's stated exemption; the claim manager's extent check is what bounds these).";

const NO_REFLEXIVITY: ToolRequirements = {
  reflexivity: "none",
  humanOnly: false,
  approval: "never",
  mutates: false,
};

function read(
  name: string,
  summary: string,
  gesture: string,
  endpoint: string,
  input: ToolInputSchema = {},
): AgentTool {
  return {
    name,
    summary,
    gesture,
    method: "GET",
    endpoint,
    availability: "live",
    input,
    requires: NO_REFLEXIVITY,
  };
}

function id(description: string): ToolInputField {
  return { type: "string", required: true, description, inPath: true };
}

const ID = id("the entity's id");

function mutate(
  tool: Omit<AgentTool, "availability" | "requires"> & {
    readonly availability?: AgentTool["availability"];
    readonly requires?: Partial<ToolRequirements>;
  },
): AgentTool {
  const { requires, availability, ...rest } = tool;
  return {
    ...rest,
    availability: availability ?? "live",
    requires: {
      reflexivity: "none",
      humanOnly: false,
      approval: "never",
      mutates: true,
      ...requires,
    },
  };
}

/* ------------------------------------------------------------- workstreams */

const workstreamTools: readonly AgentTool[] = [
  mutate({
    name: "workstream_create",
    summary: "Create a workstream, optionally with a subject object.",
    gesture: "drop a command definition on a bare ticket (§3.5)",
    method: "POST",
    endpoint: "/api/workstreams",
    input: {
      subjectId: {
        type: "string",
        required: false,
        description: "the object that becomes the workstream's subject",
      },
    },
  }),
  read(
    "workspace_diff_read",
    "Read a workspace's changes: the file tree and the patch per file, read-only (§11).",
    "the Diff panel",
    "/api/workstreams/:id/diff",
    { id: ID },
  ),
  read(
    "workstream_spend_read",
    "Read a workstream's total spend — every session in it, counted once (§8).",
    "the spend line on a workstream card",
    "/api/workstreams/:id/spend",
    { id: ID },
  ),
  read(
    "workstream_list",
    "List workstreams.",
    "the canvas at workstream zoom (§5)",
    "/api/workstreams",
  ),
  read(
    "workstream_get",
    "Read one workstream.",
    "select a workstream card",
    "/api/workstreams/:id",
    { id: ID },
  ),
  mutate({
    name: "workstream_update",
    summary: "Edit a workstream's subject or lifecycle status.",
    gesture: "edit a workstream card",
    method: "PATCH",
    endpoint: "/api/workstreams/:id",
    input: {
      id: ID,
      subjectId: {
        type: "string",
        required: false,
        description: "new subject object",
      },
      status: {
        type: "string",
        required: false,
        description:
          "active | done | abandoned | archived — authored, never inferred (§3.3)",
      },
    },
  }),
  mutate({
    name: "workstream_archive",
    summary: "Archive a workstream.",
    gesture: "archive from the workstream menu (§6.8)",
    method: "POST",
    endpoint: "/api/workstreams/:id/archive",
    input: { id: ID },
  }),
  mutate({
    name: "workstream_unarchive",
    summary: "Return an archived workstream to active.",
    gesture: "unarchive from search results (§6.8)",
    method: "POST",
    endpoint: "/api/workstreams/:id/unarchive",
    input: { id: ID },
  }),
  mutate({
    name: "workstream_delete",
    summary: "Remove a workstream. Recoverable (principle 10).",
    gesture: "delete a workstream",
    method: "DELETE",
    endpoint: "/api/workstreams/:id",
    input: { id: ID },
    requires: { approval: "always", destroys: "workstream" },
  }),
  mutate({
    name: "workstream_restore",
    summary: "Restore a removed workstream.",
    gesture: "undo a deletion (principle 10)",
    method: "POST",
    endpoint: "/api/workstreams/:id/restore",
    input: { id: ID },
  }),
];

/* ---------------------------------------------------------------- objects */

const objectTools: readonly AgentTool[] = [
  mutate({
    name: "object_write",
    summary: "Create an object with its three renderings (§3.2).",
    gesture: "an integration read, or producing a result",
    method: "POST",
    endpoint: "/api/objects",
    input: {
      kind: {
        type: "string",
        required: true,
        description: "object kind (§3.1)",
      },
      title: {
        type: "string",
        required: true,
        description: "human-facing title",
      },
      renderings: {
        type: "object",
        required: true,
        description: "card, summary, agentContent (§3.2)",
      },
      external: {
        type: "object",
        required: false,
        description: "system + id, for re-read reconciliation",
      },
      workstreamId: {
        type: "string",
        required: false,
        description: "local scope; omit for world scope",
      },
    },
  }),
  mutate({
    name: "object_edit",
    summary: "Edit an object; each edit is a new version.",
    gesture: "edit a card's content (§3.8)",
    method: "PATCH",
    endpoint: "/api/objects/:id",
    input: {
      id: ID,
      title: { type: "string", required: false, description: "new title" },
      renderings: {
        type: "object",
        required: false,
        description: "replacement renderings",
      },
    },
  }),
  read("object_get", "Read one object.", "select a card", "/api/objects/:id", {
    id: ID,
  }),
  read(
    "object_versions",
    "List an object's versions and deltas (§3.2).",
    "the version history on a card",
    "/api/objects/:id/versions",
    { id: ID },
  ),
  mutate({
    name: "object_promote",
    summary: "Promote a local object to world scope (§3.2).",
    gesture: "promote-to-world",
    method: "POST",
    endpoint: "/api/objects/:id/promote",
    input: { id: ID },
  }),
  mutate({
    name: "object_delete",
    summary: "Remove an object. Recoverable (principle 10).",
    gesture: "delete a card",
    method: "DELETE",
    endpoint: "/api/objects/:id",
    input: { id: ID },
    requires: { approval: "always", destroys: "object" },
  }),
  mutate({
    name: "object_restore",
    summary: "Restore a removed object.",
    gesture: "undo a deletion",
    method: "POST",
    endpoint: "/api/objects/:id/restore",
    input: { id: ID },
  }),
  mutate({
    name: "note_create",
    summary:
      "Write a note — the fastest path from a thought to the graph (§3.8).",
    gesture: "new note",
    method: "POST",
    endpoint: "/api/notes",
    input: {
      title: { type: "string", required: true, description: "note title" },
      body: { type: "string", required: true, description: "note body" },
      workstreamId: {
        type: "string",
        required: false,
        description: "local scope",
      },
    },
  }),
  mutate({
    name: "note_edit",
    summary:
      "Edit a note; the edit versions it and drifts its consumers (§3.8).",
    gesture: "edit a note",
    method: "PATCH",
    endpoint: "/api/notes/:id",
    input: {
      id: ID,
      title: { type: "string", required: false, description: "new title" },
      body: { type: "string", required: true, description: "new body" },
    },
  }),
];

/* ------------------------------------------------------------------ graph */

const graphTools: readonly AgentTool[] = [
  mutate({
    name: "node_place",
    summary:
      "Place a node on the canvas (principle 6: a gesture, never a scan).",
    gesture: "drag from the palette onto the canvas",
    method: "POST",
    endpoint: "/api/nodes",
    input: {
      role: {
        type: "string",
        required: true,
        description: "content | command | session",
      },
      refId: {
        type: "string",
        required: true,
        description: "what the node stands for",
      },
      workstreamId: {
        type: "string",
        required: false,
        description: "containing workstream",
      },
      running: {
        type: "boolean",
        required: false,
        description: "sessions only",
      },
    },
  }),
  read("node_get", "Read one node.", "select a node", "/api/nodes/:id", {
    id: ID,
  }),
  mutate({
    name: "node_delete",
    summary: "Remove a node and its context edges. Recoverable.",
    gesture: "delete a node",
    method: "DELETE",
    endpoint: "/api/nodes/:id",
    input: { id: ID },
    requires: { approval: "always", destroys: "node" },
  }),
  mutate({
    name: "node_restore",
    summary: "Restore a removed node with exactly the edges its removal took.",
    gesture: "undo a node deletion",
    method: "POST",
    endpoint: "/api/nodes/:id/restore",
    input: { id: ID },
  }),
  read(
    "context_list",
    "List a target's ordered context inputs (§3.5).",
    "the context list on a command card",
    "/api/nodes/:id/context",
    { id: ID },
  ),
  mutate({
    name: "context_reorder",
    summary: "Reorder context inputs — assembly order is edge order (§3.5).",
    gesture: "drag to reorder context",
    method: "POST",
    endpoint: "/api/nodes/:id/context/order",
    input: {
      id: ID,
      edgeIds: {
        type: "string[]",
        required: true,
        description: "the full edge order",
      },
    },
    requires: {
      reflexivity: "target-session",
      targetResolution: NODE_TARGETS,
    },
  }),
  mutate({
    name: "edge_wire",
    summary: "Wire content into a command or a running session (§3.7).",
    gesture: "drag an edge on the canvas",
    method: "POST",
    endpoint: "/api/edges",
    input: {
      from: {
        type: "string",
        required: true,
        description: "source node (content)",
      },
      to: {
        type: "string",
        required: true,
        description: "target node (command or running session)",
      },
      ordinal: {
        type: "number",
        required: false,
        description: "assembly position",
      },
    },
    requires: {
      reflexivity: "target-session",
      targetResolution: NODE_TARGETS,
    },
  }),
  mutate({
    name: "edge_delete",
    summary: "Remove a context edge. Recoverable.",
    gesture: "delete an edge",
    method: "DELETE",
    endpoint: "/api/edges/:id",
    input: { id: ID },
    requires: {
      reflexivity: "target-session",
      approval: "always",
      destroys: "edge",
      targetResolution: NODE_TARGETS,
    },
  }),
  mutate({
    name: "edge_restore",
    summary: "Restore a removed edge.",
    gesture: "undo an edge deletion",
    method: "POST",
    endpoint: "/api/edges/:id/restore",
    input: { id: ID },
    requires: {
      reflexivity: "target-session",
      targetResolution: NODE_TARGETS,
    },
  }),
];

/* --------------------------------------------------------------- commands */

const commandTools: readonly AgentTool[] = [
  mutate({
    name: "command_definition_create",
    summary: "Create a command definition — reusable marching orders (§3.5).",
    gesture: "new command definition",
    method: "POST",
    endpoint: "/api/command-definitions",
    input: {
      name: { type: "string", required: true, description: "definition name" },
      instruction: {
        type: "string",
        required: true,
        description: "the instruction",
      },
      model: { type: "string", required: true, description: "model" },
      effort: { type: "string", required: true, description: "effort level" },
      lifecycle: {
        type: "string",
        required: true,
        description: "producing | open",
      },
      outcome: {
        type: "object",
        required: false,
        description: "expected outcome; producing only",
      },
      permissions: {
        type: "object",
        required: false,
        description: "allowed/denied tools",
      },
      askPoints: {
        type: "string[]",
        required: false,
        description: "where the user wants to be asked",
      },
      parameters: {
        type: "object",
        required: false,
        description: "declared inputs",
      },
      budget: {
        type: "object",
        required: false,
        description: "content budget",
      },
      folder: {
        type: "string",
        required: false,
        description: "organizing folder",
      },
    },
    requires: {
      reflexivity: "capability",
      targetResolution:
        "the empty set: a definition nobody has instantiated grants nothing to anyone yet. `command_definition_edit` is where changing what a session may do actually reaches a chain.",
    },
  }),
  read(
    "command_definition_list",
    "List command definitions.",
    "the command palette rail (§5)",
    "/api/command-definitions",
  ),
  read(
    "command_definition_get",
    "Read one command definition.",
    "open a definition",
    "/api/command-definitions/:id",
    { id: ID },
  ),
  mutate({
    name: "command_definition_edit",
    summary: "Edit a command definition.",
    gesture: "edit a definition",
    method: "PATCH",
    endpoint: "/api/command-definitions/:id",
    input: {
      id: ID,
      instruction: {
        type: "string",
        required: false,
        description: "new instruction",
      },
      model: { type: "string", required: false, description: "new model" },
      permissions: {
        type: "object",
        required: false,
        description: "new tool permissions",
      },
    },
    requires: {
      reflexivity: "capability",
      targetResolution:
        "every session run from this definition, plus the sessions of every command node instantiated from it — editing tool permissions changes what those may do, which is granting capability (principle 1).",
    },
  }),
  mutate({
    name: "command_definition_duplicate",
    summary:
      "Duplicate a definition — how you start from a shipped recipe (§3.5).",
    gesture: "duplicate a definition",
    method: "POST",
    endpoint: "/api/command-definitions/:id/duplicate",
    input: {
      id: ID,
      name: {
        type: "string",
        required: false,
        description: "name for the copy",
      },
    },
  }),
  mutate({
    name: "command_definition_delete",
    summary: "Remove a command definition. Recoverable.",
    gesture: "delete a definition",
    method: "DELETE",
    endpoint: "/api/command-definitions/:id",
    input: { id: ID },
    requires: { approval: "always", destroys: "command-definition" },
  }),
  mutate({
    name: "command_definition_restore",
    summary: "Restore a removed command definition.",
    gesture: "undo a definition deletion",
    method: "POST",
    endpoint: "/api/command-definitions/:id/restore",
    input: { id: ID },
  }),
  mutate({
    name: "command_instantiate",
    summary: "Instantiate a command node with its wiring (§3.5).",
    gesture: "drop a definition onto a target",
    method: "POST",
    endpoint: "/api/commands",
    input: {
      definitionId: {
        type: "string",
        required: true,
        description: "definition to instantiate",
      },
      workstreamId: {
        type: "string",
        required: true,
        description: "containing workstream",
      },
      context: {
        type: "string[]",
        required: false,
        description: "node ids wired as context",
      },
    },
    requires: {
      reflexivity: "target-session",
      targetResolution:
        "the sessions any wired context node already feeds — a running session directly, or a command's own sessions. A command nobody has run reaches nothing, so instantiating one is usually unchecked; wiring context into it later is where the check bites.",
    },
  }),
  read(
    "command_get",
    "Read one command node.",
    "select a command card",
    "/api/commands/:id",
    {
      id: ID,
    },
  ),
  mutate({
    name: "command_delete",
    summary: "Remove a command node. Recoverable.",
    gesture: "delete a command node",
    method: "DELETE",
    endpoint: "/api/commands/:id",
    input: { id: ID },
    requires: { approval: "always", destroys: "command" },
  }),
  mutate({
    name: "command_restore",
    summary: "Restore a removed command node.",
    gesture: "undo a command deletion",
    method: "POST",
    endpoint: "/api/commands/:id/restore",
    input: { id: ID },
  }),
  mutate({
    name: "command_parameter_confirm",
    summary:
      "Confirm a parameter value — the only path from proposal to value (§3.5).",
    gesture: "confirm a derived default",
    method: "POST",
    endpoint: "/api/commands/:id/parameters/:name/confirm",
    input: {
      id: ID,
      name: id("the parameter name"),
      value: {
        type: "string",
        required: false,
        description: "the confirmed value",
      },
    },
    // A session confirming a default derived for its own run is authoring into
    // itself: it proposes, a human accepts (principle 1).
    requires: { reflexivity: "self-proposal" },
  }),
  mutate({
    name: "output_publish",
    summary: "Publish a typed output placeholder, pre-run (§3.5).",
    gesture: "publish an output",
    method: "POST",
    endpoint: "/api/outputs/:id/publish",
    input: { id: ID },
  }),
  read(
    "output_get",
    "Read an output and its bind state.",
    "select an output placeholder",
    "/api/outputs/:id",
    { id: ID },
  ),
];

/* ------------------------------------------------------- runs and sessions */

/**
 * The run spine's vocabulary (Epic 4.2, §4.1). Every one of these is a gesture a
 * human has, so an agent has it too — the reflexivity asymmetry does the work
 * rather than a shorter list.
 *
 * **`run_one` is also delegation.** "There is exactly one way to start [a
 * session], and it is in the app" (principle 5), so a session dispatching a child
 * is this same endpoint called with a session actor — not a second verb. What
 * makes it a delegation is the actor: the server records the `session_delegated`
 * provenance edge and attributes the child's spend up the initiating chain
 * (`planDelegation`, `attributeSpend` in `delegation.ts`). A separate
 * `session_dispatch` tool would have been a second way to start a session, which
 * is exactly what principle 5 forbids.
 */
const runTools: readonly AgentTool[] = [
  mutate({
    name: "run_one",
    summary:
      "Run one command: assemble its context, start a session, and record the run (§4.1).",
    gesture: "press run on a command card",
    method: "POST",
    endpoint: "/api/runs",
    input: {
      commandId: {
        type: "string",
        required: true,
        description: "the command node to run",
      },
      initiationKey: {
        type: "string",
        required: true,
        description:
          "the caller's own name for this gesture; the same key returns the same run rather than a second one (principle 9)",
      },
      runtime: {
        type: "object",
        required: false,
        description: "adapter selection, where more than one is available",
      },
    },
    requires: {
      reflexivity: "target-session",
      approval: "outside-policy",
      targetResolution:
        "the sessions this command has already run — what a re-run would touch (§4.1). NEVER the session this run is about to create: it is a descendant by construction, and refusing it would refuse delegation itself.",
    },
  }),
  read(
    "run_get",
    "Read a run: what went in, the configuration it ran under, and what came out (§3.7).",
    "open a run in run history",
    "/api/runs/:id",
    { id: ID },
  ),
  read(
    "run_assembled_read",
    "Read exactly the content a run assembled — the record, not a reconstruction (§15-1).",
    "the run preview and the run-history diff",
    "/api/runs/:id/assembled",
    { id: ID },
  ),
  read(
    "command_runs_list",
    "List a command's runs, newest first — the history any two runs are compared over (§4.4).",
    "the run history on a command card",
    "/api/commands/:id/runs",
    { id: ID },
  ),
  read(
    "run_compare",
    "Compare two runs of the same command: what went in, what came out, which model, what it cost (§4.4). Runs of different definitions are refused with the reason.",
    "the compare gesture on run history",
    "/api/runs/:id/compare",
    {
      id: ID,
      with: {
        type: "string",
        required: true,
        description: "the other run's id",
      },
    },
  ),
  read(
    "definition_outcomes_read",
    "Read cross-run outcomes for a command definition: attempts, the end-state histogram, how many attempts it typically takes, and what it costs — which is how \u201cis delegating this kind of work actually working?\u201d becomes answerable (§4.4).",
    "the cross-run outcomes on a command definition",
    "/api/command-definitions/:id/outcomes",
    { id: ID },
  ),
  read(
    "workstream_budget_read",
    "Read what binds a workstream's spend: its own budget and the global ceiling, with what is left (§8).",
    "the spend rollup on a workstream card (§3.3, §8)",
    "/api/workstreams/:id/budget",
    { id: ID },
  ),
  // A tool rather than operator-only: previewing before spending is exactly the
  // gesture principle 8 says both surfaces get, and it is a pure read — it
  // provisions nothing, starts nothing, and records nothing (§4.1).
  read(
    "command_preview",
    "Preview a run: the ordered content it would assemble, what history says it would cost, and everything that would refuse it (§4.1).",
    "the run preview before confirming a run",
    "/api/commands/:id/preview",
    { id: ID },
  ),
  // A read, and the one that makes §4.1's "the run affordance never disables"
  // implementable: a blocked command has a preview to show — "waiting on: …" plus
  // the upstream scope that would unblock it — instead of a disabled button.
  read(
    "run_scope_preview",
    "Preview a scoped run: exactly which commands it would execute in dependency order, what history says the scope may cost, and what each blocked command is waiting on (§4.1).",
    "the run menu's subgraph / what's-missing / re-run-drifted preview",
    "/api/run-scopes/preview",
    {
      scope: {
        type: "string",
        required: true,
        description:
          "one | subgraph | missing | drifted-workstream | drifted-fleet (§4.1)",
      },
      scopeId: {
        type: "string",
        required: false,
        description:
          "the command or workstream the scope is taken from; omitted only for drifted-fleet",
      },
    },
  ),
  mutate({
    name: "run_scope",
    summary:
      "Run a scope: this command, its downstream subgraph, the upstream chain that would unblock it, or everything drifted (§4.1).",
    gesture: "confirming a scoped run from the run menu",
    method: "POST",
    endpoint: "/api/run-scopes",
    input: {
      scope: {
        type: "string",
        required: true,
        description: "which scope (§4.1)",
      },
      scopeId: {
        type: "string",
        required: false,
        description: "the command or workstream the scope is taken from",
      },
      initiationKey: {
        type: "string",
        required: true,
        description:
          "the caller's own name for this gesture; one key covers the whole scope, so a retry cannot produce two batches (principle 9)",
      },
      spendCapMicros: {
        type: "number",
        required: false,
        description: "the cap accepted at the scoped preview (§4.1, §8)",
      },
    },
    requires: {
      reflexivity: "target-session",
      approval: "outside-policy",
      targetResolution:
        "the sessions every command in the resolved scope has already run — the same resolution as `run_one`, applied to each. NEVER the sessions the scope is about to create: they are descendants by construction, and refusing them would refuse a session from fanning work out at all.",
    },
  }),
  read(
    "run_queue_read",
    "Read the queue of already-initiated work: what is waiting, its position, and what is asking to be confirmed because its inputs drifted (§4.1).",
    "the queue of work",
    "/api/run-queue",
  ),
  mutate({
    name: "run_queue_cancel",
    summary:
      "Cancel a queued run before it starts. Refused once it has started — stopping a started run is a stop (§6.7).",
    gesture: "cancel from the queue of work",
    method: "DELETE",
    endpoint: "/api/run-queue/:id",
    input: { id: id("the queued run's id") },
    requires: {
      reflexivity: "target-session",
      targetResolution:
        "the sessions the queued command has already run — the same resolution as `run_one`. A queued run has no session of its own yet, which is exactly why cancelling it is cheap.",
    },
  }),
  mutate({
    name: "run_queue_confirm",
    summary:
      "Confirm a queued run whose inputs drifted while it waited, accepting what it would assemble now. The preview is the contract, so nothing runs without this (§4.1).",
    gesture: "answering the re-ask on a queued run",
    method: "POST",
    endpoint: "/api/run-queue/:id/confirm",
    input: { id: id("the queued run's id") },
    requires: {
      reflexivity: "target-session",
      approval: "outside-policy",
      targetResolution:
        "the sessions the queued command has already run — the same resolution as `run_one`, because confirming is agreeing to run it.",
    },
  }),
  read(
    "run_batch_read",
    'Read one scoped run and every command in it, settled ones included — which is what a paused batch\'s "address it and resume" is about (§4.1).',
    "opening a paused batch from the queue of work",
    "/api/run-batches/:id",
    { id: id("the batch id") },
  ),
  mutate({
    name: "run_batch_resume",
    summary:
      "Resume a batch that paused on a failed or out-of-budget session. An aborted batch never resumes — stopped means stopped (§4.1).",
    gesture: "resume from the paused batch",
    method: "POST",
    endpoint: "/api/run-batches/:id/resume",
    input: { id: id("the batch id") },
    requires: {
      reflexivity: "target-session",
      approval: "outside-policy",
      targetResolution:
        "the sessions every command still in the batch has already run — the same resolution as `run_one`. Resuming is initiating the remainder, so it is checked like initiating it.",
    },
  }),
  mutate({
    name: "session_submit",
    summary:
      "Submit a producing session's outcome. PlotRoom checks the declared world conditions itself and returns a failing one as feedback (§3.5).",
    gesture: "submit from the session panel",
    method: "POST",
    endpoint: "/api/sessions/:id/submit",
    input: {
      id: id("the session submitting"),
      outputs: {
        type: "object",
        required: false,
        description:
          "the produced objects and versions, by declared outcome name",
      },
    },
    // Submitting is a session reporting on its *own* work, which is the one thing
    // principle 1 never had a problem with: completion is proven against the
    // world, so nothing here expands what the session knows or may do.
    requires: { reflexivity: "none" },
  }),
];

const sessionTools: readonly AgentTool[] = [
  read(
    "session_list",
    "List sessions with their derived phase and end facts (§3.6).",
    "the fleet view and the queue (§7.1)",
    "/api/sessions",
    {
      workstreamId: {
        type: "string",
        required: false,
        description: "narrow to one workstream",
      },
    },
  ),
  read(
    "session_get",
    "Read one session: its record, phase, accounting, and end state.",
    "select a session node",
    "/api/sessions/:id",
    { id: ID },
  ),
  read(
    "session_observations_read",
    "Read a session's observation log — what PlotRoom observed, which is what every phase is derived from (principle 7).",
    "the conversation panel's live stream",
    "/api/sessions/:id/observations",
    {
      id: ID,
      since: {
        type: "number",
        required: false,
        description: "only records after this sequence number",
      },
    },
  ),
  read(
    "session_spend_read",
    "Read what a session's budgets are charged: its own work plus everything it delegated (§3.6, principle 2).",
    "the accounting on a session card (§8)",
    "/api/sessions/:id/spend",
    { id: ID },
  ),
  // §8's own sentence: "a session can see what remains of every budget that binds
  // it and plan accordingly." A read, deliberately — seeing a cap is not raising
  // one, and principle 1 forbids only the raising.
  read(
    "session_budget_read",
    "Read what remains of every budget that binds this session — its run's cap, every ancestor's, its workstream's, and the global ceiling — with the tightest one named (§8). Near a cap, wrap up cleanly; racing the budget is a failure mode, not a saving.",
    "the remaining-budget line on a session card (§8)",
    "/api/sessions/:id/budget",
    { id: ID },
  ),
  read(
    "session_timeline_read",
    "Read where a session's time and money went: turns and tool calls in order, for a finished session as much as a running one (§8).",
    "the session timeline panel (§11)",
    "/api/sessions/:id/timeline",
    { id: ID },
  ),
  read(
    "session_transcript_read",
    "Read a session's transcript with its three renderings (§6.1).",
    "the conversation panel",
    "/api/sessions/:id/transcript",
    { id: ID },
  ),
  mutate({
    name: "session_stop",
    summary:
      "Stop a session (§6.7). A budget stop is PlotRoom's own and records out-of-budget.",
    gesture: "stop, at session scope",
    method: "POST",
    endpoint: "/api/sessions/:id/stop",
    input: {
      id: ID,
      mode: {
        type: "string",
        required: false,
        description: "graceful | hard",
      },
      cause: {
        type: "string",
        required: false,
        description: "user | budget — budget is PlotRoom's own initiation",
      },
      scope: {
        type: "string",
        required: false,
        description: "which budget ran out, when the cause is budget",
      },
    },
    // Stopping is not authoring: it takes capability away rather than granting
    // any, so a session may stop a peer. What it may not do is stop work in its
    // own chain to escape a gate, so the lineage check still applies.
    requires: {
      reflexivity: "target-session",
      approval: "outside-policy",
      targetResolution:
        "the session named by the id, and nothing else — stopping reaches exactly one session.",
    },
  }),
  mutate({
    name: "session_end",
    summary: "End an open session — the way open work finishes (§3.5).",
    gesture: "end from the session panel",
    method: "POST",
    endpoint: "/api/sessions/:id/end",
    input: { id: ID },
    requires: {
      reflexivity: "target-session",
      targetResolution:
        "the session named by the id, and nothing else. The actor is recorded on the end state, so a peer ending an open session is attributable (§3.6).",
    },
  }),
  mutate({
    name: "session_checkpoint",
    summary:
      "Checkpoint a live transcript, publishing what has been said so far (§3.6).",
    gesture: "checkpoint from the conversation panel",
    method: "POST",
    endpoint: "/api/sessions/:id/checkpoint",
    input: { id: ID },
    // §3.6 allows the session itself: "its consumers drift when the session ends
    // or when someone — the session included — explicitly checkpoints it."
    // Publishing what it already said adds nothing to what it knows.
    requires: { reflexivity: "none" },
  }),
];

/* ------------------------------------------- steering in flight (Epic 5.2) */

/**
 * Injection, questions, broadcast, and batch (§6.5, §6.4, §4.2).
 *
 * Live since Batch 3's stage 2: `apps/server/src/routes/steering.ts` mounts them
 * over these planners, and the human-only one is enforced by the request's actor
 * as well as by the flag below — a flag describes, and the route is the gate.
 */
const steeringTools: readonly AgentTool[] = [
  mutate({
    name: "session_inject",
    summary:
      "Add content to a running session mid-flight: it arrives as a new turn and stays on the graph, wired to the session, attributed to you (§6.5).",
    gesture: "type into a running session's composer",
    method: "POST",
    endpoint: "/api/sessions/:id/inject",

    input: {
      id: id("the running session to steer"),
      text: {
        type: "string",
        required: true,
        description: "what to say; it becomes a content node on the graph",
      },
      injectionId: {
        type: "string",
        required: false,
        description:
          "the caller's own name for this gesture; the same id returns the same injection rather than a second one (principle 9)",
      },
    },
    // "Injection is a peer gesture: humans inject, and sessions inject into
    // *other* sessions" — so a session may call this, and the lineage rule is
    // what keeps "other" true. §6.5 accepts the consequence openly: an
    // out-of-chain peer may be *asked* to inject where the asker may not, and
    // both the request and the edge are on the graph, attributed.
    requires: {
      reflexivity: "target-session",
      approval: "outside-policy",
      targetResolution:
        "the session named by the id, and nothing else — an injection reaches exactly one session.",
    },
  }),
  read(
    "session_injections_read",
    "Read a session's injection ledger: what was queued, what was delivered, and what was refused (§6.5).",
    "the composer's queued-versus-delivered state",
    "/api/sessions/:id/injections",
    { id: ID },
  ),
  mutate({
    name: "session_ask",
    summary:
      "Ask the operator a question with selectable options; the answer comes back structurally. Never carries a timeout (§6.4).",
    gesture: "a question bubble on the session node",
    method: "POST",
    endpoint: "/api/sessions/:id/questions",

    input: {
      id: id("the session asking"),
      text: { type: "string", required: true, description: "the question" },
      options: {
        type: "string[]",
        required: true,
        description: "the selectable options; at least one",
      },
      escalateAfterSeconds: {
        type: "number",
        required: false,
        description:
          "how long before the question escalates on the attention surfaces. It NEVER resolves the question: no timed defaults (§6.4, principle 2)",
      },
    },
    // Asking the operator is the one way a session may legitimately expand what
    // it knows: the human answers (principle 1).
    requires: { reflexivity: "none" },
  }),
  mutate({
    name: "question_answer",
    summary:
      "Answer a question a session asked: pick one of its options. The operator's alone (§6.4).",
    gesture: "answer inline from the bubble or the queue (§7.1)",
    method: "POST",
    endpoint: "/api/questions/:id/answer",

    input: {
      id: id("the question"),
      optionId: {
        type: "string",
        required: true,
        description: "one of the options the question offered",
      },
      text: {
        type: "string",
        required: false,
        description:
          "free-form text, only where the question declared it acceptable",
      },
    },
    // A session answering a question posed to the user would be principle 1 with
    // extra steps: the answer is the human's, or it is not an answer.
    requires: { humanOnly: true },
  }),
  read(
    "session_questions_read",
    "Read a session's questions, answered or not, with the options nobody picked still on them (§6.4).",
    "the question bubbles on a session node (§5)",
    "/api/sessions/:id/questions",
    { id: ID },
  ),
  mutate({
    name: "session_broadcast",
    summary:
      "Broadcast to every running session sharing a scope of material state. Names a scope, never recipients; carries a mandatory category; bounded per window; charged to your budget chain (§6.5).",
    gesture: "broadcast to a selection, a workstream, or everything running",
    method: "POST",
    endpoint: "/api/broadcasts",

    input: {
      scope: {
        type: "object",
        required: true,
        description:
          "everyone-in-repository or everyone-in-workspace. A session cannot name recipients; the operator's own broadcast takes a target list instead",
      },
      category: {
        type: "string",
        required: true,
        description:
          "material-state-changed | shared-resource-warning — mandatory, and the only two",
      },
      text: { type: "string", required: true, description: "what to say" },
      broadcastId: {
        type: "string",
        required: false,
        description: "the caller's own name for this gesture (principle 9)",
      },
    },
    // Deliberately reflexivity "none", against the pattern of every other tool
    // that reaches other sessions. §6.5 states the reason: "the scope rule, not
    // lineage exclusion, is what closes the collusion channel... (Excluding the
    // sender's chain would exclude exactly the sessions most likely affected.)"
    // What bounds this one is the scope evaluator, the declared category, the
    // rate bound, the spend attribution, and the operator seeing every send.
    requires: { reflexivity: "none", approval: "outside-policy" },
  }),
  read(
    "broadcast_world_read",
    "Read which sessions are running, where, and in which repository and workspace — the scopes a broadcast can name (§6.5).",
    "the scope picker on the broadcast composer",
    "/api/broadcast-world",
  ),
  mutate({
    name: "batch_gesture",
    summary:
      "One gesture over a multi-selection of sessions: one prompt to many, stop, close, or archive (§4.2).",
    gesture: "a batch action on a multi-selection",
    method: "POST",
    endpoint: "/api/batches",

    input: {
      kind: {
        type: "string",
        required: true,
        description: "inject | stop | close | archive",
      },
      sessionIds: {
        type: "string[]",
        required: true,
        description: "the selection",
      },
      batchKey: {
        type: "string",
        required: true,
        description:
          "the caller's own name for this batch; every member's key derives from it, so a replay writes the same rows (principle 9)",
      },
      prompt: {
        type: "string",
        required: false,
        description: "required for inject; the one prompt sent to many",
      },
    },
    requires: {
      reflexivity: "target-session",
      approval: "outside-policy",
      targetResolution:
        "every session named in `sessionIds` — the batch is the single gesture, so the check sees all of its members. A member in the caller's own chain is skipped with a reason rather than failing the batch (`planBatch`).",
    },
  }),
  read(
    "stop_preview",
    "What a stop would cover: how many sessions, whether the gesture is enabled at all, and whether it confirms (§6.7).",
    "the stop button's own count and enabled state",
    "/api/stops/preview",
    {
      scope: {
        type: "string",
        required: true,
        description: "session | workstream | everything",
      },
      sessionId: {
        type: "string",
        required: false,
        description: "for the session scope",
      },
      workstreamId: {
        type: "string",
        required: false,
        description: "for the workstream scope",
      },
    },
  ),
  mutate({
    name: "stop_scope",
    summary:
      "Stop at a scope: one session, a workstream, or everything running. Names how many it will affect first (§6.7).",
    gesture: "stop, at workstream or fleet scope",
    method: "POST",
    endpoint: "/api/stops",

    input: {
      scope: {
        type: "string",
        required: true,
        description: "session | workstream | everything",
      },
      sessionId: {
        type: "string",
        required: false,
        description: "for the session scope",
      },
      workstreamId: {
        type: "string",
        required: false,
        description: "for the workstream scope",
      },
      confirm: {
        type: "boolean",
        required: false,
        description:
          "required at the widest scope, which confirms before it acts (§6.7)",
      },
    },
    requires: {
      reflexivity: "target-session",
      approval: "outside-policy",
      targetResolution:
        "every running session the scope resolves to (`resolveStop`). This is what makes the fleet-wide stop unavailable to a session without a second rule: `everything` always includes the caller's own chain, so principle 1 refuses it, while a peer workstream's stop goes through.",
    },
  }),
];

/* --------------------------------------- resume, fork, handoff (Epic 5.4) */

/**
 * Live since Batch 3's stage 2: `apps/server/src/routes/continuation.ts` mounts
 * these over `planResume`, `planSessionFork`, and the draft/review/send trio, and
 * the review step is a separate endpoint because "the human edits before sending"
 * is an interaction rather than a flag (§6.3).
 */

const continuationTools: readonly AgentTool[] = [
  mutate({
    name: "session_resume",
    summary:
      "Resume an ended session: the same record continues with a new turn (§6.3). Refused when the workspace diverged (§4.3).",
    gesture: "resume, from the explicit resume-or-fork choice",
    method: "POST",
    endpoint: "/api/sessions/:id/resume",

    input: {
      id: id("the session to resume"),
      firstTurn: {
        type: "string",
        required: false,
        description: "delivered as the resumed session's first turn",
      },
      initiationKey: {
        type: "string",
        required: true,
        description:
          "one gesture, one resumption; a retry returns the same one (principle 9)",
      },
    },
    requires: {
      reflexivity: "target-session",
      approval: "outside-policy",
      targetResolution:
        "the session named by the id, and nothing else. §4.1's rule is what this enforces: a session may not run, resume, or re-run anything in its own initiation chain.",
    },
  }),
  mutate({
    name: "session_fork",
    summary:
      "Fork a session from a point: a new session with its own workstream and workspace, inheriting the conversation up to there (§6.3).",
    gesture: "fork from a transcript point",
    method: "POST",
    endpoint: "/api/sessions/:id/fork",

    input: {
      id: id("the session to fork from"),
      turn: {
        type: "number",
        required: true,
        description:
          "the transcript turn to fork at; the fork inherits everything up to and including it",
      },
      initiationKey: {
        type: "string",
        required: true,
        description: "one gesture, one fork (principle 9)",
      },
    },
    requires: {
      reflexivity: "target-session",
      approval: "outside-policy",
      targetResolution:
        "the session named by the id, and nothing else. NEVER the session the fork is about to create: it is a descendant by construction, and including it would refuse every fork a session makes — the same reasoning as `run_one`.",
    },
  }),
  mutate({
    name: "handoff_brief_write",
    summary:
      "Write the brief for a handoff out of this session. The operator reviews it before it is sent; writing one sends nothing (§6.3).",
    gesture: "the brief a handoff opens with",
    method: "POST",
    endpoint: "/api/sessions/:id/handoff-brief",

    input: {
      id: id("the source session"),
      text: { type: "string", required: true, description: "the brief" },
    },
    // Writing a brief about its own work reaches nothing: the human reviews it,
    // and `planHandoff` cannot be called with an unreviewed brief at all.
    requires: { reflexivity: "none" },
  }),
  read(
    "session_fork_preview",
    "What a fork from a point would be: native or seeded, how clean the point is, and whether the seed is complete (§6.3).",
    "the fork dialog, before anything is spent",
    "/api/sessions/:id/fork-preview",
    {
      id: id("the session to fork from"),
      turn: {
        type: "number",
        required: true,
        description: "the 1-based transcript turn to fork at",
      },
    },
  ),
  read(
    "handoff_briefs_read",
    "Read the handoff briefs written out of a session, drafted and reviewed alike (§6.3).",
    "picking up a brief written earlier",
    "/api/sessions/:id/handoff-briefs",
    { id: ID },
  ),
  mutate({
    name: "handoff_brief_review",
    summary:
      "Review a handoff brief, editing the words before it is sent. The operator's alone — a session approving its own brief is the review not happening (§6.3).",
    gesture: "editing the brief in the handoff dialog",
    method: "POST",
    endpoint: "/api/handoff-briefs/:id/review",
    input: {
      id: id("the brief"),
      text: {
        type: "string",
        required: false,
        description: "the words as they should be sent; omit to send the draft",
      },
    },
    requires: { humanOnly: true },
  }),
  read(
    "command_continuation_preview",
    "Continue or start fresh, side by side: what each mode sends, each mode's gates, and why a refused one is refused (§4.3).",
    "the continue-vs-fresh choice on a re-run",
    "/api/commands/:id/continuation",
    { id: ID },
  ),
  mutate({
    name: "session_handoff",
    summary:
      "Send a reviewed handoff brief: it seeds a new session and stays on the graph as content (§6.3).",
    gesture: "send, from the handoff brief the operator just edited",
    method: "POST",
    endpoint: "/api/handoffs",

    input: {
      briefId: {
        type: "string",
        required: true,
        description: "the reviewed brief",
      },
      workstreamId: {
        type: "string",
        required: true,
        description: "where the new session runs",
      },
      initiationKey: {
        type: "string",
        required: true,
        description: "one gesture, one handoff (principle 9)",
      },
    },
    // The operator's alone, and not because sending is dangerous: §6.3 says the
    // user edits the brief before it is sent, so the send *is* the human's act.
    // A session sending its own brief would be the review not happening.
    requires: { humanOnly: true },
  }),
];

/* ------------------------------------------------------------ whole board */

const boardTools: readonly AgentTool[] = [
  read(
    "snapshot_read",
    "Read the whole board — the same snapshot the canvas resyncs from.",
    "the canvas load",
    "/api/snapshot",
  ),
  read(
    "restorable_list",
    "List what can be restored, including an agent's own deletions (principle 10).",
    "the undo list",
    "/api/restorable",
  ),
  read(
    "fleet_spend_read",
    "Read the fleet's total spend — what everything running and finished has cost (§8).",
    "the fleet panel's today's-total line (§11)",
    "/api/spend",
  ),
  read(
    "fleet_read",
    "Read the fleet view: today's total, the biggest spender, running sessions against the concurrency limit, and every budget with what is left (§8).",
    "the fleet panel (§11)",
    "/api/fleet",
  ),
  read(
    "budgets_read",
    "Read every budget — workstream and the global ceiling — with what has been spent against each (§8).",
    "the budgets section of settings (§8)",
    "/api/budgets",
  ),
  read(
    "health_read",
    "Read server health.",
    "the status indicator",
    "/api/health",
  ),
  {
    ...read(
      "log_level_get",
      "Read the log level.",
      "the operator's log control (§8)",
      "/api/log-level",
    ),
    requires: { ...NO_REFLEXIVITY, humanOnly: true },
  },
  mutate({
    name: "log_level_set",
    summary: "Set the log level.",
    gesture: "the operator's log control (§8)",
    method: "PATCH",
    endpoint: "/api/log-level",
    input: {
      level: { type: "string", required: true, description: "new log level" },
    },
    requires: { humanOnly: true },
  }),
];

/* ----------------------------------------------------------------- claims */

/**
 * The claim tools (§3.4: "sessions get tools to request, yield, and inspect
 * them"), plus the operator's grant and force-release.
 *
 * Live since Epic 5.5: `apps/server/src/routes/claims.ts` mounts them over this
 * package's own claim manager, and the two operator-only ones are enforced by the
 * request's actor rather than by the flag below — a flag describes, and the route
 * is the gate.
 */
const claimTools: readonly AgentTool[] = [
  mutate({
    name: "claim_request",
    summary:
      "Request a write claim on a path. Answers with granted, waitlisted (with position), or an approval raised against the holder.",
    gesture: "the operator granting write access to a path",
    method: "POST",
    endpoint: "/api/workstreams/:id/claims",
    input: {
      id: id("the workstream whose workspace the path is in"),
      path: {
        type: "string",
        required: true,
        description: "workspace-relative path",
      },
      leaseSeconds: {
        type: "number",
        required: false,
        description: "requested lease length",
      },
    },
    requires: { claimOnInput: "path", approval: "outside-policy" },
  }),
  mutate({
    name: "claim_yield",
    summary:
      "Yield a claim you hold — an optimization; ending releases it anyway.",
    gesture: "release a claim",
    method: "DELETE",
    endpoint: "/api/claims/:id",
    input: { id: id("the claim id") },
  }),
  {
    ...read(
      "claim_inspect",
      "Inspect claims: what you hold, what you wait for and where in the queue, what others hold, and the policies in force.",
      "the claims panel",
      "/api/workstreams/:id/claims",
      { id: id("the workstream") },
    ),
  },
  mutate({
    name: "claim_policy_declare",
    summary:
      "Declare a pre-granted policy inside a claim you hold — allow or deny a subtree, so approval is the exception (§3.4).",
    gesture: "the operator pre-granting a subtree",
    method: "POST",
    endpoint: "/api/claims/:id/policies",
    input: {
      id: id("the claim the policy is declared on"),
      subtree: {
        type: "string",
        required: true,
        description: "path within the claim",
      },
      effect: { type: "string", required: true, description: "allow | deny" },
      pattern: {
        type: "string",
        required: false,
        description: "glob relative to the subtree",
      },
    },
    requires: {
      reflexivity: "capability",
      targetResolution: CLAIM_EXEMPT_TARGETS,
    },
  }),
  mutate({
    name: "claim_policy_withdraw",
    summary: "Withdraw a claim policy.",
    gesture: "remove a pre-grant",
    method: "DELETE",
    endpoint: "/api/claim-policies/:id",
    input: { id: id("the policy id") },
    requires: {
      reflexivity: "capability",
      targetResolution: CLAIM_EXEMPT_TARGETS,
    },
  }),
  mutate({
    name: "claim_answer",
    summary: "Answer a claim approval you are the grantor of: grant or deny.",
    gesture: "answering a claim approval from the queue (§7.1)",
    method: "POST",
    endpoint: "/api/claim-waits/:id/answer",
    input: {
      id: id("the claim wait id"),
      decision: { type: "string", required: true, description: "grant | deny" },
    },
    requires: {
      reflexivity: "capability",
      targetResolution:
        'the empty set: NEVER the waiting session. §3.4 states this exemption outright — "a child asking its parent for write access reads like a chain granting itself capability. It is not — a claim can only be granted from capability the granter already holds." Including the waiter would refuse exactly the parent-to-child grant the claim model is built on.',
    },
  }),
  mutate({
    name: "claim_wait_withdraw",
    summary:
      'Withdraw your own place in a waitlist — "never mind, I do not need that path".',
    gesture: "leave the waitlist from the claims panel",
    method: "DELETE",
    endpoint: "/api/claim-waits/:id",
    input: { id: id("the claim wait id") },
    // Giving up a wait takes nothing and grants nothing; the manager refuses a
    // caller who is neither the waiter nor the operator.
    requires: { reflexivity: "none" },
  }),
  mutate({
    name: "claim_grant",
    summary: "Grant a claim directly. The operator's alone (§3.4).",
    gesture: "grant a path to a session",
    method: "POST",
    endpoint: "/api/workstreams/:id/claim-grants",
    input: {
      id: id("the workstream"),
      path: {
        type: "string",
        required: true,
        description: "workspace-relative path",
      },
      to: {
        type: "string",
        required: true,
        description: "session that receives it",
      },
    },
    requires: { humanOnly: true },
  }),
  mutate({
    name: "claim_force_release",
    summary:
      "Force-release a claim — the escape hatch when a holder is wedged and its grantor is too. The operator's alone.",
    gesture: "force-release from the claims panel",
    method: "POST",
    endpoint: "/api/claims/:id/force-release",
    input: {
      id: id("the claim id"),
      cascade: {
        type: "boolean",
        required: false,
        description: "take the sub-claims too",
      },
    },
    requires: { humanOnly: true },
  }),
];

/* ------------------------------------------------------- warnings, agency */

const agencyTools: readonly AgentTool[] = [
  {
    ...read(
      "graph_warnings_read",
      "Read the graph warnings — legal-but-probably-wrong topologies, so a session can fix its own mistake in the same turn (§5).",
      "the warnings on a card and in the editor",
      "/api/warnings",
      {
        workstreamId: {
          type: "string",
          required: false,
          description: "narrow to one workstream",
        },
      },
    ),
    availability: "pending",
  },
  mutate({
    name: "proposal_create",
    summary:
      "Propose a change whose target includes you — a standing instruction, a default for your own parameters. A human accepts it (principle 1).",
    gesture: "none; this exists because a session cannot author into itself",
    method: "POST",
    endpoint: "/api/proposals",
    availability: "pending",
    input: {
      tool: {
        type: "string",
        required: true,
        description: "the tool the proposal would call",
      },
      input: {
        type: "object",
        required: true,
        description: "the call's input",
      },
      rationale: { type: "string", required: false, description: "why" },
    },
  }),
  mutate({
    name: "proposal_accept",
    summary:
      "Accept a proposal, applying it as the human's own act. The operator's alone.",
    gesture: "accept a proposal from the queue (§7.1)",
    method: "POST",
    endpoint: "/api/proposals/:id/accept",
    availability: "pending",
    input: { id: id("the proposal id") },
    requires: { humanOnly: true },
  }),
];

export const AGENT_TOOL_CATALOG: readonly AgentTool[] = [
  ...workstreamTools,
  ...objectTools,
  ...graphTools,
  ...commandTools,
  ...runTools,
  ...sessionTools,
  ...steeringTools,
  ...continuationTools,
  ...boardTools,
  ...claimTools,
  ...agencyTools,
];

export function toolByName(name: string): AgentTool | undefined {
  return AGENT_TOOL_CATALOG.find((tool) => tool.name === name);
}

/** What an agent may call today: the live half of the vocabulary. */
export function liveTools(): readonly AgentTool[] {
  return AGENT_TOOL_CATALOG.filter((tool) => tool.availability === "live");
}

/** What a session may call at all — the operator's own gestures are refused. */
export function sessionCallableTools(): readonly AgentTool[] {
  return AGENT_TOOL_CATALOG.filter((tool) => !tool.requires.humanOnly);
}

/**
 * The destruction-class tools (§6.6): a session calling one raises an approval
 * instead of executing. Derived from the catalog rather than listed again, so a new
 * destructive verb joins this set by declaring `destroys` and nothing else.
 */
export function destructionTools(): readonly AgentTool[] {
  return AGENT_TOOL_CATALOG.filter(
    (tool) => tool.requires.destroys !== undefined,
  );
}

/** Narrows a tool to one whose `destroys` is set, so the kind is not optional. */
export function isDestructionTool(tool: AgentTool): tool is AgentTool & {
  readonly requires: ToolRequirements & {
    readonly destroys: DestructionTargetKind;
  };
} {
  return tool.requires.destroys !== undefined;
}

/** The path parameters an endpoint pattern declares, in order. */
export function pathParametersOf(endpoint: string): readonly string[] {
  return endpoint
    .split("/")
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => segment.slice(1));
}
