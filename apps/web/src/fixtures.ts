/**
 * Local fixture graph for Phase 3 canvas work. The server does not exist
 * yet (Phase 2); these stand in for real objects, commands, and sessions so
 * the mechanics — push, placement, selection, mid-drag refusal, zoom
 * levels, collapsing containers, notes, and one-gesture flows — can be
 * exercised. Labels state each node's role so refusals are explainable by
 * eye: content wires into commands and running sessions, nothing else.
 */

import {
  EMPTY_INJECTIONS,
  humanAuthor,
  INHERIT_APP_TOOLS,
  markDelivered,
  phaseFacts,
  queueInjection,
  startSession,
  type InjectionLedger,
  type NodeId,
  type Session,
  type SessionPhase,
  type SessionStatus,
  type Transcript,
} from "@plotroom/core";
import {
  sessionCanvasNode,
  type AttentionItem,
  type CanvasContainerInput,
  type CanvasEdgeInput,
  type CanvasNodeInput,
  type ContextEdgeFact,
  type ContextInputRow,
  type FleetSummary,
  type GraphSnapshot,
  type OpenQuestion,
  type PaletteEntry,
  type PaletteTicketEntry,
  type ScriptedTurnDelivery,
  type WarningFacts,
  type LogsResult,
  type PluginHealthEntry,
  type SearchResult,
  type SettingRow,
  type WarningGraphNode,
  type WorkspaceDiff,
  type WorkstreamActivityEntry,
} from "@plotroom/ui";

export const FIXTURE_CONTAINERS: readonly CanvasContainerInput[] = [
  {
    id: "workstream-oxy-2982",
    label: "workstream: OXY-2982",
    defaultPosition: { x: 0, y: 0 },
  },
];

/**
 * Two fixture sessions, built from `@plotroom/core`'s real `Session` type
 * (Phase 3 polish: sessions render as a canvas node kind from core session
 * types, not a hand-typed label). `FIXTURE_SESSIONS` is also what
 * `createFixtureSessionDataSource` (App.tsx's data source) loads as its
 * session list.
 */
export const FIXTURE_SESSION_RUNNING: Session = startSession(
  {
    id: "session-running" as Session["id"],
    workstreamId: "workstream-oxy-2982" as Session["workstreamId"],
    commandId: null,
    mode: "open",
    launch: {
      model: "anthropic/claude-sonnet-4",
      effort: "medium",
      toolPermissions: INHERIT_APP_TOOLS,
    },
    initiatedBy: humanAuthor,
    runtime: { adapterId: "pi-coding-agent", ref: "pi-session-1" },
  },
  1_700_000_000,
);

export const FIXTURE_SESSION_ENDED: Session = {
  ...startSession(
    {
      id: "session-ended" as Session["id"],
      workstreamId: "workstream-oxy-2982" as Session["workstreamId"],
      commandId: null,
      mode: "open",
      launch: {
        model: "anthropic/claude-sonnet-4",
        effort: "medium",
        toolPermissions: INHERIT_APP_TOOLS,
      },
      initiatedBy: humanAuthor,
      runtime: { adapterId: "pi-coding-agent", ref: "pi-session-2" },
    },
    1_699_000_000,
  ),
  end: { kind: "ended-by-user", at: 1_699_050_000 },
};

export const FIXTURE_SESSIONS: readonly Session[] = [
  FIXTURE_SESSION_RUNNING,
  FIXTURE_SESSION_ENDED,
];

/**
 * Fixture phases (Phase 3 has no adapter/observation stream yet to derive
 * these for real, Epic 4.1 territory) reused for both the session's canvas
 * label and its Conversation panel status header, so the two surfaces never
 * disagree about the same fixture session.
 */
export const FIXTURE_SESSION_RUNNING_PHASE: SessionPhase = { kind: "thinking" };
export const FIXTURE_SESSION_ENDED_PHASE: SessionPhase = { kind: "idle" };

/**
 * `deriveSessionStatus` (`@plotroom/core`) needs an observation log this
 * fixture layer doesn't have; `phaseFacts` is the pure, honest part of that
 * derivation available without one, so the status header reads real core
 * facts (busy/wants-attention) off a fixture phase rather than fabricating
 * a whole `SessionObservationState`.
 */
