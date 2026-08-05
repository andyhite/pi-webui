import type { Author, SessionId, VersionId } from "@plotroom/core";
import type { NodeRemoval, PublishTranscriptResult } from "@plotroom/db";
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

/**
 * The one shape a transcript's `session_transcript created` event takes,
 * wherever the transcript versions (checkpoint gesture, session end, a
 * crashed session finalized on the way out) — extracted so those three call
 * sites cannot drift on the event's fields (#70). `publishTranscript` itself
 * already returns `null` for "nothing new" (§3.6); this only ever announces
 * an actual publication, so callers still decide for themselves whether a
 * null result skips reindexing or not — that choice differs by caller on
 * purpose and stays theirs.
 */
export function announceTranscriptPublished(
  sink: EventSink,
  sessionId: string,
  published: PublishTranscriptResult,
  author: Author,
): void {
  sink.publish({
    entity: "session_transcript",
    verb: "created",
    sessionId: sessionId as SessionId,
    publication: published.publication,
    objectId: published.objectId,
    versionId: published.versionId as VersionId,
    author,
  });
}
