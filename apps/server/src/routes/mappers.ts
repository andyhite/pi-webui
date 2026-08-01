import type {
  CommandId,
  CommandDefinitionId,
  CommandNode,
  Edge,
  EdgeId,
  NodeId,
  ObjectId,
  ObjectKind,
  PlacedNode,
  PlotObject,
  ProvenanceKind,
  SessionId,
  VersionId,
  Workstream,
  WorkstreamId,
} from "@plotroom/core";
import type {
  CommandRow,
  EdgeRow,
  NodeRow,
  ObjectRow,
  WorkstreamRow,
} from "@plotroom/db";

/**
 * Rows into the domain shapes the event vocabulary and the API responses both
 * speak (principle 8: one vocabulary). A subscriber gets the same shape from
 * the WS stream that it would get from the REST read, so a live update and a
 * resync are interchangeable.
 */

export function toPlotObject(row: ObjectRow): PlotObject {
  return {
    id: row.id as ObjectId,
    kind: row.kind as ObjectKind,
    scope: row.scope,
    workstreamId: (row.workstreamId ?? null) as WorkstreamId | null,
    external:
      row.externalSystem && row.externalId
        ? { system: row.externalSystem, id: row.externalId }
        : null,
    title: row.title,
    latestVersionId: row.latestVersionId as VersionId,
    createdAt: row.createdAt,
    promotedAt: row.promotedAt,
  };
}

export function toPlacedNode(row: NodeRow): PlacedNode {
  return {
    id: row.id as NodeId,
    role: row.role,
    running: row.running,
    refId: row.refId,
    workstreamId: (row.workstreamId ?? null) as WorkstreamId | null,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

/**
 * §15 invariant 2 in the wire shape: a context edge's author is not optional
 * here either, so an edge row that somehow carried none would fail to map
 * rather than travel as an edge nobody authored.
 */
export function toEdge(row: EdgeRow): Edge {
  if (row.kind === "provenance") {
    return {
      id: row.id as EdgeId,
      kind: "provenance",
      from: row.fromNode as NodeId,
      to: row.toNode as NodeId,
      relation: row.relation as ProvenanceKind,
      createdAt: row.createdAt,
    };
  }

  if (row.authorKind === "system") {
    throw new Error(`context edge ${row.id} has no author (§15 invariant 2)`);
  }

  return {
    id: row.id as EdgeId,
    kind: "context",
    from: row.fromNode as NodeId,
    to: row.toNode as NodeId,
    author:
      row.authorKind === "session"
        ? { kind: "session", sessionId: row.authorSession as SessionId }
        : { kind: "human" },
    ordinal: row.ordinal ?? 0,
    createdAt: row.createdAt,
  };
}

export function toWorkstream(row: WorkstreamRow): Workstream {
  return {
    id: row.id as WorkstreamId,
    subjectId: (row.subjectObjectId ?? null) as ObjectId | null,
    status: row.status,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
  };
}

export function toCommandNode(row: CommandRow): CommandNode {
  return {
    id: row.id as CommandId,
    definitionId: row.definitionId as CommandDefinitionId,
    workstreamId: row.workstreamId as WorkstreamId,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}