export const FIXTURE_SESSION_STATUSES: ReadonlyMap<
  Session["id"],
  SessionStatus
> = new Map([
  [
    FIXTURE_SESSION_RUNNING.id,
    {
      phase: FIXTURE_SESSION_RUNNING_PHASE,
      facts: phaseFacts(FIXTURE_SESSION_RUNNING_PHASE),
      health: { silentForMs: 0, possiblyStalled: false },
    },
  ],
  [
    FIXTURE_SESSION_ENDED.id,
    {
      phase: FIXTURE_SESSION_ENDED_PHASE,
      facts: phaseFacts(FIXTURE_SESSION_ENDED_PHASE),
      health: { silentForMs: 0, possiblyStalled: false },
    },
  ],
]);

export const FIXTURE_NODES: readonly CanvasNodeInput[] = [
  {
    id: "ticket-oxy-2982",
    label: "ticket OXY-2982 (content)",
    role: "content",
    containerId: "workstream-oxy-2982",
    defaultPosition: { x: 40, y: 60 },
  },
  {
    id: "doc-architecture",
    label: "document architecture.md (content)",
    role: "content",
    defaultPosition: { x: 0, y: 360 },
  },
  {
    id: "note-steering",
    label: "note: steering note (content)",
    role: "content",
    defaultPosition: { x: 0, y: 480 },
  },
  {
    id: "command-implement",
    label: "command: implement the ticket",
    role: "command",
    containerId: "workstream-oxy-2982",
    defaultPosition: { x: 260, y: 60 },
  },
  sessionCanvasNode({
    session: FIXTURE_SESSION_RUNNING,
    phase: FIXTURE_SESSION_RUNNING_PHASE,
    label: "session #1",
    containerId: "workstream-oxy-2982",
    defaultPosition: { x: 40, y: 160 },
  }),
  sessionCanvasNode({
    session: FIXTURE_SESSION_ENDED,
    phase: FIXTURE_SESSION_ENDED_PHASE,
    label: "session #2",
    defaultPosition: { x: 720, y: 220 },
  }),
  {
    id: "ticket-bare",
    label: "ticket OXY-3100 (bare, content)",
    role: "content",
    acceptsDefinitionDrop: true,
    defaultPosition: { x: 1000, y: 600 },
  },
  {
    id: "ticket-off-screen",
    label: "ticket far away (content)",
    role: "content",
    defaultPosition: { x: 4000, y: 4000 },
  },

  // Graph warnings demo fixtures (spec §5): each pair below exercises one
  // of the four named checks in isolation. `FIXTURE_WARNING_FACTS` below
  // carries the `producedOutput`/`published` facts these nodes don't
  // otherwise have a home for on `CanvasNodeInput`.
  {
    id: "command-no-context",
    label: "command: no context wired in",
    role: "command",
    defaultPosition: { x: 260, y: 760 },
  },
  {
    id: "output-no-context-placeholder",
    label: "output: command-no-context's declared placeholder",
    role: "content",
    defaultPosition: { x: 500, y: 760 },
  },
  {
    id: "output-not-yet-produced",
    label: "output: not yet produced by its command",
    role: "content",
    defaultPosition: { x: 260, y: 880 },
  },
  {
    id: "command-waiting-on-upstream",
    label: "command: blocked on an unproduced upstream output",
    role: "command",
    defaultPosition: { x: 500, y: 880 },
  },
  {
    id: "output-nobody-consumes",
    label: "output: published, nothing wired to it",
    role: "content",
    defaultPosition: { x: 260, y: 1000 },
  },
];

