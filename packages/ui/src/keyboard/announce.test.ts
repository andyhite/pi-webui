import { describe, expect, it } from "vitest";

import type { StreamAnnouncementState } from "./announce.js";
import {
  EMPTY_STREAM_ANNOUNCEMENT_STATE,
  nextStreamAnnouncement,
} from "./announce.js";

function fold(
  observations: readonly { streaming: boolean; streamId: string }[],
): readonly string[] {
  let state: StreamAnnouncementState = EMPTY_STREAM_ANNOUNCEMENT_STATE;
  const announced: string[] = [];
  for (const observation of observations) {
    const result = nextStreamAnnouncement(state, observation, "response");
    state = result.state;
    if (result.announcement) announced.push(result.announcement.message);
  }
  return announced;
}

describe("nextStreamAnnouncement", () => {
  it("announces the start once and the completion once — never per token", () => {
    // Six observations of one growing stream: the token-by-token frames the
    // transcript subscription really produces.
    expect(
      fold([
        { streaming: true, streamId: "turn-1" },
        { streaming: true, streamId: "turn-1" },
        { streaming: true, streamId: "turn-1" },
        { streaming: true, streamId: "turn-1" },
        { streaming: false, streamId: "turn-1" },
        { streaming: false, streamId: "turn-1" },
      ]),
    ).toEqual(["response started", "response complete"]);
  });

  it("announces nothing at all for a stream that never started", () => {
    expect(
      fold([
        { streaming: false, streamId: "turn-1" },
        { streaming: false, streamId: "turn-1" },
      ]),
    ).toEqual([]);
  });

  it("starts again for the next stream — a new turn is a new announcement", () => {
    expect(
      fold([
        { streaming: true, streamId: "turn-1" },
        { streaming: false, streamId: "turn-1" },
        { streaming: true, streamId: "turn-2" },
        { streaming: false, streamId: "turn-2" },
      ]),
    ).toEqual([
      "response started",
      "response complete",
      "response started",
      "response complete",
    ]);
  });

  it("announces a start when the stream id changes mid-stream, without a spurious completion", () => {
    expect(
      fold([
        { streaming: true, streamId: "turn-1" },
        { streaming: true, streamId: "turn-2" },
      ]),
    ).toEqual(["response started", "response started"]);
  });

  it("carries the label it was given, so the surface names its own stream", () => {
    const { announcement } = nextStreamAnnouncement(
      EMPTY_STREAM_ANNOUNCEMENT_STATE,
      { streaming: true, streamId: "s" },
      "transcript",
    );
    expect(announcement).toEqual({
      kind: "started",
      message: "transcript started",
    });
  });
});
