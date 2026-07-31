import type { ObjectId, VersionId } from "./ids.js";

/**
 * Spec §15 invariant 3 / §3.2: retention is a rule, not an accident.
 *
 * - every version referenced by any run's history is retained
 * - unreferenced intermediate versions are compacted after a window
 * - a pinned run and everything it references is never compacted
 *
 * These flags exist on every version from the first migration. Retrofitting
 * them means the product cannot tell which past versions were safe to drop.
 */
export interface RetentionMetadata {
  /** A run consumed this version; run history must stay comparable (§4.4). */
  readonly runReferenced: boolean;
  /** Referenced by a pinned run — the human's word for "never compact this". */
  readonly pinned: boolean;
}

export interface ObjectVersion extends RetentionMetadata {
  readonly id: VersionId;
  readonly objectId: ObjectId;
  /** 1-based, monotonic per object. */
  readonly ordinal: number;
  /** sha256 of the agent-ready content; unchanged content makes no version. */
  readonly contentHash: string;
  readonly summary: string;
  readonly createdAt: number;
}

export interface CompactionPolicy {
  /** Versions younger than this are always kept, referenced or not. */
  readonly windowSeconds: number;
}

/**
 * The compaction predicate, kept as one pure function so the rule lives in one
 * place and can be asserted directly in tests.
 *
 * A version is compactable only when it is an unreferenced *intermediate*:
 * never the latest version, never run-referenced, never pinned, and older than
 * the window.
 */
export function isCompactable(
  version: ObjectVersion,
  context: {
    readonly isLatest: boolean;
    readonly now: number;
    readonly policy: CompactionPolicy;
  },
): boolean {
  if (context.isLatest) return false;
  if (version.pinned) return false;
  if (version.runReferenced) return false;
  return version.createdAt < context.now - context.policy.windowSeconds;
}

/** Nothing is retained forever by default; both halves are deliberate (§3.2). */
export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  windowSeconds: 30 * 24 * 60 * 60,
};
