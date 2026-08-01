import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  checkAuthoring,
  checkConnection,
  checkOutputCrossing,
  checkScope,
  newEdgeId,
  newNodeId,
  systemClock,
  wouldCycle,
  type Author,
  type Clock,
  type ConnectionRefusal,
  type GraphNode,
  type NodeId,
  type NodePosition,
  type NodeRole,
  type OutputCrossingFacts,
  type ProvenanceKind,
  type ScopeRefusal,
  type SessionId,
  type WorkstreamId,
} from "@plotroom/core";
import type { PlotroomDatabase } from "./client.js";
import { EntityNotFound } from "./errors.js";
import {
  commandOutputs,
  commands,
  edges,
  nodes,
  objects,
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

/** Thrown when a placement would break the scope rule (§3.3). */
export class ScopeRefused extends Error {
  constructor(readonly refusal: ScopeRefusal) {
    super(refusal.message);
    this.name = "ScopeRefused";
  }
}

/** Why a subject cannot be placed right now, distinct from an illegal wire. */
export type PlacementRefusal = {
  readonly reason: "node_deleted";
  readonly message: string;
};

export class PlacementRefused extends Error {
  constructor(readonly refusal: PlacementRefusal) {
    super(refusal.message);
    this.name = "PlacementRefused";
  }
}

/**
 * What a removal or restoration touched (principle 10). The edges travel with
 * the node because they went down with it, and a caller announcing only the
 * node would leave every subscriber drawing wires to something that is gone.
 * `changed` is false when the gesture was a no-op — already removed, already
 * back — so nothing announces a change that did not happen.
 */
export interface NodeRemoval {
  readonly node: NodeRow;
  readonly edges: readonly EdgeRow[];
  readonly changed: boolean;
}

export interface PlaceNodeInput {
  /**
   * The caller's own id, where the caller has one — steering plans them, so a
   * retried gesture writes the same node rather than a second one (principle 9).
   */
  readonly nodeId?: string;
  readonly role: NodeRole;
  /** The object, command, or session this node stands for. */
  readonly refId: string;
  readonly workstreamId?: string;
  readonly running?: boolean;
}

export interface ContextEdgeInput {
  /**
   * The caller's own id, where the caller has one — steering plans them, so a
   * retried gesture writes the same edge rather than a second one (principle 9).
   */
  readonly edgeId?: string;
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
    if (existing) {
      // — unless that node was removed. Silently handing it back would be a
      // placement gesture that changes nothing visible, and resurrecting it
      // here would quietly bring back the wires the removal took down (§10's
      // undo is a gesture of its own, and it is the one that does that).
      if (existing.deletedAt !== null) {
        throw new PlacementRefused({
          reason: "node_deleted",
          message: `that ${existing.role} was removed from the board; restore it instead of placing it again`,
        });
      }
      return existing;
    }

    // Scope rule (§3.3): a local object is placed only in the workstream
    // that owns it. Commands and sessions are confined by construction —
    // one node per subject, placed once.
    if (input.role === "content") {
      const scope = this.objectScopeOf(input.refId);
      if (scope) {
        const check = checkScope(
          scope,
          (input.workstreamId ?? null) as WorkstreamId | null,
        );
        if (!check.legal) throw new ScopeRefused(check.refusal);
      }
    }

    const id = input.nodeId ?? newNodeId();

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
    if (!row) throw new EntityNotFound("node", id);
    return row;
  }

  /** The node standing for a subject, unique per (role, refId) by index. */
  nodeFor(role: NodeRole, refId: string): NodeRow {
    const row = this.findNodeFor(role, refId);
    if (!row) {
      throw new EntityNotFound("node", refId, `no ${role} node for ${refId}`);
    }
    return row;
  }

  /**
   * The same lookup for callers where "nothing is placed for this subject" is
   * an ordinary answer — an object can exist without being on the board.
   *
   * Removed nodes are returned, deliberately: a soft-deleted node is still
   * addressable and still restorable (principle 10), and the callers that
   * need to exclude it — {@link place} refuses, the board reads filter — say
   * so themselves rather than being unable to see it at all.
   */
  findNodeFor(role: NodeRole, refId: string): NodeRow | undefined {
    return this.state.db
      .select()
      .from(nodes)
      .where(and(eq(nodes.role, role), eq(nodes.refId, refId)))
      .get();
  }

  setRunning(nodeId: string, running: boolean): void {
    this.state.db
      .update(nodes)
      .set({ running })
      .where(eq(nodes.id, nodeId))
      .run();
  }

  /**
   * Durable placement (§5): an arrangement at rest is authored state, so it is
   * kept in the one portable store like everything else. `null` means "no
   * authored position", which is what a derived initial arrangement fills in and
   * what resetting the arrangement returns a node to.
   */
  setPosition(nodeId: string, position: NodePosition | null): NodeRow {
    this.node(nodeId);

    this.state.db
      .update(nodes)
      .set({ x: position?.x ?? null, y: position?.y ?? null })
      .where(eq(nodes.id, nodeId))
      .run();

    return this.node(nodeId);
  }

  /**
   * Move many nodes at once, which is what one drag of a selection is (§5). One
   * transaction, so an arrangement is never half-applied — a partially moved
   * selection is not something the operator asked for.
   */
  setPositions(
    positions: readonly {
      readonly nodeId: string;
      readonly position: NodePosition | null;
    }[],
  ): NodeRow[] {
    for (const entry of positions) this.node(entry.nodeId);

    return this.state.db.transaction(() =>
      positions.map((entry) => this.setPosition(entry.nodeId, entry.position)),
    );
  }

  /**
   * Reset the arrangement (§5, §12): forget every authored position, so the
   * derived initial arrangement decides again. It invents no coordinates of its
   * own — "reset" means back to none, not back to some other opinion.
   */
  clearPositions(): { readonly cleared: number } {
    const placed = this.state.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(isNotNull(nodes.x), isNotNull(nodes.y)))
      .all();

    if (placed.length === 0) return { cleared: 0 };

    this.state.db.update(nodes).set({ x: null, y: null }).run();

    return { cleared: placed.length };
  }

  /**
   * Author a context edge. Refused for anything not in §3.7's exhaustive list,
   * for command-topology cycles, and for a session authoring into its own
   * initiation chain (principle 1).
   */
  addContextEdge(input: ContextEdgeInput): EdgeRow {
    // A caller-supplied id that already exists is **this same gesture arriving
    // twice**, which is the one case that short-circuits every check below: the
    // gesture already happened and was already judged legal, so re-judging it would
    // refuse the retry as a duplicate of itself. The gestures that supply edge ids
    // (injection, broadcast, handoff) are all retryable, and a retry must wire the
    // content once — the same reasoning `place` applies to a node (principle 9).
    if (input.edgeId !== undefined) {
      const already = this.state.db
        .select()
        .from(edges)
        .where(eq(edges.id, input.edgeId))
        .get();
      if (already) return already;
    }

    const fromRow = this.node(input.from);
    const toRow = this.node(input.to);
    const from = this.toGraphNode(fromRow);
    const to = this.toGraphNode(toRow);

    // A removed node is not on the board, so nothing wires to or from it: the
    // edge would be authored into a topology nobody can see, and restoring
    // the node later would bring back wires its removal never took down.
    for (const row of [fromRow, toRow]) {
      if (row.deletedAt !== null) {
        throw new ConnectionRefused({
          reason: "node_deleted",
          message: `that ${row.role} was removed from the board; restore it before wiring it`,
        });
      }
    }

    const legality = checkConnection(from, to);
    if (!legality.legal) throw new ConnectionRefused(legality.refusal);

    // Scope rule (§3.3): objects cross workstream boundaries only as world
    // objects. The object's own row is the truth — a promoted object crosses
    // freely no matter where its node was first placed.
    const scope = this.objectScopeOf(fromRow.refId);
    if (scope) {
      const scopeCheck = checkScope(
        scope,
        (toRow.workstreamId ?? null) as WorkstreamId | null,
      );
      if (!scopeCheck.legal) throw new ConnectionRefused(scopeCheck.refusal);
    }

    // Publishing is what lets an output placeholder cross workstreams, and a
    // placeholder whose command was deleted before producing anything is
    // refused outright rather than treated as quietly wireable (§3.5).
    const crossing = this.outputCrossingOf(fromRow.refId);
    if (crossing) {
      const crossingCheck = checkOutputCrossing(
        crossing,
        (toRow.workstreamId ?? null) as WorkstreamId | null,
      );
      if (!crossingCheck.legal) {
        throw new ConnectionRefused(crossingCheck.refusal);
      }
    }

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

    const id = input.edgeId ?? newEdgeId();

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
  /**
   * Record a provenance edge (§3.7). Recorded as work happens, never authored.
   *
   * **Idempotent in the fact it states.** A provenance edge is a fact — this session
   * was forked from that one — and recording the same fact twice does not make two
   * facts, it draws one relationship twice on the board. That matters because the
   * gestures that record provenance are retryable (a fork, a handoff, a delegation),
   * and a retry that got as far as this line the first time must not leave a second
   * edge behind (principle 9).
   */
  recordProvenance(
    from: string,
    to: string,
    relation: ProvenanceKind,
  ): EdgeRow {
    const existing = this.state.db
      .select()
      .from(edges)
      .where(
        and(
          eq(edges.kind, "provenance"),
          eq(edges.fromNode, from),
          eq(edges.toNode, to),
          eq(edges.relation, relation),
        ),
      )
      .get();
    if (existing) return existing;

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

  /**
   * Soft delete: authored state is recoverable, agent deletions too (§10).
   *
   * Context edges only. Provenance is recorded as work happens and never
   * authored (§3.7), so there is no gesture that removes one — removing the
   * record that a session created an object would make the graph lie about
   * what happened, and no undo restores a history nobody can see is missing.
   */
  removeEdge(edgeId: string): EdgeRow {
    const row = this.edge(edgeId);

    if (row.kind !== "context") {
      throw new ConnectionRefused({
        reason: "provenance_not_authored",
        message:
          "provenance is recorded as work happens, never authored; it cannot be removed",
      });
    }

    this.state.db
      .update(edges)
      .set({ deletedAt: this.now() })
      .where(eq(edges.id, edgeId))
      .run();

    return this.edge(edgeId);
  }

  restoreEdge(edgeId: string): EdgeRow {
    this.edge(edgeId);

    this.state.db
      .update(edges)
      .set({ deletedAt: null })
      .where(eq(edges.id, edgeId))
      .run();

    return this.edge(edgeId);
  }

  /**
   * Remove a node from the board, with the edges that ran through it — one
   * gesture, one undo (principle 9, principle 10). The edges are stamped with
   * the node's own deletion time, so restoring the node puts back exactly what
   * its removal took down and nothing a later gesture removed separately.
   */
  removeNode(nodeId: string): NodeRemoval {
    const row = this.node(nodeId);
    if (row.deletedAt !== null) return { node: row, edges: [], changed: false };

    const at = this.now();

    return this.state.db.transaction(() => {
      // Read the wires before stamping them, so the caller can announce each
      // one: a subscriber that only heard "node deleted" would keep drawing
      // edges to a node that is gone (§2.1's stream is what the canvas renders).
      const touched = this.state.db
        .select()
        .from(edges)
        .where(
          and(
            isNull(edges.deletedAt),
            or(eq(edges.fromNode, nodeId), eq(edges.toNode, nodeId)),
          ),
        )
        .all();

      this.state.db
        .update(edges)
        .set({ deletedAt: at })
        .where(
          and(
            isNull(edges.deletedAt),
            or(eq(edges.fromNode, nodeId), eq(edges.toNode, nodeId)),
          ),
        )
        .run();

      this.state.db
        .update(nodes)
        .set({ deletedAt: at })
        .where(eq(nodes.id, nodeId))
        .run();

      return {
        node: this.node(nodeId),
        edges: touched.map((edge) => this.edge(edge.id)),
        changed: true,
      };
    });
  }

  restoreNode(nodeId: string): NodeRemoval {
    const row = this.node(nodeId);
    if (row.deletedAt === null) return { node: row, edges: [], changed: false };

    const at = row.deletedAt;

    return this.state.db.transaction(() => {
      const touched = this.state.db
        .select()
        .from(edges)
        .where(
          and(
            eq(edges.deletedAt, at),
            or(eq(edges.fromNode, nodeId), eq(edges.toNode, nodeId)),
          ),
        )
        .all();

      this.state.db
        .update(edges)
        .set({ deletedAt: null })
        .where(
          and(
            eq(edges.deletedAt, at),
            or(eq(edges.fromNode, nodeId), eq(edges.toNode, nodeId)),
          ),
        )
        .run();

      this.state.db
        .update(nodes)
        .set({ deletedAt: null })
        .where(eq(nodes.id, nodeId))
        .run();

      return {
        node: this.node(nodeId),
        edges: touched.map((edge) => this.edge(edge.id)),
        changed: true,
      };
    });
  }

  /**
   * Every node the board draws (Epic 2.2's snapshot read): the converse of
   * {@link deletedNodes}, and what a client that replayed every `node`
   * event from scratch would end up holding.
   */
  liveNodes(): NodeRow[] {
    return this.state.db
      .select()
      .from(nodes)
      .where(isNull(nodes.deletedAt))
      .all();
  }

  /**
   * Every edge the board draws, context and provenance alike — the converse
   * of {@link deletedEdges} (provenance is never soft-deleted, so it is
   * always included).
   */
  liveEdges(): EdgeRow[] {
    return this.state.db
      .select()
      .from(edges)
      .where(isNull(edges.deletedAt))
      .orderBy(edges.toNode, edges.ordinal)
      .all();
  }

  /** What the undo verb can put back (principle 10). */
  deletedNodes(): NodeRow[] {
    return this.state.db
      .select()
      .from(nodes)
      .where(isNotNull(nodes.deletedAt))
      .all();
  }

  deletedEdges(): EdgeRow[] {
    return this.state.db
      .select()
      .from(edges)
      .where(and(eq(edges.kind, "context"), isNotNull(edges.deletedAt)))
      .all();
  }

  edge(id: string): EdgeRow {
    const row = this.state.db
      .select()
      .from(edges)
      .where(eq(edges.id, id))
      .get();
    if (!row) throw new EntityNotFound("edge", id);
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

  /**
   * The scope facts for a content node's object, when it is one. Content
   * with no object row (not yet materialized) is unconstrained.
   */
  private objectScopeOf(
    refId: string,
  ): Parameters<typeof checkScope>[0] | null {
    const row = this.state.db
      .select()
      .from(objects)
      .where(eq(objects.id, refId))
      .get();

    if (!row) return null;

    return {
      kind: "object",
      scope: row.scope,
      workstreamId: (row.workstreamId ?? null) as WorkstreamId | null,
    };
  }

  /**
   * The crossing facts for a content node standing for a command's output
   * placeholder, when it is one. Ordinary content has no row here and is
   * governed by the object scope rule instead.
   *
   * Once bound, the produced object's own scope is what the rule reads, so the
   * placeholder cannot become an alias that carries a local object somewhere
   * the object itself could not go (§3.3, §3.5).
   */
  private outputCrossingOf(refId: string): OutputCrossingFacts | null {
    const row = this.state.db
      .select({
        workstreamId: commands.workstreamId,
        publishedAt: commandOutputs.publishedAt,
        boundObjectId: commandOutputs.boundObjectId,
        brokenAt: commandOutputs.brokenAt,
        boundScope: objects.scope,
      })
      .from(commandOutputs)
      .innerJoin(commands, eq(commands.id, commandOutputs.commandId))
      .leftJoin(objects, eq(objects.id, commandOutputs.boundObjectId))
      .where(eq(commandOutputs.id, refId))
      .get();

    if (!row) return null;

    return {
      workstreamId: row.workstreamId as WorkstreamId,
      published: row.publishedAt !== null,
      broken: row.brokenAt !== null,
      boundScope: row.boundObjectId === null ? null : (row.boundScope ?? null),
    };
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
