/**
 * The session data seam (Epic 5.1). The Conversation panel is fed by a
 * `SessionDataSource`, never by fixtures directly — the same pattern
 * `data-source/types.ts` established for the canvas (`GraphDataSource`).
 *
 * Stage 2: `createApiSessionDataSource` is the live implementation, over
 * Track A's run spine (`GET /api/sessions(/:id, /transcript)` plus `/ws`).
 * Stage 1's parallel `SessionListEvent`/`TranscriptEvent` envelope is gone —
 * `SessionDetail` is derived straight from `@plotroom/core`'s `DomainEvent`
 * "session" variant (one vocabulary, not two; principle 8). A session's
 * transcript has no snapshot-level `seq` of its own the way the whole board
 * does (`GET /api/sessions/:id/transcript` returns no `seq`), so
 * `subscribeTranscript` uses a simpler, still-correct rule instead of the
 * board's buffer-then-merge recipe: every relevant `/ws` event triggers a
 * refetch of that endpoint, which is already a coalesced, idempotent
 * whole-document read — never an incremental diff this client assembles
 * itself — so an occasional extra or slightly-delayed refetch is harmless.
 * `subscribeSession`, by contrast, *does* reuse the board's exact recipe
 * (connect first, buffer, a seq-stamped snapshot, drop what it already
 * reflects, apply the rest, redo the whole thing on reconnect), scoped to
 * the snapshot's own `sessions` array.
 *
 * `createFixtureSessionDataSource` stays for tests and dev-offline, behind
 * the identical interface — including a scripted streaming playback so the
 * composer/status header are exercisable without a live runtime.
 */

import {
  phaseFacts,
  type DomainEvent,
  type ReleaseMarker,
  type Session,
  type SessionId,
  type SessionPhase,
  type SessionStatus,
  type Transcript,
  type TranscriptTurn,
} from "@plotroom/core";

import type { HttpClient } from "../transport/http.js";
import type { WebSocketFactory } from "../transport/ws.js";
import { createReconnectingSocket } from "../transport/ws.js";
import type { Unsubscribe } from "../data-source/types.js";
import { parseWsMessage } from "../data-source/api.js";

/** A session's record plus the phase/status PlotRoom derived (never agent-reported). */
export interface SessionDetail {
  readonly session: Session;
  readonly status: SessionStatus;
}

export interface TranscriptEvent {
  readonly sessionId: SessionId;
  /** The transcript's complete current turns — idempotent to reapply. */
  readonly transcript: Transcript;
}

export interface SessionDataSource {
  /** A one-shot, point-in-time read — no event stream involved (mirrors `GraphDataSource.load`). */
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
  /** Live session record + derived status for one session. */
  subscribeSession(
    sessionId: SessionId,
    onDetail: (detail: SessionDetail) => void,
  ): Unsubscribe;
  subscribeTranscript(
    sessionId: SessionId,
    onEvent: (event: TranscriptEvent) => void,
  ): Unsubscribe;
}

/* ------------------------------------------------------------- live (Stage 2) */

/** The shape `GET /api/sessions` returns (`apps/server/src/routes/sessions.ts`). */
interface RawSessionListEntry {
  readonly session: Session;
  readonly runId: string | null;
  readonly workspaceId: string | null;
  readonly phase: SessionPhase;
  readonly end: unknown;
}

/** The shape `GET /api/snapshot`'s `sessions` field carries \u2014 seq-stamped. */
interface RawSnapshotSessionEntry {
  readonly session: Session;
  readonly runId: string | null;
  readonly phase: SessionPhase;
}

function approximateStatus(phase: SessionPhase): SessionStatus {
  // A resync baseline has no observation log to derive health from (only
  // the phase travels with the snapshot); a live `session` event afterward
  // carries the real, server-derived `status` in full, so this is only ever
  // the answer until the next one arrives.
  return {
    phase,
    facts: phaseFacts(phase),
    health: { silentForMs: 0, possiblyStalled: false },
  };
}

