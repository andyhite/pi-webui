/**
 * Streaming announcements (§11: "streaming text announces on start and
 * completion rather than per token"). The rule is a state machine over what
 * the transcript currently is, not a side effect at the place tokens arrive:
 * a live region fed every token is unusable, and one fed nothing at all
 * leaves a screen-reader user unable to tell that anything is happening.
 *
 * Pure, so the discipline is provable without a DOM: feed it successive
 * observations and assert that N growing frames produce exactly two
 * announcements — one at the start, one at the finish.
 */

/** What a surface knows about the stream right now. */
export interface StreamState {
  /** True while text is still arriving (the session's own busy fact). */
  readonly streaming: boolean;
  /** Which stream this is (a turn ordinal, a session id) — a change restarts. */
  readonly streamId: string;
}

export interface StreamAnnouncementState {
  /** The stream currently announced as started, or null. */
  readonly announcedStreamId: string | null;
}

export const EMPTY_STREAM_ANNOUNCEMENT_STATE: StreamAnnouncementState = {
  announcedStreamId: null,
};

export interface StreamAnnouncement {
  readonly kind: "started" | "completed";
  readonly message: string;
}

/**
 * The announcement this observation should make, if any, plus the state to
 * carry forward. Edge-triggered on both ends: a stream that keeps streaming
 * announces nothing, and a stream that already finished announces nothing
 * again — the same discipline the attention notifications use
 * (`attention/notifications.ts`), for the same reason.
 */
export function nextStreamAnnouncement(
  state: StreamAnnouncementState,
  observation: StreamState,
  label: string,
): {
  readonly announcement: StreamAnnouncement | null;
  readonly state: StreamAnnouncementState;
} {
  if (observation.streaming) {
    if (state.announcedStreamId === observation.streamId) {
      return { announcement: null, state };
    }
    return {
      announcement: { kind: "started", message: `${label} started` },
      state: { announcedStreamId: observation.streamId },
    };
  }
  if (state.announcedStreamId === null) {
    return { announcement: null, state };
  }
  return {
    announcement: { kind: "completed", message: `${label} complete` },
    state: EMPTY_STREAM_ANNOUNCEMENT_STATE,
  };
}
