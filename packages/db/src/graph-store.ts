import { and, eq, isNull, sql } from "drizzle-orm";
import {
  checkAuthoring,
  checkConnection,
  newEdgeId,
  newNodeId,
  systemClock,
  wouldCycle,
  type Author,
  type Clock,
  type ConnectionRefusal,
  type GraphNode,
  type NodeId,
  type NodeRole,
  type ProvenanceKind,
  type SessionId,
} from "@plotroom/core";
import type { PlotroomDatabase } from "./client.js";
import {
  edges,
  nodes,
  sessionLineage,
  type EdgeRow,
  type NodeRow,
} from "./schema.js";

export class ConnectionRefused extends Error {
  constructor(
    readonly refusal: ConnectionRefusal | { reason: string; message: string },
  ) {
    super(refusal.message);
    this.name = "ConnectionRefused";
  }
}

export interface PlaceNodeInput {
  readonly role: NodeRole;
  /** The object, command, or session this node stands for. */
  readonly refId: string;
  readonly workstreamId?: string;
  readonly running?: boolean;
}

export interface ContextEdgeInput {
  readonly from: string;
  readonly to: string;
  readonly author: Author;
  /** Defaults to the end of the target's current input order. */
  readonly ordinal?: number;
}

/**
 * Nodes, edges, and lineage (spec §3.7).
 *
 * Every refusal here comes from a predicate in @plotroom/core, so the canvas,
 * the API, and agent tools cannot disagree about what is legal (principle 8).
 */
export class GraphStore {
  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {}

  place(input: PlaceNodeInput): NodeRow {
    const existing = this.state.db
      .select()
      .from(nodes)
      .where(and(eq(nodes.role, input.role), eq(nodes.refId, input.refId)))
      .get();

    // One gesture creates one thing (principle 9): placing the same subject
    // twice returns the same node rather than a second one.
    if (existing) return existing;

    const id = newNodeId();

    this.state.db
      .insert(nodes)
      .values({
        id,
        role: input.role,
        refId: input.refId,
        workstreamId: input.workstreamId ?? null,
        running: input.running ?? false,
        createdAt: this.now(),
      })
      .run();

    return this.node(id);
  }

