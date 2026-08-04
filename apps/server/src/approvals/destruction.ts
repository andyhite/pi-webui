import {
  checkDeletion,
  type Author,
  type DestructionTargetKind,
  type ProducerDeletionEffect,
  type SessionId,
} from "@plotroom/core";
import type { NodeRemoval } from "@plotroom/db";
import { atomically } from "../events/atomic.js";
import type { EventBus, EventSink } from "../events/bus.js";
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
 *
 * **Every kind here is one transaction, and every kind is gated before it
 * writes.** A cascade takes two things down — the subject, and the node the board
 * draws for it — and before those were one unit a throw between them left a live
 * node whose subject is filtered out of the snapshot: a card with nothing behind
 * it, which is also exactly what made an approval's recorded effect failure a lie
 * (it said the destruction did not happen about one that half did). One
 * transaction makes that record true: it did not happen.
 *
 * The gate is {@link destruction}'s for the six synchronous kinds. `session` asks
 * it itself, before the runtime stop, and then goes straight to `atomically` —
 * because that stop is not a row and no rollback un-stops one, so a refused
 * gesture must be refused before it happens rather than inside the transaction
 * that follows it.
 */
export interface DestructionOutcome {
  readonly kind: DestructionTargetKind;
  readonly targetId: string;
  /** False when it was already deleted: nothing changed, nothing announced. */
  readonly changed: boolean;
}

/**
 * Who is doing the destroying, and whether anybody agreed (§6.6).
 *
 * `approved` is the caller **stating** that an operator answered — the
 * `approve-once` branch of `ApprovalService`, or `destructionGuard` reporting
 * that a pre-grant or a standing decision answered in advance. It is a
 * parameter rather than something inferred from the author because an author
 * cannot tell you whether anybody agreed.
 */
