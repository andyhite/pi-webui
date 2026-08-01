/**
 * One-gesture flows (spec §3.5, §3.1): dropping a command definition onto a
 * bare ticket creates a workstream in the same instant — subject = ticket,
 * command node inside, ticket wired as context. The workspace is deferred
 * to first run (§3.4/§3.5), so this models only what the gesture itself
 * produces: a workstream id, the command node, and an authored context
 * edge — never an authorless one (§15-2).
 *
 * `@plotroom/core` does not yet export a command/run schema (Epic 1.4 is
 * Track A's, not landed); this models the result in fixture shapes that
 * match what does exist today (`Author`, `Edge`, ids) and will need to be
 * reconciled with the real command node shape once 1.4 lands.
 */

import type { Author, Edge, NodeId, WorkstreamId } from "@plotroom/core";
import { newEdgeId, newWorkstreamId } from "@plotroom/core";

/** Narrowed to the context-edge variant: this gesture always authors one. */
type ContextEdge = Extract<Edge, { readonly kind: "context" }>;

export interface WorkstreamFromDrop {
  readonly workstreamId: WorkstreamId;
  readonly subjectId: NodeId;
  readonly commandNodeId: NodeId;
  /** The ticket wired as context into the new command node, always authored. */
  readonly contextEdge: ContextEdge;
}

/**
 * `ticketId` must be a bare ticket (no workstream yet) and `commandNodeId`
 * the node instantiated from the dropped definition; the caller enforces
 * "bare" (this function only shapes the result of an already-valid drop).
 */
export function createWorkstreamFromDrop(
  ticketId: NodeId,
  commandNodeId: NodeId,
  author: Author,
  now: number,
): WorkstreamFromDrop {
  return {
    workstreamId: newWorkstreamId(),
    subjectId: ticketId,
    commandNodeId,
    contextEdge: {
      id: newEdgeId(),
      kind: "context",
      from: ticketId,
      to: commandNodeId,
      author,
      ordinal: 0,
      createdAt: now,
    },
  };
}

/**
 * Collections (§3.1): one node, one output, until inspected. Expand and
 * collapse toggle visibility of members; prune removes a member from the
 * collection without placing it; dragging a member out removes it from the
 * collection and hands back its id to place on the canvas as its own node.
 */
export interface Collection {
  readonly id: string;
  readonly memberIds: readonly string[];
  readonly expanded: boolean;
}

export function expandCollection(collection: Collection): Collection {
  return collection.expanded ? collection : { ...collection, expanded: true };
}

export function collapseCollection(collection: Collection): Collection {
  return collection.expanded ? { ...collection, expanded: false } : collection;
}

export function pruneMember(
  collection: Collection,
  memberId: string,
): Collection {
  if (!collection.memberIds.includes(memberId)) return collection;
  return {
    ...collection,
    memberIds: collection.memberIds.filter((id) => id !== memberId),
  };
}

export interface DragOutResult {
  readonly collection: Collection;
  /** null when `memberId` was not a member; nothing to drag out. */
  readonly draggedId: string | null;
}

export function dragOutMember(
  collection: Collection,
  memberId: string,
): DragOutResult {
  if (!collection.memberIds.includes(memberId)) {
    return { collection, draggedId: null };
  }
  return { collection: pruneMember(collection, memberId), draggedId: memberId };
}
