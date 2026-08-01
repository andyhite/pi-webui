import { humanAuthor, sessionAuthor } from "@plotroom/core";
import type { SessionId } from "@plotroom/core";
import { describe, expect, it } from "vitest";

import {
  createNote,
  editNote,
  isDrifted,
  latestNoteVersion,
  promoteNote,
} from "./model.js";

describe("createNote", () => {
  it("starts at version 1 with the given author", () => {
    const note = createNote("n1", "hello", humanAuthor, 1000);
    expect(note.versions).toEqual([
      { ordinal: 1, content: "hello", author: humanAuthor, createdAt: 1000 },
    ]);
    expect(note.promotedAt).toBeNull();
  });
});

describe("editNote", () => {
  it("appends a new version on a real edit", () => {
    const note = createNote("n1", "hello", humanAuthor, 1000);
    const edited = editNote(note, "hello world", humanAuthor, 2000);
    expect(edited.versions).toHaveLength(2);
    expect(latestNoteVersion(edited)).toEqual({
      ordinal: 2,
      content: "hello world",
      author: humanAuthor,
      createdAt: 2000,
    });
  });

  it("writes no version when content is unchanged", () => {
    const note = createNote("n1", "hello", humanAuthor, 1000);
    const edited = editNote(note, "hello", humanAuthor, 2000);
    expect(edited).toBe(note);
  });

  it("records a session author on an agent-made edit", () => {
    const note = createNote("n1", "hello", humanAuthor, 1000);
    const author = sessionAuthor("sess_1" as SessionId);
    const edited = editNote(note, "revised", author, 2000);
    expect(latestNoteVersion(edited).author).toEqual(author);
  });
});

describe("promoteNote", () => {
  it("sets promotedAt once", () => {
    const note = createNote("n1", "hello", humanAuthor, 1000);
    const promoted = promoteNote(note, 5000);
    expect(promoted.promotedAt).toBe(5000);
  });

  it("is idempotent: an already-promoted note keeps its original timestamp", () => {
    const note = promoteNote(
      createNote("n1", "hello", humanAuthor, 1000),
      5000,
    );
    const again = promoteNote(note, 9999);
    expect(again.promotedAt).toBe(5000);
  });
});

describe("isDrifted", () => {
  it("is false when the consumer read the latest version", () => {
    const note = createNote("n1", "hello", humanAuthor, 1000);
    expect(isDrifted(note, 1)).toBe(false);
  });

  it("is true once a newer version exists", () => {
    const note = editNote(
      createNote("n1", "hello", humanAuthor, 1000),
      "v2",
      humanAuthor,
      2000,
    );
    expect(isDrifted(note, 1)).toBe(true);
    expect(isDrifted(note, 2)).toBe(false);
  });
});
