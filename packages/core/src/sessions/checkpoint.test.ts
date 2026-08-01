import { describe, expect, it } from "vitest";

import { humanAuthor, sessionAuthor } from "../author.js";
import { newSessionId } from "../ids.js";
import {
  INITIAL_PUBLICATION_STATE,
  consumersDrift,
  latestPublication,
  publishesVersion,
  reduceTranscriptPublication,
  type TranscriptEvent,
} from "./checkpoint.js";

function replay(events: readonly TranscriptEvent[]) {
  return events.reduce(reduceTranscriptPublication, INITIAL_PUBLICATION_STATE);
}

const turn = (n: number): TranscriptEvent => ({
  kind: "turn-ended",
  at: 100 + n,
  turn: n,
});

describe("the live-transcript checkpoint rule (§3.6)", () => {
  it("never publishes on a turn", () => {
    expect(publishesVersion(turn(1))).toBe(false);
    expect(
      publishesVersion({ kind: "checkpoint", at: 1, by: humanAuthor }),
    ).toBe(true);
    expect(
      publishesVersion({
        kind: "session-ended",
        at: 1,
        end: { kind: "completed", at: 1 },
      }),
    ).toBe(true);
  });

  it("leaves consumers undrifted across any number of turns", () => {
    const state = replay([turn(1), turn(2), turn(3), turn(4)]);

    expect(state.publications).toHaveLength(0);
    expect(state.pendingTurns).toBe(4);
    expect(consumersDrift(state, 0)).toBe(false);
  });

  it("drifts consumers on an explicit checkpoint", () => {
    const state = replay([
      turn(1),
      turn(2),
      { kind: "checkpoint", at: 500, by: humanAuthor },
    ]);

    expect(state.publications).toHaveLength(1);
    expect(latestPublication(state)?.throughTurn).toBe(2);
    expect(latestPublication(state)?.trigger).toBe("checkpoint");
    expect(consumersDrift(state, 0)).toBe(true);
    expect(consumersDrift(state, 1)).toBe(false);
  });

  it("lets the session itself checkpoint (§3.6)", () => {
    const author = sessionAuthor(newSessionId());
    const state = replay([
      turn(1),
      { kind: "checkpoint", at: 500, by: author },
    ]);

    expect(latestPublication(state)?.by).toEqual(author);
  });

  it("drifts consumers when the session ends", () => {
    const state = replay([
      turn(1),
      turn(2),
      {
        kind: "session-ended",
        at: 900,
        end: { kind: "interrupted", message: "restart", at: 900 },
      },
    ]);

    expect(state.publications).toHaveLength(1);
    expect(latestPublication(state)?.trigger).toBe("session-end");
    expect(state.ended).toBe(true);
  });

  it("publishes nothing when a checkpoint has nothing to publish", () => {
    const state = replay([
      turn(1),
      { kind: "checkpoint", at: 300, by: humanAuthor },
      { kind: "checkpoint", at: 400, by: humanAuthor },
    ]);

    expect(state.publications).toHaveLength(1);
  });

  it("publishes turns that arrived after the last checkpoint", () => {
    const state = replay([
      turn(1),
      { kind: "checkpoint", at: 300, by: humanAuthor },
      turn(2),
      turn(3),
      { kind: "checkpoint", at: 600, by: humanAuthor },
    ]);

    expect(state.publications.map((p) => p.throughTurn)).toEqual([1, 3]);
    expect(state.publications.map((p) => p.ordinal)).toEqual([1, 2]);
  });
});
