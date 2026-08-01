/**
 * Structured questions as bubbles (spec §6.4): "a session can ask the user a
 * question with selectable options; the answer returns to the session as a
 * result... Questions render as bubbles on the session node, answerable
 * inline without opening anything."
 *
 * Stage 2: `createApiQuestionDataSource` is the live implementation, over
 * Track A's steering endpoints (`GET /api/sessions`, `GET /sessions/:id/
 * questions`, `POST /questions/:id/answer`, plus the `session_question`
 * `/ws` entity — `created` for a raise, `updated` for an answer, carrying
 * `pathsNotTaken` so "unpicked options remain visible" needs no separate
 * fetch). `createFixtureQuestionDataSource` stays for tests and dev-
 * offline, behind the identical interface.
 *
 * **No timed defaults** (§6.4, principle 2): nothing here ever answers a
 * question on its own; `answerQuestion` only ever applies a caller's
 * explicit pick.
 */

import type { DomainEvent, SessionQuestion } from "@plotroom/core";

import type { HttpClient } from "../transport/http.js";
import type { WebSocketFactory } from "../transport/ws.js";
import { createReconnectingSocket } from "../transport/ws.js";
import type { Unsubscribe } from "../data-source/types.js";
import { parseWsMessage } from "../data-source/api.js";

export interface OpenQuestion {
  readonly id: string;
  /** The session node this question renders as a bubble on. */
  readonly nodeId: string;
  readonly text: string;
  readonly options: readonly string[];
  readonly raisedAt: number;
  /**
   * Set once answered. "Options not picked remain visible as paths not
   * taken" (§6.4) — answering never removes the question, it records which
   * option was picked so the others stay visible but no longer actionable.
   */
  readonly answeredValue: string | null;
}

export interface QuestionDataSource {
  listOpen(): Promise<readonly OpenQuestion[]>;
  subscribe(onChange: (open: readonly OpenQuestion[]) => void): Unsubscribe;
  /** One gesture, one answer (principle 9) — a second call on an already-answered question is a no-op. */
  answer(questionId: string, value: string): Promise<void>;
}

/**
 * Pure reducer: applies a pick to the matching question, leaving every
 * other question — and an already-answered one — untouched. Exported
 * directly so the answer flow is testable without the data source's
 * pub/sub plumbing around it.
 */
export function answerQuestion(
  questions: readonly OpenQuestion[],
  questionId: string,
  value: string,
): readonly OpenQuestion[] {
  return questions.map((question) => {
    if (question.id !== questionId) return question;
    if (question.answeredValue !== null) return question; // first answer only
    if (!question.options.includes(value)) return question; // not a real option
    return { ...question, answeredValue: value };
  });
}

export function createFixtureQuestionDataSource(
  initial: readonly OpenQuestion[],
): QuestionDataSource {
  let questions = initial;
  const listeners = new Set<(open: readonly OpenQuestion[]) => void>();

  function notify(): void {
    for (const listener of listeners) listener(questions);
  }

  return {
    listOpen(): Promise<readonly OpenQuestion[]> {
      return Promise.resolve(questions);
    },

    subscribe(onChange): Unsubscribe {
      listeners.add(onChange);
      onChange(questions);
      return () => {
        listeners.delete(onChange);
      };
    },

    answer(questionId, value): Promise<void> {
      questions = answerQuestion(questions, questionId, value);
      notify();
      return Promise.resolve();
    },
  };
}

/* ------------------------------------------------------------- live (Stage 2) */

function toOpenQuestion(question: SessionQuestion): OpenQuestion {
  return {
    id: question.id,
    nodeId: question.sessionId,
    text: question.text,
    options: question.options.map((option) => option.label),
    raisedAt: question.askedAt,
    answeredValue:
      question.answer === null
        ? null
        : (question.options.find(
            (option) => option.id === question.answer?.optionId,
          )?.label ?? question.answer.optionId),
  };
}

export interface ApiQuestionDataSourceOptions {
  readonly http: HttpClient;
  readonly createSocket: WebSocketFactory;
}

