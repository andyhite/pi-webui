import { describe, expect, it } from "vitest";

import { humanAuthor } from "../author.js";
import {
  applyRelease,
  exportTranscript,
  planRelease,
  releasedMarkers,
  restoreReleased,
  transcriptBytes,
  transcriptDelta,
  transcriptRenderings,
  type Transcript,
} from "./transcript.js";
import {
  consumersDrift,
  INITIAL_PUBLICATION_STATE,
  reduceTranscriptPublication,
} from "./checkpoint.js";
import { makeTranscript, makeTurn } from "./testing.js";

const BIG = "x".repeat(4_000);
const SMALL = "y".repeat(100);

function transcriptWithToolOutputs(): Transcript {
  return makeTranscript({
    turns: [
      makeTurn({
        ordinal: 1,
        entries: [
          { kind: "output", text: "starting" },
          {
            kind: "tool-result",
            callId: "call-big",
            toolName: "bash",
            output: BIG,
            isError: false,
            released: null,
          },
        ],
      }),
      makeTurn({
        ordinal: 2,
        entries: [
          {
            kind: "tool-result",
            callId: "call-small",
            toolName: "read",
            output: SMALL,
            isError: false,
            released: null,
          },
          {
            kind: "injection",
            injectionId: "inj-1",
            author: humanAuthor,
            text: "the answer is in docs/architecture.md",
          },
        ],
      }),
      makeTurn({
        ordinal: 3,
        entries: [
          {
            kind: "tool-result",
            callId: "call-newest",
            toolName: "bash",
            output: BIG,
            isError: false,
            released: null,
          },
        ],
      }),
    ],
  });
}

describe("the transcript as content (§3.6)", () => {
  it("renders three ways, like every other object", () => {
    const renderings = transcriptRenderings(transcriptWithToolOutputs());

    expect(renderings.summary).toContain("3 turns");
    expect(renderings.agentContent).toContain("turn 1");
    expect(renderings.card).toMatchObject({ turns: 3 });
  });

  it("expresses its delta as new turns", () => {
    const previous = makeTranscript({ turns: [makeTurn({ ordinal: 1 })] });
    const next: Transcript = {
      ...previous,
      turns: [...previous.turns, makeTurn({ ordinal: 2 })],
    };

    const delta = transcriptDelta(previous, next);

    expect(delta?.summary).toBe("1 new turn");
    expect(delta?.body).toContain("turn 2");
    expect(delta?.body).not.toContain("turn 1");
    expect(transcriptDelta(next, next)).toBeNull();
  });
});

describe("bounded transcripts with recoverable release (§6.1)", () => {
  it("releases the largest old tool outputs first", () => {
    const transcript = transcriptWithToolOutputs();
    const plan = planRelease(transcript, 4_500);

    expect(plan.release.map((candidate) => candidate.callId)).toEqual([
      "call-big",
    ]);
    expect(plan.bytesAfter).toBeLessThan(plan.bytesBefore);
    expect(plan.withinBudget).toBe(true);
  });

  it("never releases the newest turn's output", () => {
    const transcript = transcriptWithToolOutputs();
    const plan = planRelease(transcript, 0);

    expect(plan.release.map((candidate) => candidate.callId)).not.toContain(
      "call-newest",
    );
    // Reporting the miss instead of releasing more is the point: nothing is
    // dropped to make a number fit (principle 12).
    expect(plan.withinBudget).toBe(false);
  });

  it("leaves a visible marker where content was released", () => {
    const transcript = transcriptWithToolOutputs();
    const plan = planRelease(transcript, 4_500);
    const released = applyRelease(transcript, plan, 999, () => "sha256:big");

    const markers = releasedMarkers(released);
    expect(markers).toHaveLength(1);
    expect(markers[0]?.marker).toMatchObject({
      releasedAt: 999,
      contentHash: "sha256:big",
    });
    expect(transcriptBytes(released)).toBeLessThan(transcriptBytes(transcript));
    expect(transcriptRenderings(released).agentContent).toContain("released");
  });

  it("loads released content back", () => {
    const transcript = transcriptWithToolOutputs();
    const plan = planRelease(transcript, 4_500);
    const released = applyRelease(transcript, plan, 999, () => "sha256:big");

    const restored = restoreReleased(released, "call-big", BIG);

    expect(releasedMarkers(restored)).toHaveLength(0);
    expect(transcriptBytes(restored)).toBe(transcriptBytes(transcript));
  });

  it("exports a released transcript completely", () => {
    const transcript = transcriptWithToolOutputs();
    const plan = planRelease(transcript, 4_500);
    const released = applyRelease(transcript, plan, 999, () => "sha256:big");

    const exported = exportTranscript(released, () => BIG);

    expect(exported.complete).toBe(true);
    expect(exported.unavailable).toHaveLength(0);
    expect(exported.document).toContain(BIG);
    expect(exported.document).not.toContain("released");
  });

  it("reports an export it could not complete instead of shipping a hole", () => {
    const transcript = transcriptWithToolOutputs();
    const plan = planRelease(transcript, 4_500);
    const released = applyRelease(transcript, plan, 999, () => "sha256:big");

    const exported = exportTranscript(released, () => null);

    expect(exported.complete).toBe(false);
    expect(exported.unavailable).toEqual(["call-big"]);
  });

  it("never releases what a human or an agent said", () => {
    const transcript = transcriptWithToolOutputs();
    const plan = planRelease(transcript, 0);

    const releasedIds = plan.release.map((candidate) => candidate.callId);
    expect(releasedIds).toEqual(["call-big", "call-small"]);
  });
});

