/**
 * Notes: create, edit, promote (spec §3.8). Mechanics only — a plain
 * textarea is the editor (a full document editor is directional, §13).
 */

import { useState } from "react";
import type { Author } from "@plotroom/core";

import { editNote, latestNoteVersion, promoteNote } from "./model.js";
import type { Note } from "./model.js";

export interface NotePanelProps {
  readonly note: Note;
  readonly author: Author;
  readonly now: () => number;
  readonly onChange: (note: Note) => void;
}

/** Edit and promote a single note. Creation is the caller's job (it needs an id). */
export function NotePanel({ note, author, now, onChange }: NotePanelProps) {
  const latest = latestNoteVersion(note);
  const [draft, setDraft] = useState(latest.content);

  return (
    <div>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div>
        <button
          type="button"
          onClick={() => onChange(editNote(note, draft, author, now()))}
        >
          save
        </button>
        <button
          type="button"
          disabled={note.promotedAt !== null}
          onClick={() => onChange(promoteNote(note, now()))}
        >
          {note.promotedAt !== null ? "promoted" : "promote"}
        </button>
      </div>
      <div>version {latest.ordinal}</div>
    </div>
  );
}