export const FIXTURE_EDGES: readonly CanvasEdgeInput[] = [
  {
    id: "edge-ticket-command",
    source: "ticket-oxy-2982",
    target: "command-implement",
  },
  {
    id: "edge-doc-command",
    source: "doc-architecture",
    target: "command-implement",
  },

  // Graph warnings demo edges (spec §5), one per check:
  // `command-no-context` has an edge *out* (its declared output) but none
  // in, so it is flagged `no_context` rather than `unreachable`.
  {
    id: "edge-no-context-output",
    source: "command-no-context",
    target: "output-no-context-placeholder",
  },
  // `output-not-yet-produced` is wired into `command-waiting-on-upstream`,
  // but `FIXTURE_WARNING_FACTS` marks it as not yet produced — flags the
  // command `blocked_chain`.
  {
    id: "edge-blocked-chain",
    source: "output-not-yet-produced",
    target: "command-waiting-on-upstream",
  },
  // `output-nobody-consumes` is published (per `FIXTURE_WARNING_FACTS`) and
  // has an edge in from the command that produced it, but nothing wired out
  // — flags `unconsumed_output`.
  {
    id: "edge-unconsumed-output",
    source: "command-implement",
    target: "output-nobody-consumes",
  },
];

/**
 * Facts `deriveGraphWarnings` needs that `CanvasNodeInput` has no field for
 * (§3.5's output pre-wiring state) — keyed by node id, sparse: most nodes
 * carry neither fact.
 */
export const FIXTURE_WARNING_FACTS: Readonly<
  Record<
    string,
    { readonly producedOutput?: boolean; readonly published?: boolean }
  >
> = {
  "output-not-yet-produced": { producedOutput: false },
  "output-nobody-consumes": { published: true },
};

/** Builds `deriveGraphWarnings`'s node input from the canvas nodes currently placed. */
export function toWarningGraphNodes(
  nodes: readonly CanvasNodeInput[],
): readonly WarningGraphNode[] {
  return nodes.map((node) => ({
    id: node.id,
    role: node.role,
    ...FIXTURE_WARNING_FACTS[node.id],
  }));
}

/** The same facts, as the `GraphSnapshot.warningFacts` map the live source builds. */
export const FIXTURE_WARNING_FACTS_MAP: ReadonlyMap<string, WarningFacts> =
  new Map(Object.entries(FIXTURE_WARNING_FACTS));

/** Ordered context inputs into `command-implement` (spec §3.5). */
export const FIXTURE_CONTEXT_INPUTS: readonly ContextInputRow[] = [
  { id: "edge-ticket-command", ordinal: 0, label: "ticket OXY-2982" },
  { id: "edge-doc-command", ordinal: 1, label: "document architecture.md" },
];

/** A collection fixture (spec §3.1): an epic's children, ready to expand and prune. */
export const FIXTURE_COLLECTION = {
  id: "collection-epic-oxy",
  label: "collection: OXY epic children",
  memberIds: ["ticket-oxy-3101", "ticket-oxy-3102", "ticket-oxy-3103"],
} as const;

/**
 * The palette (spec §5): everything not yet on the canvas, as drag sources.
 * Ticket rows are ordered unblocked-first by `PaletteRail` itself; the
 * fixture data just needs at least one blocked and one unblocked ticket to
 * make that visible.
 */
export const FIXTURE_PALETTE_TICKETS: readonly PaletteTicketEntry[] = [
  {
    id: "ticket-oxy-3103",
    kind: "ticket",
    label: "ticket OXY-3103 (blocked)",
    blockedBy: ["ticket-oxy-3102"],
  },
  {
    id: "ticket-oxy-3104",
    kind: "ticket",
    label: "ticket OXY-3104 (unblocked)",
    blockedBy: [],
  },
  {
    id: "ticket-oxy-3105",
    kind: "ticket",
    label: "ticket OXY-3105 (unblocked)",
    blockedBy: [],
  },
];

export const FIXTURE_PALETTE_OTHER: readonly PaletteEntry[] = [
  {
    id: "pr-482",
    kind: "pull_request",
    label: "PR #482: fix drift flag",
  },
  { id: "review-482", kind: "review", label: "review on PR #482" },
  { id: "doc-runbook", kind: "document", label: "document runbook.md" },
  { id: "session-42", kind: "session", label: "past session #42 (ended)" },
  {
    id: "command-def-review",
    kind: "command_definition",
    label: "command definition: review",
  },
];

export const FIXTURE_PALETTE_ENTRIES: readonly PaletteEntry[] = [
  ...FIXTURE_PALETTE_TICKETS,
  ...FIXTURE_PALETTE_OTHER,
];

