import { Hono } from "hono";
import { z } from "zod";
import { badRequest } from "../http/errors.js";
import { validateJsonBody } from "../http/validate.js";
import { actorOf, body, param, type ApiEnv, type ApiStores } from "./api.js";
import { announceRemoval, announceRestoration } from "./announce.js";
import { toEdge, toPlacedNode } from "./mappers.js";

const placeBody = z.object({
  role: z.enum(["content", "command", "session"]),
  refId: z.string().min(1),
  workstreamId: z.string().min(1).optional(),
  running: z.boolean().optional(),
});

const wireBody = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  /** Assembly order (§3.5); appended to the end when omitted. */
  ordinal: z.number().int().positive().optional(),
});

const reorderBody = z.object({
  edgeIds: z.array(z.string().min(1)),
});

/**
 * Canvas coordinates (§5). Null clears the authored position, so a derived
 * initial arrangement decides again — there is no sentinel like 0,0 to misread
 * as "unset".
 */
const position = z
  .object({ x: z.number().finite(), y: z.number().finite() })
  .nullable();

const positionBody = z.object({ position });

const arrangementBody = z.object({
  positions: z.array(z.object({ nodeId: z.string().min(1), position })).min(1),
});

/**
 * The graph itself (spec §3.7): placing nodes, wiring context, reordering it,
 * and taking any of it back.
 *
 * This is where the refusals live, and none of them is written here. The
 * legal connections (content → command, content → running session, nothing
 * else), command-topology acyclicity, and the reflexivity rule are predicates
 * in `@plotroom/core` that `GraphStore` calls; the route reports what they
 * said. That is the whole point of principle 8: the canvas refuses mid-drag
 * with the same reason string an agent gets back from this endpoint, because
 * there is one rule and one wording, not three.
 */