/**
 * Live over Track A's steering endpoints. There is no per-session scoping
 * here the way `SessionDataSource` has — `session_question` events name
 * their own `sessionId` inside the record, so one subscription covers every
 * session's questions at once, which is what a canvas-wide bubble layer
 * needs anyway.
 */
export function createApiQuestionDataSource(
  options: ApiQuestionDataSourceOptions,
): QuestionDataSource {
  const { http, createSocket } = options;

  let questionsById = new Map<string, SessionQuestion>();
  let started = false;
  let seeded = false;
  let socket: ReturnType<typeof createReconnectingSocket> | null = null;
  const listeners = new Set<(open: readonly OpenQuestion[]) => void>();

  function currentOpen(): readonly OpenQuestion[] {
    return [...questionsById.values()].map(toOpenQuestion);
  }

  function notify(): void {
    const open = currentOpen();
    for (const listener of listeners) listener(open);
  }

  function upsert(question: SessionQuestion): void {
    questionsById = new Map(questionsById).set(question.id, question);
    notify();
  }

  /**
   * The resync: `session_question` has no snapshot-level feed of its own
   * (unlike the board's `/api/snapshot`), so every currently-open question
   * is read by asking every session for its questions once, in parallel.
   * Always unconditional — called at first connect *and* on every
   * reconnect (`onStatusChange` below), because a socket drop can miss
   * `session_question` events the same way it can miss any other one. An
   * earlier version guarded this with a once-only flag, which made a
   * reconnect's resync a silent no-op and left `questionsById` stale for
   * the rest of the session; that guard lived here and is gone for good,
   * not just relaxed — `ensureSeeded` below is where "only once" belongs.
   */
  async function resync(): Promise<void> {
    const { sessions } = await http.get<{
      readonly sessions: readonly {
        readonly session: { readonly id: string };
      }[];
    }>("/api/sessions");

    const perSession = await Promise.all(
      sessions.map((entry) =>
        http.get<{
          readonly questions: readonly { readonly question: SessionQuestion }[];
        }>(`/api/sessions/${encodeURIComponent(entry.session.id)}/questions`),
      ),
    );

    const next = new Map(questionsById);
    for (const response of perSession) {
      for (const { question } of response.questions)
        next.set(question.id, question);
    }
    questionsById = next;
    seeded = true;
    notify();
  }

  /**
   * The one-time seed for a caller with no live socket of its own
   * (`listOpen`): fetches once and leaves whatever the socket has since
   * done — live-updated or event-driven state — alone on every later call,
   * so answering a question and then calling `listOpen` again does not get
   * clobbered by a fresh fetch racing the optimistic update.
   */
  async function ensureSeeded(): Promise<void> {
    if (seeded) return;
    await resync();
  }

  function ensureStarted(): void {
    if (started) return;
    started = true;
    void ensureSeeded();

    socket = createReconnectingSocket({
      createSocket,
      onStatusChange: (status) => {
        if (status === "open") void resync();
      },
      onMessage: (data) => {
        const message = parseWsMessage(data);
        if (!message || message.type !== "event") return;
        const event: DomainEvent = message.event;
        if (event.entity === "session_question") upsert(event.question);
      },
    });
  }

  function stopIfIdle(): void {
    if (listeners.size > 0) return;
    socket?.close();
    socket = null;
    started = false;
    seeded = false;
    questionsById = new Map();
  }

  return {
    listOpen(): Promise<readonly OpenQuestion[]> {
      return ensureSeeded().then(currentOpen);
    },

    subscribe(onChange): Unsubscribe {
      listeners.add(onChange);
      ensureStarted();
      onChange(currentOpen());

      return () => {
        listeners.delete(onChange);
        stopIfIdle();
      };
    },

    async answer(questionId, value): Promise<void> {
      const question = questionsById.get(questionId);
      const option = question?.options.find((o) => o.label === value);
      if (!option) return; // not a real option — the bubble only ever offers real labels

      const response = await http.post<{ question: SessionQuestion }>(
        `/api/questions/${encodeURIComponent(questionId)}/answer`,
        { optionId: option.id },
      );
      upsert(response.question);
    },
  };
}