/** The same two context edges as `FIXTURE_CONTEXT_INPUTS`, in `GraphSnapshot` shape. */
export const FIXTURE_CONTEXT_EDGES: readonly ContextEdgeFact[] = [
  {
    id: "edge-ticket-command",
    from: "ticket-oxy-2982",
    to: "command-implement",
    ordinal: 0,
  },
  {
    id: "edge-doc-command",
    from: "doc-architecture",
    to: "command-implement",
    ordinal: 1,
  },
];

/** Stage 1/tests/dev-offline: the full fixture graph in live `GraphSnapshot` shape. */
export const FIXTURE_SNAPSHOT: GraphSnapshot = {
  nodes: FIXTURE_NODES,
  edges: FIXTURE_EDGES,
  containers: FIXTURE_CONTAINERS,
  warningFacts: FIXTURE_WARNING_FACTS_MAP,
  paletteEntries: FIXTURE_PALETTE_ENTRIES,
  contextEdges: FIXTURE_CONTEXT_EDGES,
};

/**
 * The Conversation panel's fixture transcript (spec §6.1): a reasoning
 * entry distinct from output, a completed tool call, and one tool result
 * already released (with its marker) to exercise the load-back affordance
 * without waiting on the scripted playback below.
 */
export const FIXTURE_TRANSCRIPT: Transcript = {
  sessionId: FIXTURE_SESSION_RUNNING.id,
  turns: [
    {
      ordinal: 1,
      startedAt: 1_700_000_010,
      entries: [
        { kind: "reasoning", text: "the ticket asks for a new endpoint" },
        { kind: "output", text: "I'll start by reading the existing routes." },
        {
          kind: "tool-call",
          callId: "call-1",
          toolName: "read",
          input: "apps/server/src/routes/index.ts",
        },
        {
          kind: "tool-result",
          callId: "call-1",
          toolName: "read",
          output: "",
          isError: false,
          released: {
            releasedAt: 1_700_000_500,
            bytes: 8_192,
            contentHash: "fixture-hash-call-1",
          },
        },
      ],
    },
  ],
};

/** What `session-running`'s scripted playback delivers, in order (dev/tests). */
export const FIXTURE_TRANSCRIPT_SCRIPT: readonly ScriptedTurnDelivery[] = [
  {
    sessionId: FIXTURE_SESSION_RUNNING.id,
    turn: {
      ordinal: 2,
      startedAt: 1_700_000_600,
      entries: [
        { kind: "output", text: "routes look consistent; opening a PR next." },
      ],
    },
    delayMs: 2_000,
  },
];

/** Released content this fixture source can "reload" (§6.1's load-back). */
export const FIXTURE_RELEASED_CONTENT: ReadonlyMap<string, string> = new Map([
  [
    `${FIXTURE_SESSION_RUNNING.id}:call-1`,
    "export function registerRoutes(app: Hono) { /* ...full route table... */ }",
  ],
]);

/**
 * The Diff panel's fixture data (spec §11): a minimal `WorkspaceDiff
 * — read-only file tree + patches, fed until a real workspace/diff server
 * API exists.
 */
/**
 * Structured questions as bubbles (spec §6.4): no stream carries an open
 * question yet (`bubbles/question-source.ts`'s doc comment states the exact
 * gap), so this is the fixture a `QuestionDataSource` answers today —
 * rendered as a bubble on `session-running`'s node.
 */
export const FIXTURE_OPEN_QUESTIONS: readonly OpenQuestion[] = [
  {
    id: "question-1",
    nodeId: FIXTURE_SESSION_RUNNING.id,
    text: "the ticket is ambiguous about auth scope — include refresh tokens?",
    options: ["yes, include refresh tokens", "no, access tokens only"],
    raisedAt: 1_700_000_200,
    answeredValue: null,
  },
];

/**
 * An injection ledger fixture (spec §6.5): one entry still queued, one
 * already delivered, so the bubble layer's distinct queued/delivered
 * rendering has something real to show. No injection endpoint exists yet
 * (Track A/C, Batch 3), so this is the only source until then.
 */
