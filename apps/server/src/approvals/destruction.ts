import type { Author, DestructionTargetKind } from "@plotroom/core";
import type { EventBus } from "../events/bus.js";
import { announceRemoval } from "../routes/announce.js";
import type { ApiStores } from "../routes/api.js";
import {
  toCommandNode,
  toEdge,
  toPlotObject,
  toWorkstream,
} from "../routes/mappers.js";

/**
 * Performing a destruction, in one place (§6.6, principle 10).
 *
 * There are two ways a destructive gesture arrives — the operator calling the
 * endpoint, and an approval the operator answered for a session that asked — and
 * they must produce **the same** effect, including the same events. So the effect
 * lives here and both paths call it: the routes below their own response
 * shaping, and `ApprovalService` when a destruction approval is approved.
 *
 * Attribution travels with the gesture rather than with the answer. A session
 * asked to delete an object; the operator agreed; the object was deleted **by the
 * session** (principle 1's attribution, §15-2's rule applied to a deletion) — the
 * operator authorized it, and a record saying they did the deleting would lose
 * which agent's work took the arrangement apart.
 */
export interface DestructionOutcome {
  readonly kind: DestructionTargetKind;
  readonly targetId: string;
  /** False when it was already deleted: nothing changed, nothing announced. */
  readonly changed: boolean;
}

export function destroyObject(
  stores: ApiStores,
  bus: EventBus,
  objectId: string,
  author: Author,
): DestructionOutcome {
  const wasLive = stores.objects.get(objectId)?.deletedAt === null;
  const row = stores.objects.delete(objectId);

  // The placement goes with it, so the board matches the model; restoring the
  // object puts the node and its wires back (principle 10).
  const node = stores.graph.findNodeFor("content", objectId);
  if (node) announceRemoval(bus, author, stores.graph.removeNode(node.id));

  if (wasLive) {
    bus.publish({
      entity: "object",
      verb: "deleted",
      objectId: toPlotObject(row).id,
      author,
    });
  }

  return { kind: "object", targetId: objectId, changed: wasLive };
}

export function destroyNode(
  stores: ApiStores,
  bus: EventBus,
  nodeId: string,
  author: Author,
): DestructionOutcome {
  const removal = stores.graph.removeNode(nodeId);
  announceRemoval(bus, author, removal);
  return { kind: "node", targetId: nodeId, changed: removal.changed };
}

export function destroyEdge(
  stores: ApiStores,
  bus: EventBus,
  edgeId: string,
  author: Author,
): DestructionOutcome {
  const wired = stores.graph.edge(edgeId).deletedAt === null;
  const edge = toEdge(stores.graph.removeEdge(edgeId));

  if (wired) {
    bus.publish({ entity: "edge", verb: "deleted", edgeId: edge.id, author });
  }

  return { kind: "edge", targetId: edgeId, changed: wired };
}

export function destroyWorkstream(
  stores: ApiStores,
  bus: EventBus,
  workstreamId: string,
  author: Author,
): DestructionOutcome {
  const wasLive = stores.workstreams.get(workstreamId)?.deletedAt === null;
  const row = stores.workstreams.delete(workstreamId, author);

  if (wasLive) {
    bus.publish({
      entity: "workstream",
      verb: "deleted",
      workstreamId: toWorkstream(row).id,
      author,
    });
  }

  return { kind: "workstream", targetId: workstreamId, changed: wasLive };
}

export function destroyCommandDefinition(
  stores: ApiStores,
  bus: EventBus,
  definitionId: string,
  author: Author,
): DestructionOutcome {
  const wasLive =
    stores.commands.definitionRow(definitionId).deletedAt === null;
  const definition = stores.commands.deleteDefinition(definitionId);

  if (wasLive) {
    bus.publish({
      entity: "command_definition",
      verb: "deleted",
      definitionId: definition.id as never,
      author,
    });
  }

  return {
    kind: "command-definition",
    targetId: definitionId,
    changed: wasLive,
  };
}

export function destroyCommand(
  stores: ApiStores,
  bus: EventBus,
  commandId: string,
  author: Author,
): DestructionOutcome {
  const wasLive = stores.commands.command(commandId).deletedAt === null;
  stores.commands.delete(commandId);

  if (wasLive) {
    bus.publish({
      entity: "command",
      verb: "deleted",
      commandId: toCommandNode(stores.commands.command(commandId)).id,
      author,
    });
    // A pre-bind placeholder is now visibly broken and its wires stay exactly
    // where they are: nothing downstream is silently unblocked (§3.5).
    for (const output of stores.commands.outputs(commandId)) {
      bus.publish({
        entity: "command_output",
        verb: "updated",
        output,
        author,
      });
    }
  }

  return { kind: "command", targetId: commandId, changed: wasLive };
}

/**
 * The same effect, dispatched by the catalog's own `destroys` metadata — so a
 * new destructive verb is covered by declaring one, not by being added to a
 * second list (which is the mistake `decideDestruction` avoids upstream).
 */
export function performDestruction(
  stores: ApiStores,
  bus: EventBus,
  kind: DestructionTargetKind,
  targetId: string,
  author: Author,
): DestructionOutcome {
  switch (kind) {
    case "object":
      return destroyObject(stores, bus, targetId, author);
    case "node":
      return destroyNode(stores, bus, targetId, author);
    case "edge":
      return destroyEdge(stores, bus, targetId, author);
    case "workstream":
      return destroyWorkstream(stores, bus, targetId, author);
    case "command-definition":
      return destroyCommandDefinition(stores, bus, targetId, author);
    case "command":
      return destroyCommand(stores, bus, targetId, author);
  }
}
