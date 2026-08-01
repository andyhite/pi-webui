/**
 * Structured questions as bubbles (spec §6.4): "a session can ask the user a
 * question with selectable options; the answer returns to the session as a
 * result... Questions render as bubbles on the session node, answerable
 * inline without opening anything." Core's `RuntimeRequest` already states
 * the question/answer shape (`{ kind: "question", text, options }` /
 * `{ kind: "answer", value }`, `sessions/runtime.ts`) — `OpenQuestion` below
 * is exactly that, addressed by a stable id, so this seam is ready to be
 * fed by a real observation stream without changing shape.
 *
 * No stream in this codebase carries an open question yet: `SessionStatus`
 * only exposes the *derived phase* (`waiting-input`), never the
 * `RuntimeRequest` behind it, and no server endpoint answers one (Track A/C,
 * Batch 3). `createFixtureQuestionDataSource` is therefore the only
 * implementation today — the same "fixture behind the real interface"
 * pattern `createFixtureSessionDataSource` already established, so a live
 * `createApiQuestionDataSource` is a pure swap once the stream exists.
 *
 * **No timed defaults** (§6.4, principle 2): nothing here ever answers a
 * question on its own; `answerQuestion` only ever applies a caller's
 * explicit pick.
 */

import type { Unsubscribe } from "../data-source/types.js";

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