export const FIXTURE_INJECTIONS: InjectionLedger = (() => {
  let ledger = EMPTY_INJECTIONS;
  // The session's own node id and its session id are the same string
  // (`sessionCanvasNode` sets both to `session.id`), but the two are
  // distinctly branded (`NodeId` vs `SessionId`) — this cast states that
  // fixture fact rather than widening either brand.
  const sessionNodeId = FIXTURE_SESSION_RUNNING.id as unknown as NodeId;
  ledger = queueInjection(ledger, {
    id: "injection-queued",
    sessionId: FIXTURE_SESSION_RUNNING.id,
    author: humanAuthor,
    nodeId: sessionNodeId,
    text: "stop grepping, the answer is in docs/architecture.md",
    queuedAt: 1_700_000_300,
  });
  ledger = queueInjection(ledger, {
    id: "injection-delivered",
    sessionId: FIXTURE_SESSION_RUNNING.id,
    author: humanAuthor,
    nodeId: sessionNodeId,
    text: "use the existing route table, don't rewrite it",
    queuedAt: 1_700_000_100,
  });
  ledger = markDelivered(ledger, "injection-delivered", 1_700_000_150);
  return ledger;
})();

export const FIXTURE_WORKSPACE_DIFF: WorkspaceDiff = {
  workspaceId: "workspace-oxy-2982",
  state: "ready",
  reason: null,
  base: {
    ref: "main",
    resolved: "deadbeef",
    description:
      "everything this workspace changed since it branched from main",
  },
  files: [
    {
      path: "apps/server/src/routes/tickets.ts",
      status: "added",
      hunks: [
        {
          header: "@@ -0,0 +1,3 @@",
          lines: [
            "+export function registerTicketRoutes() {}",
            "+",
            "+// TODO: wire into app.ts",
          ],
        },
      ],
    },
    {
      path: "apps/server/src/app.ts",
      status: "modified",
      patchText:
        "@@ -10,6 +10,7 @@\n import { registerRoutes } from './routes/index.js';\n+import { registerTicketRoutes } from './routes/tickets.js';\n",
    },
    {
      path: "apps/server/src/routes/legacy-tickets.ts",
      status: "deleted",
    },
  ],
};

/**
 * The attention queue's fixture feed (Epic 6.1, §7): kept in *this*
 * app's own node ids (`FIXTURE_NODES` above) rather than reusing
 * `@plotroom/ui`'s generic `createFixtureAttentionDataSource` default
 * scenarios, so selecting a row actually navigates to a node this fixture
 * graph has — a demo that pointed at ids nothing on screen has would make
 * "selecting a row moves the canvas to it" untestable by eye.
 */
