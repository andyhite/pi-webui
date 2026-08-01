import type { Author } from "../author.js";

/**
 * Principle 10: deletion is recoverable for authored state — including when an
 * agent did the deleting. Every authored record in this subtree carries this
 * state instead of being removed, so "delete" is a gesture with an inverse.
 *
 * There is no purge policy here on purpose: nothing in the spec says a deleted
 * record expires, and inventing a window would make recovery quietly
 * time-limited.
 */
export interface SoftDeleteState {
  readonly deletedAt: number | null;
  /** Who deleted it — human or session (principle 1 attribution). */
  readonly deletedBy: Author | null;
  /** Set when a deletion is undone, so the record shows it came back. */
  readonly restoredAt: number | null;
}

export const NOT_DELETED: SoftDeleteState = {
  deletedAt: null,
  deletedBy: null,
  restoredAt: null,
};

export interface SoftDeletable {
  readonly deletion: SoftDeleteState;
}

export function isDeleted(record: SoftDeletable): boolean {
  return record.deletion.deletedAt !== null;
}

export function markDeleted(
  record: SoftDeleteState,
  at: number,
  by: Author,
): SoftDeleteState {
  if (record.deletedAt !== null) return record;
  return { deletedAt: at, deletedBy: by, restoredAt: null };
}

export function markRestored(
  record: SoftDeleteState,
  at: number,
): SoftDeleteState {
  if (record.deletedAt === null) return record;
  return { deletedAt: null, deletedBy: null, restoredAt: at };
}

export type DeletionRefusal = {
  readonly reason: "session_deletion_needs_approval";
  readonly message: string;
};

export type DeletionCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: DeletionRefusal };

/**
 * Principle 8 / §6.6: destroying authored state requested by an agent goes
 * through the approval channel. A human is the authority the system terminates
 * at and is never gated here.
 *
 * One predicate, so the canvas, the API, and agent tools refuse identically —
 * the same shape as `checkLifecycleAuthoring`.
 */
export function checkDeletion(
  author: Author,
  context: { readonly preApproved: boolean } = { preApproved: false },
): DeletionCheck {
  if (author.kind === "human") return { allowed: true };
  if (context.preApproved) return { allowed: true };

  return {
    allowed: false,
    refusal: {
      reason: "session_deletion_needs_approval",
      message:
        "a session destroying authored state raises an approval; it is never applied silently",
    },
  };
}
