import type { Author } from "@plotroom/core";
import type { NodeRemoval } from "@plotroom/db";
import type { EventBus } from "../events/bus.js";
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
 */
export function announceRemoval(
  bus: EventBus,
  author: Author,
  removal: NodeRemoval,
): void {
  if (!removal.changed) return;

  for (const edge of removal.edges) {
    bus.publish({
      entity: "edge",
      verb: "deleted",
      edgeId: toEdge(edge).id,
      author,
    });
  }

  bus.publish({
    entity: "node",
    verb: "deleted",
    nodeId: toPlacedNode(removal.node).id,
    author,
  });
}

export function announceRestoration(
  bus: EventBus,
  author: Author,
  removal: NodeRemoval,
): void {
  if (!removal.changed) return;

  bus.publish({
    entity: "node",
    verb: "created",
    node: toPlacedNode(removal.node),
    author,
  });

  for (const edge of removal.edges) {
    bus.publish({
      entity: "edge",
      verb: "created",
      edge: toEdge(edge),
      author,
    });
  }
}
