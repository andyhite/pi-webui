/**
 * The client's mirror of the server's board (Epic 2.1/2.2, spec principle
 * 8): one map per entity kind, keyed by id, matching exactly what
 * `GET /api/snapshot` returns and what every `/ws` `DomainEvent` describes a
 * change to. Pure and synchronous on purpose — `createApiGraphDataSource`
 * (the only caller that talks to a socket or does IO) is a thin shell around
 * `applyEvent`/`snapshotToState`, so the state-transition logic itself is
 * unit-testable without a server or a connection.
 */

import type {
  CommandDefinition,
  CommandNode,
  CommandOutput,
  DomainEvent,
  Edge,
  PlacedNode,
  PlotObject,
  Workstream,
} from "@plotroom/core";

/** The exact shape `GET /api/snapshot` returns (`apps/server/src/routes/snapshot.ts`). */
export interface RawSnapshot {
  readonly seq: number;
  readonly workstreams: readonly Workstream[];
  readonly nodes: readonly PlacedNode[];
  readonly edges: readonly Edge[];
  readonly objects: readonly PlotObject[];
  readonly commandDefinitions: readonly CommandDefinition[];
  readonly commands: readonly CommandNode[];
  readonly outputs: readonly CommandOutput[];
}

export interface BoardState {
  readonly seq: number;
  readonly workstreams: ReadonlyMap<string, Workstream>;
  readonly nodes: ReadonlyMap<string, PlacedNode>;
  readonly edges: ReadonlyMap<string, Edge>;
  readonly objects: ReadonlyMap<string, PlotObject>;
  readonly commandDefinitions: ReadonlyMap<string, CommandDefinition>;
  readonly commands: ReadonlyMap<string, CommandNode>;
  readonly outputs: ReadonlyMap<string, CommandOutput>;
}

export function emptyBoardState(): BoardState {
  return {
    seq: 0,
    workstreams: new Map(),
    nodes: new Map(),
    edges: new Map(),
    objects: new Map(),
    commandDefinitions: new Map(),
    commands: new Map(),
    outputs: new Map(),
  };
}

/** The initial state — one consistent read of everything (Epic 2.2's snapshot). */
export function stateFromSnapshot(raw: RawSnapshot): BoardState {
  return {
    seq: raw.seq,
    workstreams: new Map(raw.workstreams.map((row) => [row.id, row])),
    nodes: new Map(raw.nodes.map((row) => [row.id, row])),
    edges: new Map(raw.edges.map((row) => [row.id, row])),
    objects: new Map(raw.objects.map((row) => [row.id, row])),
    commandDefinitions: new Map(
      raw.commandDefinitions.map((row) => [row.id, row]),
    ),
    commands: new Map(raw.commands.map((row) => [row.id, row])),
    outputs: new Map(raw.outputs.map((row) => [row.id, row])),
  };
}

/**
 * Applies one `DomainEvent` (Epic 2.1's `@plotroom/core` vocabulary):
 * "created"/"updated" carry the full entity, so applying one is always an
 * overwrite, never a merge; "deleted" means off the board (soft or hard —
 * the event vocabulary does not distinguish, and neither does this), so it
 * drops the row from the map entirely. Both are idempotent: re-applying an
 * event already reflected in the state is a no-op overwrite or a delete of
 * something already gone — exactly what makes applying the buffered tail of
 * events after a snapshot fetch safe (the documented resync recipe).
 *
 * Unknown-to-the-canvas entities (`version`, `run`, `session`,
 * `session_observation`, `session_transcript`) advance `seq` and nothing else —
 * nothing here renders them yet.
 */
export function applyEvent(state: BoardState, event: DomainEvent): BoardState {
  const next = { ...state, seq: event.seq };

  switch (event.entity) {
    case "workstream":
      next.workstreams = withChange(
        state.workstreams,
        event.verb === "deleted" ? event.workstreamId : event.workstream.id,
        event.verb === "deleted" ? undefined : event.workstream,
      );
      return next;
    case "node":
      next.nodes = withChange(
        state.nodes,
        event.verb === "deleted" ? event.nodeId : event.node.id,
        event.verb === "deleted" ? undefined : event.node,
      );
      return next;
    case "edge":
      next.edges = withChange(
        state.edges,
        event.verb === "deleted" ? event.edgeId : event.edge.id,
        event.verb === "deleted" ? undefined : event.edge,
      );
      return next;
    case "object":
      next.objects = withChange(
        state.objects,
        event.verb === "deleted" ? event.objectId : event.object.id,
        event.verb === "deleted" ? undefined : event.object,
      );
      return next;
    case "command_definition":
      next.commandDefinitions = withChange(
        state.commandDefinitions,
        event.verb === "deleted" ? event.definitionId : event.definition.id,
        event.verb === "deleted" ? undefined : event.definition,
      );
      return next;
    case "command":
      next.commands = withChange(
        state.commands,
        event.verb === "deleted" ? event.commandId : event.command.id,
        event.verb === "deleted" ? undefined : event.command,
      );
      return next;
    case "command_output":
      next.outputs = withChange(
        state.outputs,
        event.verb === "deleted" ? event.outputId : event.output.id,
        event.verb === "deleted" ? undefined : event.output,
      );
      return next;
    case "version":
    case "run":
    case "session":
    case "session_observation":
    case "session_transcript":
      return next;
  }
}

function withChange<T>(
  map: ReadonlyMap<string, T>,
  id: string,
  value: T | undefined,
): ReadonlyMap<string, T> {
  const next = new Map(map);
  if (value === undefined) {
    next.delete(id);
  } else {
    next.set(id, value);
  }
  return next;
}
