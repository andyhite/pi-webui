/**
 * Notes: create, edit, promote (spec §3.8). Mechanics only — a plain
 * textarea supplies the content. There is no `@plotroom/core` note-content
 * schema yet (Epic 1.4/1.5 territory), so this fixture-layer model mirrors
 * the shape `@plotroom/core` already commits to: `Author` on every change
 * (§15-2), and "identical content writes no version" (AGENTS.md persistence
 * notes) mirroring the object/version rule the store will apply for real.
 */

import type { Author } from "@plotroom/core";

export interface NoteVersion {
  /** 1-based, monotonic — matches `ObjectVersion.ordinal`'s convention. */
  readonly ordinal: number;
  readonly content: string;
  readonly author: Author;
  readonly createdAt: number;
}

export interface Note {
  readonly id: string;
  /** Oldest first; the last entry is the current content. */
  readonly versions: readonly NoteVersion[];
  /** Local until promoted (§3.2); mirrors `PlotObject.promotedAt`. */
  readonly promotedAt: number | null;
}

export function createNote(
  id: string,
  content: string,
  author: Author,
  createdAt: number,
): Note {
  return {
    id,
    versions: [{ ordinal: 1, content, author, createdAt }],
    promotedAt: null,
  };
}

export function latestNoteVersion(note: Note): NoteVersion {
  const latest = note.versions[note.versions.length - 1];
  if (!latest) throw new Error("a note always has at least one version");
  return latest;
}

/**
 * Each edit is a new version, drifting consumers like any other content
 * change (§3.8). Content identical to the latest version writes no version —
 * the same rule `@plotroom/db`'s `ObjectStore` applies to real objects.
 */
export function editNote(
  note: Note,
  content: string,
  author: Author,
  createdAt: number,
): Note {
  const latest = latestNoteVersion(note);
  if (latest.content === content) return note;

  return {
    ...note,
    versions: [
      ...note.versions,
      { ordinal: latest.ordinal + 1, content, author, createdAt },
    ],
  };
}

/** Promotion is idempotent: promoting an already-promoted note is a no-op. */
export function promoteNote(note: Note, promotedAt: number): Note {
  return note.promotedAt === null ? { ...note, promotedAt } : note;
}

/**
 * A consumer that last read `consumedOrdinal` is drifted once a newer
 * version exists (§3.2): drift is a state, never an action.
 */
export function isDrifted(note: Note, consumedOrdinal: number): boolean {
  return consumedOrdinal < latestNoteVersion(note).ordinal;
}