export function graphRoutes(stores: ApiStores): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const { graph, bus } = stores;

  app.post("/nodes", validateJsonBody(placeBody), (c) => {
    const input = body<z.infer<typeof placeBody>>(c);
    const author = actorOf(c);

    // One gesture creates one thing (principle 9): placing the same subject
    // twice returns the same node, and says so rather than announcing a
    // creation that did not happen.
    const existing = graph.findNodeFor(input.role, input.refId);
    const node = graph.place({
      role: input.role,
      refId: input.refId,
      ...(input.workstreamId ? { workstreamId: input.workstreamId } : {}),
      ...(input.running !== undefined ? { running: input.running } : {}),
    });

    if (!existing) {
      bus.publish({
        entity: "node",
        verb: "created",
        node: toPlacedNode(node),
        author,
      });
    }

    return c.json({ node: toPlacedNode(node) }, existing ? 200 : 201);
  });

  app.get("/nodes/:id", (c) =>
    c.json({ node: toPlacedNode(graph.node(param(c, "id"))) }),
  );

  /**
   * Durable placement (§5): where a node sits is authored state, so it lives in
   * the one portable store rather than in one browser's local storage. Nothing
   * derives it — "an arrangement at rest stays put" — so moving a node is a
   * mutation like any other, and it is announced like any other.
   */
  app.patch("/nodes/:id/position", validateJsonBody(positionBody), (c) => {
    const input = body<z.infer<typeof positionBody>>(c);
    const author = actorOf(c);
    const node = toPlacedNode(
      graph.setPosition(param(c, "id"), input.position),
    );

    bus.publish({ entity: "node", verb: "updated", node, author });

    return c.json({ node });
  });

  /**
   * One drag of a selection is one gesture (principle 9), so a whole arrangement
   * moves in one call and one transaction: a half-applied arrangement is not what
   * the operator asked for. An unknown node id refuses the lot rather than moving
   * the rest of it.
   */
  app.patch("/arrangement", validateJsonBody(arrangementBody), (c) => {
    const input = body<z.infer<typeof arrangementBody>>(c);
    const author = actorOf(c);
    const moved = graph
      .setPositions(input.positions)
      .map((row) => toPlacedNode(row));

    for (const node of moved) {
      bus.publish({ entity: "node", verb: "updated", node, author });
    }

    return c.json({ nodes: moved });
  });

  app.delete("/nodes/:id", (c) => {
    const author = actorOf(c);
    const removal = graph.removeNode(param(c, "id"));

    // The wires went down with it, so they are announced with it; a removal
    // that changed nothing announces nothing.
    announceRemoval(bus, author, removal);

    return c.json({
      node: toPlacedNode(removal.node),
      edges: removal.edges.map((edge) => toEdge(edge)),
      restorable: true,
    });
  });

  app.post("/nodes/:id/restore", (c) => {
    const author = actorOf(c);
    const restoration = graph.restoreNode(param(c, "id"));

    // Exactly what the removal took down comes back (principle 10), and
    // subscribers hear about each of them rather than inferring their return.
    announceRestoration(bus, author, restoration);

    return c.json({
      node: toPlacedNode(restoration.node),
      edges: restoration.edges.map((edge) => toEdge(edge)),
    });
  });

  /** Context inputs in assembly order (§3.5). */
  app.get("/nodes/:id/context", (c) => {
    const node = graph.node(param(c, "id"));
    return c.json({
      inputs: graph.contextInputs(node.id).map((row) => toEdge(row)),
    });
  });

  /**
   * Rearrangeable by drag (§3.5): the given order becomes assembly order.
   * Listing anything other than exactly the current inputs is refused — a
   * reorder that silently dropped an input would change what runs.
   */
  app.post("/nodes/:id/context/order", validateJsonBody(reorderBody), (c) => {
    const node = graph.node(param(c, "id"));
    const input = body<z.infer<typeof reorderBody>>(c);
    const author = actorOf(c);

    try {
      graph.reorderContextInputs(node.id, input.edgeIds);
    } catch (err) {
      throw badRequest(String(err instanceof Error ? err.message : err));
    }

    // Each event carries the full edge, so republishing the inputs is how a
    // subscriber learns the new order — there is no partial-diff verb, by
    // design (the same reasoning as full-snapshot run history, §15-1).
    const inputs = graph.contextInputs(node.id).map((row) => toEdge(row));
    for (const edge of inputs) {
      bus.publish({ entity: "edge", verb: "created", edge, author });
    }

    return c.json({ inputs });
  });

  /**
   * Author a context edge (§3.7, §15 invariant 2). The author is the caller's
   * attributed actor, and the schema cannot represent an edge without one.
   */
  app.post("/edges", validateJsonBody(wireBody), (c) => {
    const input = body<z.infer<typeof wireBody>>(c);
    const author = actorOf(c);
    const edge = graph.addContextEdge({
      from: input.from,
      to: input.to,
      author,
      ...(input.ordinal !== undefined ? { ordinal: input.ordinal } : {}),
    });

    bus.publish({
      entity: "edge",
      verb: "created",
      edge: toEdge(edge),
      author,
    });

    return c.json({ edge: toEdge(edge) }, 201);
  });

  app.delete("/edges/:id", (c) => {
    const id = param(c, "id");
    const author = actorOf(c);
    // Was it still wired? Unwiring an already-unwired edge changes nothing,
    // and announcing a deletion that did not happen would have subscribers
    // undo state twice.
    const wired = graph.edge(id).deletedAt === null;
    const edge = toEdge(graph.removeEdge(id));

    if (wired) {
      bus.publish({ entity: "edge", verb: "deleted", edgeId: edge.id, author });
    }

    return c.json({ edge, restorable: true });
  });

  app.post("/edges/:id/restore", (c) => {
    const id = param(c, "id");
    const author = actorOf(c);
    const wasRemoved = graph.edge(id).deletedAt !== null;
    const edge = toEdge(graph.restoreEdge(id));

    if (wasRemoved) {
      bus.publish({ entity: "edge", verb: "created", edge, author });
    }

    return c.json({ edge });
  });

  return app;
}
