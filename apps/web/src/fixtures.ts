/**
 * Local fixture graph for Phase 3 canvas work. The server does not exist
 * yet (Phase 2); these stand in for real objects, commands, and sessions so
 * the mechanics — push, placement, selection, mid-drag refusal — can be
 * exercised. Labels state each node's role so refusals are explainable by
 * eye: content wires into commands and running sessions, nothing else.
 */

import type { CanvasEdgeInput, CanvasNodeInput } from "@plotroom/ui";

export const FIXTURE_NODES: readonly CanvasNodeInput[] = [
  {
    id: "ticket-oxy-2982",
    label: "ticket OXY-2982 (content)",
    role: "content",
    defaultPosition: { x: 0, y: 0 },
  },
  {
    id: "doc-architecture",
    label: "document architecture.md (content)",
    role: "content",
    defaultPosition: { x: 0, y: 120 },
  },
  {
    id: "note-steering",
    label: "note: steering note (content)",
    role: "content",
    defaultPosition: { x: 0, y: 240 },
  },
  {
    id: "command-implement",
    label: "command: implement the ticket",
    role: "command",
    defaultPosition: { x: 360, y: 60 },
  },
  {
    id: "session-running",
    label: "session #1 (running)",
    role: "session",
    running: true,
    defaultPosition: { x: 720, y: 60 },
  },
  {
    id: "session-ended",
    label: "session #2 (ended)",
    role: "session",
    running: false,
    defaultPosition: { x: 720, y: 220 },
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