export const FIXTURE_ATTENTION_ITEMS: readonly AttentionItem[] = [
  {
    id: "attn-approval-1",
    feed: "approval",
    target: {
      nodeId: "session-running",
      workstreamId: "workstream-oxy-2982",
      sessionId: "session-running",
    },
    rank: 0,
    summary: "session #1 wants to force-push origin/main (irreversible)",
    payload: {
      kind: "approval",
      approvalId: "approval-1",
      capability: "git:force-push",
    },
    raisedAt: 1_700_000_100,
    snoozeUntil: null,
  },
  {
    id: "attn-question-1",
    feed: "question",
    target: {
      nodeId: "session-running",
      workstreamId: "workstream-oxy-2982",
      sessionId: "session-running",
    },
    rank: 1,
    summary: "session #1: keep going with the migration?",
    payload: {
      kind: "question",
      questionId: "q1",
      text: "keep going with the migration?",
      options: [
        { id: "opt-yes", label: "yes" },
        { id: "opt-no", label: "no" },
        { id: "opt-later", label: "ask again later" },
      ],
    },
    raisedAt: 1_700_000_050,
    snoozeUntil: null,
  },
  {
    id: "attn-drift-1",
    feed: "drift",
    target: {
      nodeId: "command-implement",
      workstreamId: "workstream-oxy-2982",
    },
    rank: 2,
    summary: "ticket OXY-2982 changed since command-implement's last run",
    payload: {
      kind: "drift",
      objectId: "ticket-oxy-2982",
      changedSummary: "ticket status moved from In Progress to In Review",
    },
    raisedAt: 1_700_000_000,
    snoozeUntil: null,
  },
  {
    id: "attn-health-1",
    feed: "health",
    target: {
      nodeId: "session-running",
      workstreamId: "workstream-oxy-2982",
      sessionId: "session-running",
    },
    rank: 3,
    summary: "session #1 has been silent for 12 minutes",
    payload: { kind: "health", alert: "idle" },
    raisedAt: 1_699_999_800,
    snoozeUntil: null,
  },
  {
    id: "attn-completion-1",
    feed: "completion",
    target: {
      nodeId: "session-ended",
      workstreamId: "workstream-oxy-2982",
      sessionId: "session-ended",
    },
    rank: 4,
    summary: "session #2 finished: updated the contributing guide",
    payload: { kind: "completion", sessionId: "session-ended" },
    raisedAt: 1_699_050_000,
    snoozeUntil: null,
  },
  {
    id: "attn-broadcast-1",
    feed: "broadcast",
    target: {
      nodeId: "session-running",
      workstreamId: "workstream-oxy-2982",
      sessionId: "session-running",
    },
    rank: 5,
    summary:
      "session #1 broadcast to 2 sessions: material state changed under you",
    payload: {
      kind: "broadcast",
      broadcastId: "broadcast-1",
      category: "material-state-changed",
      recipientCount: 2,
    },
    raisedAt: 1_699_000_000,
    snoozeUntil: null,
  },
];

/**
 * §7.3's "what changed while I was away": a short, capped per-workstream
 * event history, entry ids stable so `appendActivityEntry`'s cap has
 * something real to trim in a live feed — this fixture is small enough
 * that trimming never actually happens, which is the honest state of a
 * fresh board.
 */
export const FIXTURE_WHAT_CHANGED: readonly WorkstreamActivityEntry[] = [
  {
    id: "activity-1",
    workstreamId: "workstream-oxy-2982",
    kind: "completion",
    text: "session #2 finished",
    at: 1_699_050_000,
    targetNodeId: "session-ended",
  },
  {
    id: "activity-2",
    workstreamId: "workstream-oxy-2982",
    kind: "ticket-updated",
    text: "ticket OXY-2982 moved to In Review",
    at: 1_700_000_000,
    targetNodeId: "ticket-oxy-2982",
  },
  {
    id: "activity-3",
    workstreamId: "workstream-oxy-2982",
    kind: "failure",
    text: "a delegated session failed overnight",
    at: 1_700_000_200,
    // Deliberately a node this fixture graph does not have — exercises the
    // honest tombstone (§7.3's "tolerates that target being gone").
    targetNodeId: "session-deleted-overnight",
  },
];

/**
 * The Fleet panel's fixture (§8, §11) for offline/dev mode; `LIVE` mode
 * aggregates the real thing (`createApiFleetDataSource`, see `App.tsx`).
 */
export const FIXTURE_FLEET_SUMMARY: FleetSummary = {
  todayTotalMicros: 4_250_000,
  biggestSpender: {
    sessionId: "session-running",
    workstreamId: "workstream-oxy-2982",
    amountMicros: 3_100_000,
  },
  runningCount: 1,
  concurrencyLimit: 4,
  queuedCount: 0,
};

/**
 * The plugin health panel's fixture (§10.2, §11): fixture-fed regardless of
 * `LIVE` — `apps/server` publishes no lifecycle event stream yet (§8's
 * server wiring over `@plotroom/plugin-sdk`'s `PluginRegistry` is Track A's),
 * so there is nothing real to load either way. Four rows, one per in-box
 * plugin (§9.4), each a different lifecycle/integration combination so
 * every §10.2 state this panel renders is exercised: `ready`+`connected`,
 * `unavailable`+`failing`, `disabled`, and `ready` with no integration
 * substrate wired server-side (Filesystem — honest, since Epic 7.2's
 * substrate is not wired to a worker-hosted plugin yet).
 */
