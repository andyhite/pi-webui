import { describe, expect, it } from "vitest";
import { humanAuthor } from "@plotroom/core";
import type { Transcript } from "@plotroom/core";

import { buildTranscriptView } from "./transcript-view.js";

function transcript(): Transcript {
  return {
    sessionId: "sess_1" as Transcript["sessionId"],
    turns: [
      {
        ordinal: 1,
        startedAt: 1_000,
        entries: [
          { kind: "reasoning", text: "thinking it over" },
          { kind: "output", text: "here is my answer" },
          {
            kind: "tool-call",
            callId: "call-1",
            toolName: "bash",
            input: "ls",
          },
          {
            kind: "tool-result",
            callId: "call-1",
            toolName: "bash",
            output: "file.txt",
            isError: false,
            released: null,
          },
          {
            kind: "injection",
            injectionId: "inj-1",
            author: humanAuthor,
            text: "steer here",
          },
        ],
      },
    ],
  };
}

describe("buildTranscriptView", () => {
  it("keeps reasoning and output as distinct item kinds", () => {
    const [turn] = buildTranscriptView(transcript());
    expect(turn?.items[0]).toEqual({
      kind: "reasoning",
      text: "thinking it over",
    });
    expect(turn?.items[1]).toEqual({
      kind: "output",
      text: "here is my answer",
    });
  });

  it("pairs a tool call with its result into one item", () => {
    const [turn] = buildTranscriptView(transcript());
    const toolItem = turn?.items.find((item) => item.kind === "tool-call");
    expect(toolItem).toEqual({
      kind: "tool-call",
      callId: "call-1",
      toolName: "bash",
      input: "ls",
      result: { output: "file.txt", isError: false, released: null },
    });
  });

  it("carries injected content as its own kind, attributed", () => {
    const [turn] = buildTranscriptView(transcript());
    expect(turn?.items.at(-1)).toEqual({
      kind: "injection",
      author: humanAuthor,
      text: "steer here",
    });
  });

  it("renders a still-running tool call with a null result", () => {
    const running: Transcript = {
      sessionId: "sess_1" as Transcript["sessionId"],
      turns: [
        {
          ordinal: 1,
          startedAt: 1_000,
          entries: [
            {
              kind: "tool-call",
              callId: "call-2",
              toolName: "read",
              input: "file.txt",
            },
          ],
        },
      ],
    };
    const [turn] = buildTranscriptView(running);
    expect(turn?.items[0]).toEqual({
      kind: "tool-call",
      callId: "call-2",
      toolName: "read",
      input: "file.txt",
      result: null,
    });
  });

  it("never drops a result that arrives with no matching call (principle 12)", () => {
    const orphan: Transcript = {
      sessionId: "sess_1" as Transcript["sessionId"],
      turns: [
        {
          ordinal: 1,
          startedAt: 1_000,
          entries: [
            {
              kind: "tool-result",
              callId: "call-orphan",
              toolName: "bash",
              output: "surprise",
              isError: false,
              released: null,
            },
          ],
        },
      ],
    };
    const [turn] = buildTranscriptView(orphan);
    expect(turn?.items).toHaveLength(1);
    expect(turn?.items[0]).toMatchObject({
      kind: "tool-call",
      callId: "call-orphan",
      result: { output: "surprise" },
    });
  });

  it("marks a released tool result with its marker (§6.1)", () => {
    const released: Transcript = {
      sessionId: "sess_1" as Transcript["sessionId"],
      turns: [
        {
          ordinal: 1,
          startedAt: 1_000,
          entries: [
            {
              kind: "tool-call",
              callId: "call-3",
              toolName: "bash",
              input: "cat big.log",
            },
            {
              kind: "tool-result",
              callId: "call-3",
              toolName: "bash",
              output: "",
              isError: false,
              released: {
                releasedAt: 2_000,
                bytes: 4_000,
                contentHash: "hash-abc",
              },
            },
          ],
        },
      ],
    };
    const [turn] = buildTranscriptView(released);
    const item = turn?.items[0];
    expect(item?.kind === "tool-call" && item.result?.released).toEqual({
      releasedAt: 2_000,
      bytes: 4_000,
      contentHash: "hash-abc",
    });
  });

  it("preserves turn ordinal and startedAt", () => {
    const [turn] = buildTranscriptView(transcript());
    expect(turn?.ordinal).toBe(1);
    expect(turn?.startedAt).toBe(1_000);
  });
});