interface BufferState {
  buffering: boolean;
  events: DomainEvent[];
}

export interface ApiSessionDataSourceOptions {
  readonly http: HttpClient;
  readonly createSocket: WebSocketFactory;
}

export function createApiSessionDataSource(
  options: ApiSessionDataSourceOptions,
): SessionDataSource {
  const { http, createSocket } = options;

  let sessions = new Map<string, SessionDetail>();
  let started = false;
  let currentBuffer: BufferState | null = null;
  let socket: ReturnType<typeof createReconnectingSocket> | null = null;
  const sessionListeners = new Map<
    string,
    Set<(detail: SessionDetail) => void>
  >();
  const transcriptListeners = new Map<
    string,
    Set<(event: TranscriptEvent) => void>
  >();

  function notifySession(sessionId: string): void {
    const detail = sessions.get(sessionId);
    const listeners = sessionListeners.get(sessionId);
    if (!detail || !listeners) return;
    for (const listener of listeners) listener(detail);
  }

  async function refetchTranscript(sessionId: string): Promise<void> {
    const listeners = transcriptListeners.get(sessionId);
    if (!listeners || listeners.size === 0) return;
    const transcript = await loadTranscriptOnce(http, sessionId);
    for (const listener of listeners) {
      listener({ sessionId: sessionId as SessionId, transcript });
    }
  }

  function applyBufferedEvent(event: DomainEvent): void {
    if (event.entity === "session") {
      const next = new Map(sessions);
      if (event.verb === "deleted") {
        next.delete(event.sessionId);
      } else {
        next.set(event.session.id, {
          session: event.session,
          status: event.status,
        });
      }
      sessions = next;
      notifySession(
        event.verb === "deleted" ? event.sessionId : event.session.id,
      );
      return;
    }
    if (
      event.entity === "session_observation" ||
      event.entity === "session_transcript"
    ) {
      void refetchTranscript(event.sessionId);
    }
  }

  async function resync(buffer: BufferState): Promise<void> {
    const raw = await http.get<{
      readonly seq: number;
      readonly sessions: readonly RawSnapshotSessionEntry[];
    }>("/api/snapshot");
    // A newer (re)connect already moved on to its own buffer; this resync
    // lost the race (same reasoning as the board's own recipe).
    if (currentBuffer !== buffer) return;

    sessions = new Map(
      raw.sessions.map((entry) => [
        entry.session.id,
        { session: entry.session, status: approximateStatus(entry.phase) },
      ]),
    );
    for (const event of buffer.events) {
      if (event.seq > raw.seq) applyBufferedEvent(event);
    }
    buffer.buffering = false;
    buffer.events = [];

    for (const sessionId of sessionListeners.keys()) notifySession(sessionId);
    for (const sessionId of transcriptListeners.keys()) {
      void refetchTranscript(sessionId);
    }
  }

  function ensureStarted(): void {
    if (started) return;
    started = true;

    socket = createReconnectingSocket({
      createSocket,
      onStatusChange: (status) => {
        if (status !== "open") return;
        const buffer: BufferState = { buffering: true, events: [] };
        currentBuffer = buffer;
        void resync(buffer);
      },
      onMessage: (data) => {
        const message = parseWsMessage(data);
        if (!message || message.type !== "event" || !currentBuffer) return;
        if (currentBuffer.buffering) {
          currentBuffer.events.push(message.event);
        } else {
          applyBufferedEvent(message.event);
        }
      },
    });
  }

  function stopIfIdle(): void {
    if (sessionListeners.size > 0 || transcriptListeners.size > 0) return;
    socket?.close();
    socket = null;
    started = false;
    currentBuffer = null;
    sessions = new Map();
  }

  return {
    loadList(): Promise<readonly Session[]> {
      return http
        .get<{ sessions: readonly RawSessionListEntry[] }>("/api/sessions")
        .then((response) => response.sessions.map((entry) => entry.session));
    },

    loadTranscript(sessionId: SessionId): Promise<Transcript> {
      return loadTranscriptOnce(http, sessionId);
    },

    loadReleasedContent(): Promise<string | null> {
      // §6.1's release/reload mechanism has no server implementation yet
      // (Track A's transcript route says so plainly: "nothing has been
      // released yet") — every transcript this data source reads is
      // therefore already complete, and nothing here is ever asked to
      // reload something that could exist. Honest null, not a guess.
      return Promise.resolve(null);
    },

    subscribeSession(sessionId, onDetail): Unsubscribe {
      let listeners = sessionListeners.get(sessionId);
      if (!listeners) {
        listeners = new Set();
        sessionListeners.set(sessionId, listeners);
      }
      listeners.add(onDetail);
      ensureStarted();
      const known = sessions.get(sessionId);
      if (known) onDetail(known);

      return () => {
        listeners?.delete(onDetail);
        if (listeners?.size === 0) sessionListeners.delete(sessionId);
        stopIfIdle();
      };
    },

    subscribeTranscript(sessionId, onEvent): Unsubscribe {
      let listeners = transcriptListeners.get(sessionId);
      if (!listeners) {
        listeners = new Set();
        transcriptListeners.set(sessionId, listeners);
      }
      listeners.add(onEvent);
      ensureStarted();
      void refetchTranscript(sessionId);

      return () => {
        listeners?.delete(onEvent);
        if (listeners?.size === 0) transcriptListeners.delete(sessionId);
        stopIfIdle();
      };
    },
  };
}

