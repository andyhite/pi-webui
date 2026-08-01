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
  type CanvasContainerInput,
  type CanvasEdgeInput,
  type CanvasNodeInput,
  type ContextEdgeFact,
  type ContextInputRow,
  type GraphSnapshot,
  type OpenQuestion,
  type PaletteEntry,
  type PaletteTicketEntry,
  type ScriptedTurnDelivery,
  type WarningFacts,
  type WarningGraphNode,
  type WorkspaceDiff,
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
