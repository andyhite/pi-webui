import { describe, expect, it } from "vitest";

import { humanAuthor, sessionAuthor } from "../author.js";
import {
  newEdgeId,
  newNodeId,
  newObjectId,
  newSessionId,
  newWorkstreamId,
} from "../ids.js";
import {
  deriveHandoffBrief,
  draftHandoffBrief,
  planHandoff,
  reviewHandoffBrief,
  type DraftedHandoffBrief,
} from "./handoff.js";
import { makeLaunchChoices, makeTranscript, makeTurn } from "./testing.js";

const source = newSessionId();

function draft(
  text = "The parser is fine; the bug is in the writer.",
): DraftedHandoffBrief {
  return draftHandoffBrief({
    id: "brief-1",
    sourceSessionId: source,
    text,
    draftedBy: sessionAuthor(source),
    at: 1_000,
  });
}

function request() {
  return {
    ids: {
      sessionId: newSessionId(),
      objectId: newObjectId(),
      nodeId: newNodeId(),
      edgeId: newEdgeId(),
    },
    workstreamId: newWorkstreamId(),
    targetNodeId: newNodeId(),
    launch: makeLaunchChoices(),
    ordinal: 1,
    at: 3_000,
  };
}

describe("the source session writes the brief (§6.3)", () => {
  it("records who wrote it and that the session wrote it", () => {
    const brief = draft();

    expect(brief.state).toBe("drafted");
    expect(brief.origin).toBe("session-written");
    expect(brief.draftedBy).toEqual({ kind: "session", sessionId: source });
  });

  it("derives one from the record when the session never wrote one, and says so", () => {
    const transcript = makeTranscript({
      sessionId: source,
      turns: [
        makeTurn({
          ordinal: 1,
          entries: [
            { kind: "tool-call", callId: "c1", toolName: "read", input: "{}" },
            { kind: "output", text: "the writer drops the last frame" },
          ],
        }),
      ],
    });

    const brief = deriveHandoffBrief({ id: "brief-2", transcript, at: 2_000 });

    expect(brief.origin).toBe("derived");
    // Nobody authored a derivation, and `Author` has no variant for nobody.
    expect(brief.draftedBy).toBeNull();
    expect(brief.text).toContain(
      "derived from the source session's own record",
    );
    expect(brief.text).toContain("Tools used: read");
    expect(brief.text).toContain("the writer drops the last frame");
  });
});

describe("the human edits before it is sent (§6.3)", () => {
  it("promotes a draft to reviewed, recording whether it changed", () => {
    const unchanged = reviewHandoffBrief(draft(), {
      by: humanAuthor,
      at: 2_000,
    });
    expect(unchanged.ok).toBe(true);
    if (!unchanged.ok) return;
    expect(unchanged.value.state).toBe("reviewed");
    expect(unchanged.value.edited).toBe(false);

    const edited = reviewHandoffBrief(draft(), {
      text: "Start from the writer. The parser is a red herring.",
      by: humanAuthor,
      at: 2_000,
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.edited).toBe(true);
    expect(edited.value.draftText).toContain("The parser is fine");
  });

  it("refuses a session reviewing the brief it wrote", () => {
    const reviewed = reviewHandoffBrief(draft(), {
      by: sessionAuthor(source),
      at: 2_000,
    });

    expect(reviewed.ok).toBe(false);
    if (reviewed.ok) return;
    expect(reviewed.refusal.reason).toBe("human_only");
  });

  it("refuses an empty brief", () => {
    const reviewed = reviewHandoffBrief(draft("   "), {
      by: humanAuthor,
      at: 2_000,
    });

    expect(reviewed.ok).toBe(false);
    if (reviewed.ok) return;
    expect(reviewed.refusal.reason).toBe("empty_brief");
  });

  it("refuses a second review", () => {
    const first = reviewHandoffBrief(draft(), { by: humanAuthor, at: 2_000 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = reviewHandoffBrief(first.value, {
      by: humanAuthor,
      at: 2_100,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.refusal.reason).toBe("already_reviewed");
  });

  it("cannot send an unreviewed brief at all", () => {
    // The structural half: `planHandoff` takes a `ReviewedHandoffBrief`, so a
    // draft does not typecheck. If this ever compiles, the directive becomes an
    // unused-directive error and this file fails to build.
    // Never invoked: the assertion is that it does not compile.
    // @ts-expect-error a handoff sends a brief the human reviewed (§6.3)
    const sent = () => planHandoff(draft(), request());
    expect(typeof sent).toBe("function");
  });
});

describe("the brief becomes graph content, authored by whoever sent it", () => {
  it("plans the content, the context edge, and the provenance", () => {
    const reviewed = reviewHandoffBrief(draft(), {
      by: humanAuthor,
      at: 2_000,
    });
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;

    const input = request();
    const plan = planHandoff(reviewed.value, input);

    expect(plan.content.body).toContain("The parser is fine");
    expect(plan.content.title).toContain("handoff:");
    expect(plan.edge).toMatchObject({
      kind: "context",
      from: input.ids.nodeId,
      to: input.targetNodeId,
      // The reviewer is the author: the human decided this session should know it.
      author: { kind: "human" },
      ordinal: 1,
    });
    expect(plan.provenance).toEqual({
      relation: "session_handoff",
      fromSessionId: source,
      toSessionId: input.ids.sessionId,
      recordedAt: 3_000,
    });
    expect(plan.session.initiatedBy).toEqual(humanAuthor);
  });
});