async function loadTranscriptOnce(
  http: HttpClient,
  sessionId: string,
): Promise<Transcript> {
  const response = await http.get<{
    readonly sessionId: string;
    readonly turns: Transcript["turns"];
  }>(`/api/sessions/${encodeURIComponent(sessionId)}/transcript`);
  return { sessionId: response.sessionId as SessionId, turns: response.turns };
}

/* -------------------------------------------------------- fixture (Stage 1/tests) */

/** One turn arriving after some delay — the scripted streaming playback. */
export interface ScriptedTurnDelivery {
  readonly sessionId: SessionId;
  readonly turn: TranscriptTurn;
  readonly delayMs: number;
}

export interface FixtureSessionDataSourceOptions {
  readonly sessions: readonly Session[];
  /** Fixture status per session; a session with none shown as `idle`, `busy: false`. */
  readonly statuses?: ReadonlyMap<SessionId, SessionStatus>;
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

const IDLE_PHASE: SessionPhase = { kind: "idle" };

function fixtureStatus(
  sessionId: SessionId,
  statuses: ReadonlyMap<SessionId, SessionStatus>,
): SessionStatus {
  return statuses.get(sessionId) ?? approximateStatus(IDLE_PHASE);
}

export function createFixtureSessionDataSource(
  options: FixtureSessionDataSourceOptions,
): SessionDataSource {
  const sessions = new Map(options.sessions.map((s) => [s.id, s]));
  const statuses = options.statuses ?? new Map<SessionId, SessionStatus>();
  const transcripts = new Map(options.transcripts);
  const script = options.script ?? [];
  const schedule =
    options.schedule ??
    ((fn: () => void, delayMs: number) => {
      setTimeout(fn, delayMs);
    });
  const releasedContent = options.releasedContent ?? new Map<string, string>();

  const sessionListeners = new Map<
    SessionId,
    Set<(detail: SessionDetail) => void>
  >();
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

    subscribeSession(sessionId, onDetail): Unsubscribe {
      let listeners = sessionListeners.get(sessionId);
      if (!listeners) {
        listeners = new Set();
        sessionListeners.set(sessionId, listeners);
      }
      listeners.add(onDetail);
      const session = sessions.get(sessionId);
      if (session) {
        onDetail({ session, status: fixtureStatus(sessionId, statuses) });
      }
      // Fixtures never change spontaneously — the same contract
      // `createFixtureGraphDataSource` gives; a real session's phase
      // changing live is entirely Stage 2's concern.
      return () => {
        listeners?.delete(onDetail);
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