export const FIXTURE_PLUGIN_HEALTH: readonly PluginHealthEntry[] = [
  {
    pluginId: "github",
    name: "GitHub",
    lifecycle: { status: "ready", reason: null },
    integration: { state: "connected", detail: "authenticated as octocat" },
  },
  {
    pluginId: "jira",
    name: "Jira",
    lifecycle: { status: "unavailable", reason: "plugin threw on load" },
    integration: { state: "failing", detail: "401 from the last sync attempt" },
  },
  {
    pluginId: "git",
    name: "Coding/git",
    lifecycle: { status: "disabled", reason: "disabled by the operator" },
    integration: null,
  },
  {
    pluginId: "filesystem",
    name: "Filesystem",
    lifecycle: { status: "ready", reason: null },
    integration: null,
  },
];

/**
 * The Search panel's fixture (§6.8, §11) for offline/dev mode: a query and
 * its ranked hits, one of them archived — reported as archived rather than
 * hidden, exactly as §6.8 requires. `LIVE` mode queries the real thing
 * (`createApiSearchDataSource`, over `GET /api/search`).
 */
export const FIXTURE_SEARCH_RESULTS: ReadonlyMap<string, SearchResult> =
  new Map([
    [
      "migrate",
      {
        query: "migrate",
        hits: [
          {
            kind: "session",
            refKind: "session",
            refId: "session-running",
            title: "session session-running",
            location: "workstream-oxy-2982",
            snippet: "...still migrating the schema...",
            rank: 0.92,
            archived: false,
          },
          {
            kind: "session",
            refKind: "session",
            refId: "session-ended",
            title: "session session-ended",
            location: "workstream-oxy-2982",
            snippet: "...the migration finished cleanly...",
            rank: 0.41,
            archived: true,
          },
        ],
      },
    ],
  ]);

/**
 * The Settings panel's fixture (§11, §8) for offline/dev mode: a handful of
 * catalog rows spanning every rendered shape — a live-applying number, a
 * restart-required string, and a sensitive credential with no value set.
 * `LIVE` mode reads the real catalog (`createApiSettingsDataSource`, over
 * `GET`/`PUT`/`DELETE /api/settings(/:key)`).
 */
export const FIXTURE_SETTINGS: readonly SettingRow[] = [
  {
    key: "concurrencyLimit",
    group: "Runs",
    label: "Concurrency limit",
    description: "How many sessions may run at once (§4.1).",
    type: "number",
    envVar: "PLOTROOM_CONCURRENCY_LIMIT",
    sensitive: false,
    appliesWithoutRestart: true,
    value: 4,
    defaultValue: 4,
    overridden: false,
  },
  {
    key: "host",
    group: "Network",
    label: "Bind address",
    description: "The network address the server listens on.",
    type: "string",
    envVar: "PLOTROOM_HOST",
    sensitive: false,
    appliesWithoutRestart: false,
    restartReason:
      "the server is already bound to an address; changing this takes effect on the next start",
    value: "127.0.0.1",
    defaultValue: "127.0.0.1",
    overridden: false,
  },
  {
    key: "credential",
    group: "Security",
    label: "Operator credential",
    description:
      "The shared secret required for non-local access (§12); optional while bound to loopback.",
    type: "string",
    envVar: "PLOTROOM_CREDENTIAL",
    sensitive: true,
    appliesWithoutRestart: true,
    value: null,
    defaultValue: null,
    overridden: false,
  },
];

/**
 * The Logs panel's fixture (§8, §11) for offline/dev mode: a couple of lines
 * and an honest zero drop count. `LIVE` mode reads the real ring buffer
 * (`createApiLogsDataSource`, over `GET /api/logs`).
 */
export const FIXTURE_LOGS: LogsResult = {
  entries: [
    {
      seq: 1,
      time: "2024-01-01T00:00:00.000Z",
      level: "info",
      msg: "server started",
      component: "http",
    },
    {
      seq: 2,
      time: "2024-01-01T00:00:01.000Z",
      level: "warn",
      msg: "slow compaction sweep",
      component: "maintenance",
    },
  ],
  droppedTotal: 0,
  capacity: 5_000,
  oldestSeq: 1,
  newestSeq: 2,
};