describe("world-condition feedback (§3.5)", () => {
  const withFeedback = (): Transcript =>
    makeTranscript({
      turns: [
        makeTurn({
          ordinal: 1,
          entries: [
            { kind: "output", text: "submitting" },
            {
              kind: "feedback",
              source: "world-condition",
              text: "checks are not green: build failed on node 20",
              failedConditionIds: ["checks-green"],
            },
          ],
        }),
      ],
    });

  it("is a record with no author, because nobody authored it", () => {
    // The alternative was an `injection` with a system author, which would have
    // meant widening §15-2's `Author`: the schema reserves `system` for provenance
    // edges and forbids it on context edges, so that variant would let an
    // unattributed context edge typecheck everywhere else in the product.
    const entry = withFeedback().turns[0]?.entries[1];
    expect(entry?.kind).toBe("feedback");
    expect(entry && "author" in entry).toBe(false);
  });

  it("names the conditions that failed, in the record and the rendering", () => {
    const rendered = transcriptRenderings(withFeedback()).agentContent;
    expect(rendered).toContain("feedback");
    expect(rendered).toContain("checks-green");
    expect(rendered).toContain("build failed on node 20");
    // Never "[injected by human]": the label has to say what it is.
    expect(rendered).not.toContain("injected by");
  });

  it("counts toward the size budget but is never released", () => {
    const transcript = withFeedback();
    expect(transcriptBytes(transcript)).toBeGreaterThan(0);

    // Budget of zero: everything releasable would go, and feedback still does not.
    const plan = planRelease(transcript, 0);
    expect(plan.release).toEqual([]);
    expect(plan.withinBudget).toBe(false);
  });

  it("survives an export whole", () => {
    const exported = exportTranscript(withFeedback(), () => null);
    expect(exported.complete).toBe(true);
    expect(exported.document).toContain("checks-green");
  });

  it("publishes on checkpoint like any other turn content", () => {
    // The checkpoint rule is about turns, not entry kinds, so feedback changes
    // nothing about when consumers drift (§3.6) — asserted so a future entry kind
    // cannot quietly acquire a publication rule of its own.
    const afterTurn = reduceTranscriptPublication(INITIAL_PUBLICATION_STATE, {
      kind: "turn-ended",
      at: 10,
      turn: 1,
    });
    expect(afterTurn.pendingTurns).toBe(1);

    const published = reduceTranscriptPublication(afterTurn, {
      kind: "checkpoint",
      at: 20,
      by: humanAuthor,
    });
    expect(published.publishedThroughTurn).toBe(1);
    expect(consumersDrift(published, 0)).toBe(true);
  });
});
