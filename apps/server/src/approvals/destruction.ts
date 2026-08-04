import {
  checkDeletion,
  type Author,
  type DestructionTargetKind,
  type SessionId,
} from "@plotroom/core";
import type { EventBus } from "../events/bus.js";
import { forbidden } from "../http/errors.js";
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

/**
 * Stopping a live session, which is the half of a session's deletion a store
 * cannot do (§3.6).
 *
 * A function rather than the run service itself, because `ApprovalService` is
 * constructed before `RunService` — and because what is needed here is one verb,
 * not a service. `app.ts` closes over the run service's own stop, so the stop a
 * deletion performs is the same stop the operator's stop button performs: one
 * end state, one event, one way work ends (§6.7).
 */
export type LiveSessionStop = (sessionId: string) => Promise<void>;

export interface DestructionContext {
  /**
   * The caller stating that an operator answered. `ApprovalService` passes it
   * only inside the `approve-once` branch; it is a parameter rather than
   * something inferred from the author because an author cannot tell you whether
   * anybody agreed.
   */
  readonly approved?: boolean;
  /**
   * Required, for every kind rather than only for `session`: a caller that has
   * no way to stop a live session has no business deleting one, and an optional
   * field would make that the one destruction path enforced by nothing.
   */
  readonly stopSession: LiveSessionStop;
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
 * Delete a session record (§3.6, principle 10).
 *
 * §3.6 says a session record is "readable, resumable, forkable, deletable,
 * always", and "there is no distinction between a live session and a stored
 * one" — so a live session is deletable too. It is **stopped first**, in the same
 * gesture: a soft-deleted record whose runtime is still running is a session
 * nobody can see, which is the invisible stall the product exists to prevent. The
 * stop is the run service's own (`§6.7`), so it records the ordinary `stopped`
 * end state and publishes it — announced, never silent — and `stopped` travels
 * back on the outcome so the response can say what the gesture did.
 *
 * Nothing below the record is touched: the observation log, the transcript
 * object, the injections, and every delegated child session stay. A child is its
 * own record with its own provenance, and one gesture destroying an unnamed
 * subtree is not a recoverable gesture in any useful sense (principle 10).
 */
export async function destroySession(
  stores: ApiStores,
  bus: EventBus,
  sessionId: string,
  author: Author,
  stopSession: LiveSessionStop,
): Promise<DestructionOutcome & { readonly stopped: boolean }> {
  const stored = stores.sessions.get(sessionId);
  const wasLive = stored.session.end === null;
  const wasDeleted = stored.session.deletion.deletedAt !== null;

  // Ordered: the record's own end is written before it leaves the board, so a
  // restore gives back a session that says how it ended rather than one still
  // claiming to be live.
  if (wasLive && !wasDeleted) await stopSession(sessionId);

  stores.sessions.delete(sessionId);

  // The placement goes with it, so the board matches the model; restoring the
  // session puts the node and its wires back (principle 10). Announced rather
  // than inferred — a subscriber told only "session deleted" would keep drawing
  // the node and every wire into it.
  const node = stores.graph.findNodeFor("session", sessionId);
  if (node) announceRemoval(bus, author, stores.graph.removeNode(node.id));

  if (!wasDeleted) {
    bus.publish({
      entity: "session",
      verb: "deleted",
      sessionId: sessionId as SessionId,
      author,
    });
  }

  return {
    kind: "session",
    targetId: sessionId,
    changed: !wasDeleted,
    stopped: wasLive && !wasDeleted,
  };
}

/**
 * The same effect, dispatched by the catalog's own `destroys` metadata — so a
 * new destructive verb is covered by declaring one, not by being added to a
 * second list (which is the mistake `decideDestruction` avoids upstream).
 *
 * **`checkDeletion` is the backstop here, and it is a real one.** The predicate
 * refuses a session-authored destruction that has no approval behind it, so a
 * future call site that reaches this function without routing through §6.6 fails
 * closed rather than deleting. `approved` is the caller *stating* that an
 * operator answered — `ApprovalService` passes it only inside the
 * `approve-once` branch — which is why it is a parameter rather than something
 * inferred from the author: an author cannot tell you whether anybody agreed.
 */
export async function performDestruction(
  stores: ApiStores,
  bus: EventBus,
  kind: DestructionTargetKind,
  targetId: string,
  author: Author,
  context: DestructionContext,
): Promise<DestructionOutcome> {
  const allowed = checkDeletion(author, {
    preApproved: context.approved ?? false,
  });
  if (!allowed.allowed) throw forbidden(allowed.refusal.message);

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
    // Awaited here rather than returned, so the one asynchronous kind cannot make
    // this function's contract "a promise, sometimes".
    case "session":
      return await destroySession(
        stores,
        bus,
        targetId,
        author,
        context.stopSession,
      );
  }
}
