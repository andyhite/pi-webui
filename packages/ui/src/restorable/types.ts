/**
 * Restorable/undo (§5, principle 10, issue #65): "deletion is recoverable for
 * authored state — including when an agent did the deleting — but only if
 * there is a way to find what was deleted." The shape mirrors
 * `GET /api/restorable` (`apps/server/src/routes/restorable.ts`) field for
 * field, so this panel renders the response without reshaping it — the same
 * convention `search/types.ts` documents for `GET /api/search`.
 *
 * Every restore verb lives on the entity itself
 * (`POST /api/<kind>/:id/restore`); `RestorableKind` is the discriminant this
 * panel uses to pick the right one, never a guess from the id's shape.
 */

import type { SessionEnd } from "@plotroom/core";

export interface RestorableObjectRow {
  readonly id: string;
  readonly title: string;
  readonly deletedAt: number;
}

export interface RestorableNodeRow {
  readonly id: string;
  readonly role: string;
  readonly refId: string;
  readonly workstreamId: string | null;
}

export interface RestorableEdgeRow {
  readonly id: string;
  readonly kind: string;
  readonly from: string;
  readonly to: string;
}

export interface RestorableWorkstreamRow {
  readonly id: string;
  readonly subjectId: string | null;
  readonly status: string;
}

export interface RestorableCommandRow {
  readonly id: string;
  readonly definitionId: string;
  readonly workstreamId: string;
}

export interface RestorableCommandDefinitionRow {
  readonly id: string;
  readonly name: string;
}

export interface RestorableSessionRow {
  readonly id: string;
  readonly workstreamId: string | null;
  readonly deletedAt: number;
  /** Travels with the row deliberately (`restorable.ts`): "the list says what would come back rather than only that something would." */
  readonly end: SessionEnd | null;
}

/** Mirrors `restorable.ts`'s response, field for field. */
export interface RestorableSummary {
  readonly objects: readonly RestorableObjectRow[];
  readonly nodes: readonly RestorableNodeRow[];
  readonly edges: readonly RestorableEdgeRow[];
  readonly workstreams: readonly RestorableWorkstreamRow[];
  readonly commands: readonly RestorableCommandRow[];
  readonly commandDefinitions: readonly RestorableCommandDefinitionRow[];
  readonly sessions: readonly RestorableSessionRow[];
}

/** The seven entities `GET /api/restorable` lists — one `POST .../restore` verb each. */
export type RestorableKind =
  | "object"
  | "node"
  | "edge"
  | "workstream"
  | "command"
  | "commandDefinition"
  | "session";

export interface RestorableDataSource {
  /** A one-shot read (no live subscription yet) — a manual refresh stands in for one. */
  load(): Promise<RestorableSummary>;
}
