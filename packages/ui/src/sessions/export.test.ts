import { describe, expect, it } from "vitest";
import type { Transcript } from "@plotroom/core";

import { exportIncompleteMessage, exportTranscriptAsync } from "./export.js";

function transcriptWithReleased(): Transcript {
  return {
    sessionId: "sess_1" as Transcript["sessionId"],
    turns: [
      {
        ordinal: 1,
        startedAt: 1,
        entries: [{ kind: "output", text: "starting" }],
      },
      {
        ordinal: 2,
        startedAt: 2,
        entries: [
          {
            kind: "tool-result",
            callId: "call-1",
            toolName: "bash",
            output: "",
            isError: false,
            released: { releasedAt: 5, bytes: 100, contentHash: "hash-1" },
          },
        ],
      },
    ],
  };
}

describe("exportTranscriptAsync", () => {
  it("rehydrates released content asynchronously and reports complete", async () => {
    const result = await exportTranscriptAsync(
      transcriptWithReleased(),
      async (marker) => {
        expect(marker.contentHash).toBe("hash-1");
        return "the original tool output";
      },
    );
    expect(result.complete).toBe(true);
    expect(result.unavailable).toEqual([]);
    expect(result.document).toContain("the original tool output");
  });

  it("reports incomplete when the store cannot rehydrate a released call", async () => {
    const result = await exportTranscriptAsync(
      transcriptWithReleased(),
      async () => null,
    );
    expect(result.complete).toBe(false);
    expect(result.unavailable).toEqual(["call-1"]);
  });

  it("passes through an already-complete transcript with no released content", async () => {
    const transcript: Transcript = {
      sessionId: "sess_1" as Transcript["sessionId"],
      turns: [
        { ordinal: 1, startedAt: 1, entries: [{ kind: "output", text: "hi" }] },
      ],
    };
    const result = await exportTranscriptAsync(transcript, async () => null);
    expect(result.complete).toBe(true);
    expect(result.document).toContain("hi");
  });

  it("never drops the whole export down to just its document (§6.1, principle 12)", async () => {
    // The Conversation panel must keep `complete`/`unavailable` alongside
    // `document`, not just the string — exercised here at the data level
    // the panel's state is built from.
    const result = await exportTranscriptAsync(
      transcriptWithReleased(),
      async () => null,
    );
    expect(result).toEqual({
      document: expect.any(String),
      complete: false,
      unavailable: ["call-1"],
    });
  });
});

describe("exportIncompleteMessage", () => {
  it("names every call id an incomplete export could not reload", () => {
    expect(exportIncompleteMessage(["call-1"])).toBe(
      "export incomplete: could not reload call-1",
    );
  });

  it("lists multiple unreloadable call ids", () => {
    expect(exportIncompleteMessage(["call-1", "call-2"])).toBe(
      "export incomplete: could not reload call-1, call-2",
    );
  });

  it("still returns a sane message for an empty list", () => {
    expect(exportIncompleteMessage([])).toBe(
      "export incomplete: could not reload ",
    );
  });
});
