/**
 * Local fixture graph for Phase 3 canvas work. The server does not exist
 * yet (Phase 2); these stand in for real objects, commands, and sessions so
 * the mechanics — push, placement, selection, mid-drag refusal, zoom
 * levels, collapsing containers, notes, and one-gesture flows — can be
 * exercised. Labels state each node's role so refusals are explainable by
 * eye: content wires into commands and running sessions, nothing else.
 */

import type {
  CanvasContainerInput,
  CanvasEdgeInput,
  CanvasNodeInput,
  ContextInputRow,
  PaletteEntry,
  PaletteTicketEntry,
  WarningGraphNode,
} from "@plotroom/ui";

export const FIXTURE_CONTAINERS: readonly CanvasContainerInput[] = [
  {
    id: "workstream-oxy-2982",
    label: "workstream: OXY-2982",
    defaultPosition: { x: 0, y: 0 },
  },
];

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
  {
    id: "session-running",
    label: "session #1 (running)",
    role: "session",
    running: true,
    containerId: "workstream-oxy-2982",
    defaultPosition: { x: 40, y: 160 },
  },
  {
    id: "session-ended",
    label: "session #2 (ended)",
    role: "session",
    running: false,
    defaultPosition: { x: 720, y: 220 },
  },
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
