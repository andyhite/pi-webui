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
  Run,
  Session,
  SessionPhase,
  Workstream,
} from "@plotroom/core";

/** A session as the board knows it: the record plus the phase PlotRoom derived. */
export interface BoardSession {
  readonly session: Session;
  readonly phase: SessionPhase;
}

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
  /**
   * Sessions travel with the phase PlotRoom derived, the same shape the
   * `session` DomainEvent's `status.phase` carries (Stage 2, Track A's run
   * spine). Runs are absent here too, same as the server's own snapshot
   * (history is unbounded and read per command) — this board only ever
   * knows about a run once a `run` event names it.
   */
  readonly sessions: readonly {
    readonly session: Session;
    readonly runId: string | null;
    readonly phase: SessionPhase;
  }[];
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
  /** Keyed by session id — the session record plus its derived phase (§3.6). */
  readonly sessions: ReadonlyMap<string, BoardSession>;
  /** Keyed by run id (§4.1); used to show a command node's latest run status. */
  readonly runs: ReadonlyMap<string, Run>;
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
    sessions: new Map(),
    runs: new Map(),
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
    sessions: new Map(
      raw.sessions.map((entry) => [
        entry.session.id,
        { session: entry.session, phase: entry.phase },
      ]),
    ),
    // The snapshot never carries runs (history is unbounded, read per
    // command); the board only learns of one from a live `run` event.
    runs: new Map(),
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
 * `session` carries the record plus PlotRoom's own derived phase (never
 * agent-reported, principle 7) — what a session-role node's label/running
 * state renders from (`build-snapshot.ts`). `run` is tracked the same way,
 * for a command node's latest-run status. `version`, `session_observation`,
 * and `session_transcript` still only advance `seq`: a session's transcript
 * is its own live seam (`sessions/data-source.ts`), not the board's.
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
    case "session":
      next.sessions = withChange(
        state.sessions,
        event.verb === "deleted" ? event.sessionId : event.session.id,
        event.verb === "deleted"
          ? undefined
          : { session: event.session, phase: event.status.phase },
      );
      return next;
    case "run":
      next.runs = withChange(
        state.runs,
        event.verb === "deleted" ? event.runId : event.run.id,
        event.verb === "deleted" ? undefined : event.run,
      );
      return next;
    // These advance `seq` and nothing else. A version, an observation, and a
    // transcript publication have their own live seams; claims, the run queue,
    // spend attribution, budgets, questions, broadcasts, approvals, and the
    // attention derivation have their own surfaces (§3.4's claims panel, §4.1's
    // queue, §8's fleet panel, §6.4's bubbles, §6.6's approvals, §7.1's queue),
    // and nothing about a node's label or running state is derived from any of
    // them. A pre-grant, an outbound route, an integration instance, and a
    // plugin's own lifecycle/health are configuration and are never on the board
    // at all (§6.6, §7.3, §9.1–§9.3, §10.2) — the plugin health panel reads that
    // event through its own seam.
    case "version":
    case "session_observation":
    case "session_transcript":
    case "claim":
    case "claim_wait":
    case "claim_policy":
    case "run_batch":
    case "run_queue_entry":
    case "session_spend":
    case "budget":
    case "session_question":
    case "broadcast":
    case "approval":
    case "pre_grant":
    case "attention":
    case "notification_route":
    case "integration":
    case "plugin":
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
