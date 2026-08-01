/**
 * The session data seam (Epic 5.1, Stage 1 of 2): the Conversation panel is
 * fed by a `SessionDataSource`, never by fixtures directly — the exact
 * pattern `data-source/types.ts` established for the canvas
 * (`GraphDataSource`). No sessions server API exists yet (Track A, in
 * parallel); `createFixtureSessionDataSource` is the fixture implementation
 * with a scripted streaming playback for dev/tests, so Stage 2 only swaps
 * which factory is constructed — nothing that consumes `SessionDataSource`
 * changes.
 *
 * Event shapes mirror `@plotroom/core`'s `DomainEvent` vocabulary
 * (`events.ts`): full-entity, idempotent apply — "created"/"updated" carry
 * the whole thing, "deleted" carries only the id. `DomainEvent` already
 * defines a `"session"` entity (created/updated/deleted over the whole
 * `Session`); `SessionListEvent` here is that exact shape, scoped to this
 * seam rather than routed through the board's `applyEvent`. Turn-by-turn
 * transcript streaming has **no** `DomainEvent` shape yet — turns arrive far
 * more often than a graph mutation, and Track A has not designed that
 * stream — so `TranscriptEvent` is this track's proposed shape, following
 * the same full-entity rule: each message carries the transcript's complete
 * current turns, never a partial diff. See the seam report for what Stage 2
 * needs to confirm this against the real API.
 */

import type {
  ReleaseMarker,
  Session,
  SessionId,
  Transcript,
  TranscriptTurn,
} from "@plotroom/core";

import type { Unsubscribe } from "../data-source/types.js";

export type SessionListEvent =
  | { readonly verb: "created" | "updated"; readonly session: Session }
  | { readonly verb: "deleted"; readonly sessionId: SessionId };

export interface TranscriptEvent {
  readonly sessionId: SessionId;
  /** The transcript's complete current turns — idempotent to reapply. */
  readonly transcript: Transcript;
}

export interface SessionDataSource {
  loadList(): Promise<readonly Session[]>;
  loadTranscript(sessionId: SessionId): Promise<Transcript>;
  /**
   * Reload content a release marker stands in for (§6.1's "a way to load it
   * back"). Null means the store could not rehydrate it — reported to the
   * caller, never papered over (principle 12) — the same contract
   * `exportTranscript`'s loader already has in `@plotroom/core`.
   */
  loadReleasedContent(
    sessionId: SessionId,
    callId: string,
    marker: ReleaseMarker,
  ): Promise<string | null>;
  subscribeList(onEvent: (event: SessionListEvent) => void): Unsubscribe;
  subscribeTranscript(
    sessionId: SessionId,
    onEvent: (event: TranscriptEvent) => void,
  ): Unsubscribe;
}

/** One turn arriving after some delay — the scripted streaming playback. */
export interface ScriptedTurnDelivery {
  readonly sessionId: SessionId;
  readonly turn: TranscriptTurn;
  readonly delayMs: number;
}

export interface FixtureSessionDataSourceOptions {
  readonly sessions: readonly Session[];
  readonly transcripts: ReadonlyMap<SessionId, Transcript>;
  /**
   * Turns delivered, in order, each `delayMs` after the previous one starts
   * counting from the moment a session's transcript is first subscribed to
   * — dev/tests exercise the composer and status header without a live
   * runtime. Absent or empty: the transcript never changes on its own.
   */
  readonly script?: readonly ScriptedTurnDelivery[];
  /** Injectable so tests drive playback without real timers. */
  readonly schedule?: (fn: () => void, delayMs: number) => void;
  /** Keyed `${sessionId}:${callId}` — what `loadReleasedContent` returns. */
  readonly releasedContent?: ReadonlyMap<string, string>;
}

function emptyTranscriptFor(sessionId: SessionId): Transcript {
  return { sessionId, turns: [] };
}

export function createFixtureSessionDataSource(
  options: FixtureSessionDataSourceOptions,
): SessionDataSource {
  const sessions = new Map(options.sessions.map((s) => [s.id, s]));
  const transcripts = new Map(options.transcripts);
  const script = options.script ?? [];
  const schedule =
    options.schedule ??
    ((fn: () => void, delayMs: number) => {
      setTimeout(fn, delayMs);
    });
  const releasedContent = options.releasedContent ?? new Map<string, string>();

  const listListeners = new Set<(event: SessionListEvent) => void>();
  const transcriptListeners = new Map<
    SessionId,
    Set<(event: TranscriptEvent) => void>
  >();
  const playbackStarted = new Set<SessionId>();

  function emitTranscript(sessionId: SessionId): void {
    const transcript =
      transcripts.get(sessionId) ?? emptyTranscriptFor(sessionId);
    const listeners = transcriptListeners.get(sessionId);
    if (!listeners) return;
    for (const listener of listeners) listener({ sessionId, transcript });
  }

  function startPlayback(sessionId: SessionId): void {
    if (playbackStarted.has(sessionId)) return;
    playbackStarted.add(sessionId);

    const deliveries = script.filter((d) => d.sessionId === sessionId);
    for (const delivery of deliveries) {
      schedule(() => {
        const current =
          transcripts.get(sessionId) ?? emptyTranscriptFor(sessionId);
        transcripts.set(sessionId, {
          ...current,
          turns: [...current.turns, delivery.turn],
        });
        emitTranscript(sessionId);
      }, delivery.delayMs);
    }
  }

  return {
    loadList(): Promise<readonly Session[]> {
      return Promise.resolve([...sessions.values()]);
    },

    loadTranscript(sessionId: SessionId): Promise<Transcript> {
      return Promise.resolve(
        transcripts.get(sessionId) ?? emptyTranscriptFor(sessionId),
      );
    },

    loadReleasedContent(
      sessionId: SessionId,
      callId: string,
    ): Promise<string | null> {
      return Promise.resolve(
        releasedContent.get(`${sessionId}:${callId}`) ?? null,
      );
    },

    // Fixtures never change spontaneously — the same contract
    // `createFixtureGraphDataSource` gives; a real session ending or being
    // created live is entirely Stage 2's concern. Kept as a real
    // subscription (not a no-op) so a caller can still register/unregister
    // safely and so `listListeners` documents the shape Stage 2 fills in.
    subscribeList(onEvent): Unsubscribe {
      listListeners.add(onEvent);
      return () => {
        listListeners.delete(onEvent);
      };
    },

    subscribeTranscript(sessionId, onEvent): Unsubscribe {
      let listeners = transcriptListeners.get(sessionId);
      if (!listeners) {
        listeners = new Set();
        transcriptListeners.set(sessionId, listeners);
      }
      listeners.add(onEvent);
      // A subscriber joining an already-playing session gets the current
      // picture immediately, the same "late subscriber" guarantee
      // `createApiGraphDataSource` gives.
      onEvent({
        sessionId,
        transcript: transcripts.get(sessionId) ?? emptyTranscriptFor(sessionId),
      });
      startPlayback(sessionId);

      return () => {
        listeners?.delete(onEvent);
      };
    },
  };
}
