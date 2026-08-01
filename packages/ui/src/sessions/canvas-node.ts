/**
 * Sessions as a canvas node kind (Phase 3 polish): a session already places
 * as a `"session"`-role `PlacedNode` (`@plotroom/core/edges.ts`) — the
 * canvas and legality predicates already treat it as a first-class node
 * kind. What was still fixture-shaped ad hoc (`apps/web/src/fixtures.ts`
 * hand-writing a label and a `running` boolean) now derives from the real
 * core `Session`/`SessionPhase` types, so the card reflects what the
 * product actually knows about a session rather than a label a fixture
 * author typed. Fixture-fed until Stage 2 wires a live `SessionDataSource`.
 */

import type { CanvasNodeInput } from "../canvas/PlotCanvas.js";
import { isRunning, type Session, type SessionPhase } from "@plotroom/core";

function phaseLabel(phase: SessionPhase): string {
  switch (phase.kind) {
    case "tool-running":
      return `tool-running (${phase.toolName})`;
    default:
      return phase.kind;
  }
}

export interface SessionCanvasNodeInput {
  readonly session: Session;
  readonly phase: SessionPhase;
  /** A short display name (§3.6 has no session "title" field to read yet). */
  readonly label: string;
  readonly containerId?: string;
  readonly defaultPosition: CanvasNodeInput["defaultPosition"];
}

/** Builds a session's canvas node straight from core session types. */
export function sessionCanvasNode(
  input: SessionCanvasNodeInput,
): CanvasNodeInput {
  return {
    id: input.session.id,
    label: `${input.label} (${phaseLabel(input.phase)})`,
    role: "session",
    running: isRunning(input.session),
    refId: input.session.id,
    defaultPosition: input.defaultPosition,
    ...(input.containerId ? { containerId: input.containerId } : {}),
  };
}
