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
];

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