  node(id: string): NodeRow {
    const row = this.state.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, id))
      .get();
    if (!row) throw new Error(`unknown node ${id}`);
    return row;
  }

  setRunning(nodeId: string, running: boolean): void {
    this.state.db
      .update(nodes)
      .set({ running })
      .where(eq(nodes.id, nodeId))
      .run();
  }

  /**
   * Author a context edge. Refused for anything not in §3.7's exhaustive list,
   * for command-topology cycles, and for a session authoring into its own
   * initiation chain (principle 1).
   */
  addContextEdge(input: ContextEdgeInput): EdgeRow {
    const from = this.toGraphNode(this.node(input.from));
    const to = this.toGraphNode(this.node(input.to));

    const legality = checkConnection(from, to);
    if (!legality.legal) throw new ConnectionRefused(legality.refusal);

    const authoring = checkAuthoring(
      this.lineageIndex(),
      input.author,
      this.sessionOf(to),
    );
    if (!authoring.allowed) throw new ConnectionRefused(authoring.refusal);

    if (this.existingContextEdge(input.from, input.to)) {
      throw new ConnectionRefused({
        reason: "duplicate",
        message: "that content is already wired into this target",
      });
    }

    if (to.role === "command" && this.introducesCycle(input.from, input.to)) {
      throw new ConnectionRefused({
        reason: "would_cycle",
        message: "a command's output cannot become its own input",
      });
    }

    const id = newEdgeId();

    this.state.db
      .insert(edges)
      .values({
        id,
        kind: "context",
        fromNode: input.from,
        toNode: input.to,
        authorKind: input.author.kind,
        authorSession:
          input.author.kind === "session" ? input.author.sessionId : null,
        ordinal: input.ordinal ?? this.nextOrdinal(input.to),
        relation: null,
        createdAt: this.now(),
      })
      .run();

    return this.edge(id);
  }

  /**
   * Provenance is recorded as work happens, never authored (§3.7). It carries
   * the reserved author "system" and no ordinal, and it is exempt from the
   * legality and lineage checks — a delegation's result returning to its
   * delegator is intent the delegator already authored.
   */
  recordProvenance(
    from: string,
    to: string,
    relation: ProvenanceKind,
  ): EdgeRow {
    const id = newEdgeId();

    this.state.db
      .insert(edges)
      .values({
        id,
        kind: "provenance",
        fromNode: from,
        toNode: to,
        authorKind: "system",
        authorSession: null,
        ordinal: null,
        relation,
        createdAt: this.now(),
      })
      .run();

    return this.edge(id);
  }

  /** Context inputs in assembly order (§3.5). */
  contextInputs(nodeId: string): EdgeRow[] {
    return this.state.db
      .select()
      .from(edges)
      .where(
        and(
          eq(edges.toNode, nodeId),
          eq(edges.kind, "context"),
          isNull(edges.deletedAt),
        ),
      )
      .orderBy(edges.ordinal)
      .all();
  }

  /** Rearrange inputs by drag: the given order becomes ordinals 1..n (§3.5). */
  reorderContextInputs(nodeId: string, edgeIds: readonly string[]): void {
    const current = this.contextInputs(nodeId).map((row) => row.id);
    const missing = current.filter((id) => !edgeIds.includes(id));

    if (missing.length > 0 || edgeIds.length !== current.length) {
      throw new Error("reorder must list every current input exactly once");
    }

    this.state.db.transaction((tx) => {
      // Two passes: the (to_node, ordinal) uniqueness holds at every step.
      edgeIds.forEach((edgeId, index) => {
        tx.update(edges)
          .set({ ordinal: -(index + 1) })
          .where(eq(edges.id, edgeId))
          .run();
      });
      edgeIds.forEach((edgeId, index) => {
        tx.update(edges)
          .set({ ordinal: index + 1 })
          .where(eq(edges.id, edgeId))
          .run();
      });
    });
  }

  /** Soft delete: authored state is recoverable, agent deletions too (§10). */
  removeEdge(edgeId: string): void {
    this.state.db
      .update(edges)
      .set({ deletedAt: this.now() })
      .where(eq(edges.id, edgeId))
      .run();
  }

  restoreEdge(edgeId: string): void {
    this.state.db
      .update(edges)
      .set({ deletedAt: null })
      .where(eq(edges.id, edgeId))
      .run();
  }

  edge(id: string): EdgeRow {
    const row = this.state.db
      .select()
      .from(edges)
      .where(eq(edges.id, id))
      .get();
    if (!row) throw new Error(`unknown edge ${id}`);
    return row;
  }

  provenance(nodeId: string): EdgeRow[] {
    return this.state.db
      .select()
      .from(edges)
      .where(and(eq(edges.toNode, nodeId), eq(edges.kind, "provenance")))
      .all();
  }

  /** Record that a session was started by another, or by a human (null). */
  recordLineage(sessionId: string, initiatedBy: string | null): void {
    this.state.db
      .insert(sessionLineage)
      .values({ sessionId, initiatedBy, createdAt: this.now() })
      .onConflictDoNothing()
      .run();
  }

  lineageIndex() {
    const parents = new Map<string, string | null>(
      this.state.db
        .select()
        .from(sessionLineage)
        .all()
        .map((row) => [row.sessionId, row.initiatedBy]),
    );

    return {
      parentOf: (session: SessionId): SessionId | null =>
        (parents.get(session) as SessionId | undefined) ?? null,
    };
  }

  private existingContextEdge(from: string, to: string): EdgeRow | undefined {
    return this.state.db
      .select()
      .from(edges)
      .where(
        and(
          eq(edges.fromNode, from),
          eq(edges.toNode, to),
          eq(edges.kind, "context"),
          isNull(edges.deletedAt),
        ),
      )
      .get();
  }

  private nextOrdinal(nodeId: string): number {
    const row = this.state.db
      .select({ max: sql<number | null>`MAX(${edges.ordinal})` })
      .from(edges)
      .where(
        and(
          eq(edges.toNode, nodeId),
          eq(edges.kind, "context"),
          isNull(edges.deletedAt),
        ),
      )
      .get();

    return (row?.max ?? 0) + 1;
  }

  /**
   * Command topology only (§3.7). Session ↔ session injection is legitimately
   * bidirectional and never consulted here.
   */
  private introducesCycle(fromNode: string, toCommand: string): boolean {
    const producer = this.producingCommandOf(fromNode);
    if (!producer) return false;

    const inputs = new Map<NodeId, NodeId[]>();

    for (const edge of this.state.db
      .select()
      .from(edges)
      .where(and(eq(edges.kind, "context"), isNull(edges.deletedAt)))
      .all()) {
      const target = this.state.db
        .select()
        .from(nodes)
        .where(eq(nodes.id, edge.toNode))
        .get();

      if (target?.role !== "command") continue;

      const source = this.producingCommandOf(edge.fromNode);
      if (!source) continue;

      const list = inputs.get(target.id as NodeId) ?? [];
      list.push(source as NodeId);
      inputs.set(target.id as NodeId, list);
    }

    return wouldCycle(inputs, producer as NodeId, toCommand as NodeId);
  }

  /**
   * The command that produced a content node, via its provenance edge. Content
   * nobody produced (a ticket, a note) has no producer and cannot form a cycle.
   */
  private producingCommandOf(contentNode: string): string | null {
    const provenance = this.state.db
      .select()
      .from(edges)
      .where(and(eq(edges.toNode, contentNode), eq(edges.kind, "provenance")))
      .all();

    for (const edge of provenance) {
      const source = this.state.db
        .select()
        .from(nodes)
        .where(eq(nodes.id, edge.fromNode))
        .get();

      if (source?.role === "command") return source.id;

      if (source?.role === "session") {
        const producing = this.state.db
          .select()
          .from(edges)
          .where(and(eq(edges.toNode, source.id), eq(edges.kind, "provenance")))
          .all();

        for (const link of producing) {
          const command = this.state.db
            .select()
            .from(nodes)
            .where(eq(nodes.id, link.fromNode))
            .get();
          if (command?.role === "command") return command.id;
        }
      }
    }

    return null;
  }

  private sessionOf(node: GraphNode): SessionId | null {
    if (node.role !== "session") return null;
    const row = this.state.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, node.id))
      .get();
    return (row?.refId as SessionId | undefined) ?? null;
  }

  private toGraphNode(row: NodeRow): GraphNode {
    return { id: row.id as NodeId, role: row.role, running: row.running };
  }
}