export interface DestructionGate {
  readonly author: Author;
  readonly approved?: boolean;
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

export interface DestructionContext extends DestructionGate {
  /**
   * Required, so a caller that cannot name the kind in advance can always stop a
   * live session on the way to deleting its record. `performDestruction` is the
   * only thing that takes this — the six synchronous kinds are called directly by
   * the routes with a bare {@link DestructionGate} — and an optional field would
   * move the decision to whichever call site was written last.
   */
  readonly stopSession: LiveSessionStop;
}

/**
 * **`checkDeletion` is enforced here, and this is the only place that needs to
 * remember it.** The predicate refuses a session-authored destruction with no
 * approval behind it, so a call site that reaches a destructive effect without
 * routing through §6.6 fails closed rather than deleting — including the routes,
 * which perform their soft deletes through these functions rather than inline for
 * exactly that reason.
 */
function refuseUnlessAllowed(gate: DestructionGate): void {
  const allowed = checkDeletion(gate.author, {
    preApproved: gate.approved ?? false,
  });
  if (!allowed.allowed) throw forbidden(allowed.refusal.message);
}

/**
 * The gate and the transaction for a kind that is only rows. Nothing is announced
 * until the writes committed, which is what `announce` being a sink rather than
 * the bus buys.
 */
function destruction<T>(
  stores: ApiStores,
  bus: EventBus,
  gate: DestructionGate,
  apply: (announce: EventSink) => T,
): T {
  refuseUnlessAllowed(gate);
  return atomically(stores.db, bus, apply);
}

export function destroyObject(
  stores: ApiStores,
  bus: EventBus,
  objectId: string,
  gate: DestructionGate,
): DestructionOutcome {
  return destruction(stores, bus, gate, (announce) => {
    const wasLive = stores.objects.get(objectId)?.deletedAt === null;
    const row = stores.objects.delete(objectId);

    // The placement goes with it, so the board matches the model; restoring the
    // object puts the node and its wires back (principle 10).
    const node = stores.graph.findNodeFor("content", objectId);
    if (node) {
      announceRemoval(announce, gate.author, stores.graph.removeNode(node.id));
    }

    if (wasLive) {
      announce.publish({
        entity: "object",
        verb: "deleted",
        objectId: toPlotObject(row).id,
        author: gate.author,
      });
    }

    return { kind: "object", targetId: objectId, changed: wasLive };
  });
}

export function destroyNode(
  stores: ApiStores,
  bus: EventBus,
  nodeId: string,
  gate: DestructionGate,
): DestructionOutcome & { readonly removal: NodeRemoval } {
  return destruction(stores, bus, gate, (announce) => {
    const removal = stores.graph.removeNode(nodeId);
    announceRemoval(announce, gate.author, removal);
    return {
      kind: "node",
      targetId: nodeId,
      changed: removal.changed,
      removal,
    };
  });
}

export function destroyEdge(
  stores: ApiStores,
  bus: EventBus,
  edgeId: string,
  gate: DestructionGate,
): DestructionOutcome {
  return destruction(stores, bus, gate, (announce) => {
    const wired = stores.graph.edge(edgeId).deletedAt === null;
    const edge = toEdge(stores.graph.removeEdge(edgeId));

    if (wired) {
      announce.publish({
        entity: "edge",
        verb: "deleted",
        edgeId: edge.id,
        author: gate.author,
      });
    }

    return { kind: "edge", targetId: edgeId, changed: wired };
  });
}

export function destroyWorkstream(
  stores: ApiStores,
  bus: EventBus,
  workstreamId: string,
  gate: DestructionGate,
): DestructionOutcome {
  return destruction(stores, bus, gate, (announce) => {
    const wasLive = stores.workstreams.get(workstreamId)?.deletedAt === null;
    const row = stores.workstreams.delete(workstreamId, gate.author);

    if (wasLive) {
      announce.publish({
        entity: "workstream",
        verb: "deleted",
        workstreamId: toWorkstream(row).id,
        author: gate.author,
      });
    }

    return { kind: "workstream", targetId: workstreamId, changed: wasLive };
  });
}

export function destroyCommandDefinition(
  stores: ApiStores,
  bus: EventBus,
  definitionId: string,
  gate: DestructionGate,
): DestructionOutcome {
  return destruction(stores, bus, gate, (announce) => {
    const wasLive =
      stores.commands.definitionRow(definitionId).deletedAt === null;
    const definition = stores.commands.deleteDefinition(definitionId);

    if (wasLive) {
      announce.publish({
        entity: "command_definition",
        verb: "deleted",
        definitionId: definition.id as never,
        author: gate.author,
      });
    }

    return {
      kind: "command-definition",
      targetId: definitionId,
      changed: wasLive,
    };
  });
}

export function destroyCommand(
  stores: ApiStores,
  bus: EventBus,
  commandId: string,
  gate: DestructionGate,
): DestructionOutcome & {
  /** What deleting this producer did downstream (§3.5), for the response. */
  readonly effects: readonly ProducerDeletionEffect[];
} {
  return destruction(stores, bus, gate, (announce) => {
    const wasLive = stores.commands.command(commandId).deletedAt === null;
    const effects = stores.commands.delete(commandId);

    if (wasLive) {
      announce.publish({
        entity: "command",
        verb: "deleted",
        commandId: toCommandNode(stores.commands.command(commandId)).id,
        author: gate.author,
      });
      // A pre-bind placeholder is now visibly broken and its wires stay exactly
      // where they are: nothing downstream is silently unblocked (§3.5).
      for (const output of stores.commands.outputs(commandId)) {
        announce.publish({
          entity: "command_output",
          verb: "updated",
          output,
          author: gate.author,
        });
      }
    }

    return { kind: "command", targetId: commandId, changed: wasLive, effects };
  });
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
 * The stop is the one part of this that cannot be in the transaction — a process
 * is not a row, and no rollback un-stops one — which is why the gate runs
 * *before* it rather than being left to {@link destruction}: a refused gesture
 * must not have stopped anything on its way to being refused.
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
  gate: DestructionGate,
  stopSession: LiveSessionStop,
): Promise<DestructionOutcome & { readonly stopped: boolean }> {
  refuseUnlessAllowed(gate);

  const before = stores.sessions.get(sessionId);
  const wasLive = before.session.end === null;

  // Ordered: the record's own end is written before it leaves the board, so a
  // restore gives back a session that says how it ended rather than one still
  // claiming to be live.
  const stopped = wasLive && before.session.deletion.deletedAt === null;
  if (stopped) await stopSession(sessionId);

  // `atomically` rather than `destruction`: the gate above already ran, and asking
  // it twice would make it unclear which of the two is the one that matters.
  return atomically(stores.db, bus, (announce) => {
    // Re-read, because the stop suspended this function and a concurrent delete
    // of the same session can have landed in the meantime. Whether *this* call is
    // the one that removed the record decides what is announced, so it is read
    // from the record immediately before the write rather than from a flag taken
    // before the await — otherwise two gestures both announce one deletion.
    const changed =
      stores.sessions.get(sessionId).session.deletion.deletedAt === null;
    stores.sessions.delete(sessionId);

    // The placement goes with it, so the board matches the model; restoring the
    // session puts the node and its wires back (principle 10). Announced rather
    // than inferred — a subscriber told only "session deleted" would keep drawing
    // the node and every wire into it.
    const node = stores.graph.findNodeFor("session", sessionId);
    if (node) {
      announceRemoval(announce, gate.author, stores.graph.removeNode(node.id));
    }

    if (changed) {
      announce.publish({
        entity: "session",
        verb: "deleted",
        sessionId: sessionId as SessionId,
        author: gate.author,
      });
    }

    return { kind: "session", targetId: sessionId, changed, stopped };
  });
}

/**
 * The same effect, dispatched by the catalog's own `destroys` metadata — so a
 * new destructive verb is covered by declaring one, not by being added to a
 * second list (which is the mistake `decideDestruction` avoids upstream).
 */
export async function performDestruction(
  stores: ApiStores,
  bus: EventBus,
  kind: DestructionTargetKind,
  targetId: string,
  context: DestructionContext,
): Promise<DestructionOutcome> {
  switch (kind) {
    case "object":
      return destroyObject(stores, bus, targetId, context);
    case "node":
      return destroyNode(stores, bus, targetId, context);
    case "edge":
      return destroyEdge(stores, bus, targetId, context);
    case "workstream":
      return destroyWorkstream(stores, bus, targetId, context);
    case "command-definition":
      return destroyCommandDefinition(stores, bus, targetId, context);
    case "command":
      return destroyCommand(stores, bus, targetId, context);
    // Awaited here rather than returned, so the one asynchronous kind cannot make
    // this function's contract "a promise, sometimes".
    case "session":
      return await destroySession(
        stores,
        bus,
        targetId,
        context,
        context.stopSession,
      );
  }
}
