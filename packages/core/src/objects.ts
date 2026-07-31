import type { ObjectId, VersionId, WorkstreamId } from "./ids.js";

/**
 * Spec §3.1: the core defines a small set of generic concepts. Integrations
 * populate them; they never add new ones. A Jira ticket is not a first-class
 * thing — a ticket is, and a Jira integration knows how to produce tickets.
 */
export const OBJECT_KINDS = [
  "ticket",
  "pull_request",
  "review",
  "document",
  "diff",
  "commit",
  "note",
  "transcript",
  "collection",
] as const;

export type ObjectKind = (typeof OBJECT_KINDS)[number];

/**
 * Spec §3.2: a world object can be context for many workstreams; a local
 * object belongs to the workstream that produced it. Locality is a default,
 * not a definition — any local object can be promoted in one gesture.
 */
export type ObjectScope = "world" | "local";

/**
 * Spec §3.1: an object from outside carries the external system's identity,
 * so re-reading reconciles rather than duplicates.
 */
export interface ExternalIdentity {
  /** The integration that produced it, e.g. "jira", "github". */
  readonly system: string;
  /** The identity in that system, e.g. "OXY-2982". */
  readonly id: string;
}

export interface PlotObject {
  readonly id: ObjectId;
  readonly kind: ObjectKind;
  readonly scope: ObjectScope;
  /** Set for local objects; null once promoted to world scope. */
  readonly workstreamId: WorkstreamId | null;
  readonly external: ExternalIdentity | null;
  readonly title: string;
  readonly latestVersionId: VersionId;
  readonly createdAt: number;
  readonly promotedAt: number | null;
}
