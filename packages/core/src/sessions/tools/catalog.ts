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

export interface ToolRequirements {
  readonly reflexivity: ToolReflexivityClass;
  /** The operator's alone. A session calling it is refused, not advised. */
  readonly humanOnly: boolean;
  /** Names the input field carrying a workspace path a write claim is needed for (§3.4). */
  readonly claimOnInput?: string;
  /** Whether it raises an approval (§6.6). */
  readonly approval: "never" | "outside-policy" | "always";
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
    requires: { approval: "always" },
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
    requires: { approval: "always" },
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
    requires: { approval: "always" },
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
    requires: { reflexivity: "target-session" },
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
    requires: { reflexivity: "target-session" },
  }),
  mutate({
    name: "edge_delete",
    summary: "Remove a context edge. Recoverable.",
    gesture: "delete an edge",
    method: "DELETE",
    endpoint: "/api/edges/:id",
    input: { id: ID },
    requires: { reflexivity: "target-session", approval: "always" },
  }),
  mutate({
    name: "edge_restore",
    summary: "Restore a removed edge.",
    gesture: "undo an edge deletion",
    method: "POST",
    endpoint: "/api/edges/:id/restore",
    input: { id: ID },
    requires: { reflexivity: "target-session" },
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
    requires: { reflexivity: "capability" },
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
    requires: { reflexivity: "capability" },
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
    requires: { approval: "always" },
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
    requires: { reflexivity: "target-session" },
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
    requires: { approval: "always" },
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
 * them"), plus the operator's grant and force-release. Their endpoints are
 * Track A's to mount over `@plotroom/core`'s claim manager, so they are `pending`
 * until they exist — visible in the vocabulary, and honest about not being
 * reachable yet.
 */
const claimTools: readonly AgentTool[] = [
  mutate({
    name: "claim_request",
    summary:
      "Request a write claim on a path. Answers with granted, waitlisted (with position), or an approval raised against the holder.",
    gesture: "the operator granting write access to a path",
    method: "POST",
    endpoint: "/api/workstreams/:id/claims",
    availability: "pending",
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
    availability: "pending",
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
    availability: "pending",
  },
  mutate({
    name: "claim_policy_declare",
    summary:
      "Declare a pre-granted policy inside a claim you hold — allow or deny a subtree, so approval is the exception (§3.4).",
    gesture: "the operator pre-granting a subtree",
    method: "POST",
    endpoint: "/api/claims/:id/policies",
    availability: "pending",
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
    requires: { reflexivity: "capability" },
  }),
  mutate({
    name: "claim_policy_withdraw",
    summary: "Withdraw a claim policy.",
    gesture: "remove a pre-grant",
    method: "DELETE",
    endpoint: "/api/claim-policies/:id",
    availability: "pending",
    input: { id: id("the policy id") },
    requires: { reflexivity: "capability" },
  }),
  mutate({
    name: "claim_answer",
    summary: "Answer a claim approval you are the grantor of: grant or deny.",
    gesture: "answering a claim approval from the queue (§7.1)",
    method: "POST",
    endpoint: "/api/claim-waits/:id/answer",
    availability: "pending",
    input: {
      id: id("the claim wait id"),
      decision: { type: "string", required: true, description: "grant | deny" },
    },
    requires: { reflexivity: "capability" },
  }),
  mutate({
    name: "claim_grant",
    summary: "Grant a claim directly. The operator's alone (§3.4).",
    gesture: "grant a path to a session",
    method: "POST",
    endpoint: "/api/workstreams/:id/claim-grants",
    availability: "pending",
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
    availability: "pending",
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
    name: "session_dispatch",
    summary:
      "Dispatch a child session with provenance recorded and its spend attributed up the initiating chain (§3.6).",
    gesture: "run a command",
    method: "POST",
    endpoint: "/api/sessions",
    availability: "pending",
    input: {
      commandId: {
        type: "string",
        required: true,
        description: "command node to run",
      },
      reason: {
        type: "string",
        required: false,
        description: "why, recorded with the provenance",
      },
    },
    // Delegation is not reflexive: "a delegation's result returning to the
    // delegator is not this — the delegator authored that intent when it
    // delegated" (principle 1). A *new* child has no existing chain to reach.
    requires: { reflexivity: "none", approval: "outside-policy" },
  }),
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

/** The path parameters an endpoint pattern declares, in order. */
export function pathParametersOf(endpoint: string): readonly string[] {
  return endpoint
    .split("/")
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => segment.slice(1));
}
