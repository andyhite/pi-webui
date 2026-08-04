import type { Author } from "@plotroom/core";
import type { NodeRemoval } from "@plotroom/db";
import type { EventSink } from "../events/bus.js";
import { toEdge, toPlacedNode } from "./mappers.js";

/**
 * Removing a node takes its wires down with it, so announcing only the node
 * would leave every subscriber drawing edges to something that is gone — the
 * WS stream is what the canvas renders, and a partial announcement is a
 * desync, not a saving.
 *
 * Order is deliberate and mirrored: tearing down goes leaves-first (edges,
 * then the node they hung off), putting back goes roots-first (the node, then
 * the edges that need it to exist). A renderer applying these in order never
 * sees an edge whose endpoint it does not have.
 *
 * The sink rather than the bus, because a cascade is one transaction: inside
 * one, what happened is buffered and reaches subscribers only once the writes
 * committed (`events/atomic.ts`).
 */
export function announceRemoval(
  sink: EventSink,
  author: Author,
  removal: NodeRemoval,
): void {
  if (!removal.changed) return;

  for (const edge of removal.edges) {
    sink.publish({
      entity: "edge",
      verb: "deleted",
      edgeId: toEdge(edge).id,
      author,
    });
  }

  sink.publish({
    entity: "node",
    verb: "deleted",
    nodeId: toPlacedNode(removal.node).id,
    author,
  });
}

export function announceRestoration(
  sink: EventSink,
  author: Author,
  removal: NodeRemoval,
): void {
  if (!removal.changed) return;

  sink.publish({
    entity: "node",
    verb: "created",
    node: toPlacedNode(removal.node),
    author,
  });

  for (const edge of removal.edges) {
    sink.publish({
      entity: "edge",
      verb: "created",
      edge: toEdge(edge),
      author,
    });
  }
}
