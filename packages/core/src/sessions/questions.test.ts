import { describe, expect, it } from "vitest";

import { humanAuthor, sessionAuthor } from "../author.js";
import { newSessionId } from "../ids.js";
import {
  answerQuestion,
  encodeQuestionAnswer,
  escalateAfter,
  isAnswered,
  optionsFromLabels,
  pathsNotTaken,
  pickedOption,
  questionAttention,
  questionOutcome,
  raiseQuestion,
  type QuestionAttention,
  type RaiseQuestionInput,
  type SessionQuestion,
} from "./questions.js";

const SESSION = newSessionId();

function ask(overrides: Partial<RaiseQuestionInput> = {}): SessionQuestion {
  const raised = raiseQuestion({
    id: "q-1",
    sessionId: SESSION,
    text: "the migration needs a decision",
    options: optionsFromLabels(["rebuild the table", "add a column"]),
    at: 1_000,
    ...overrides,
  });
  if (!raised.ok) throw new Error(raised.refusal.message);
  return raised.value;
}

describe("raising a structured question (§6.4)", () => {
  it("requires selectable options, because prose is not a question", () => {
    const raised = raiseQuestion({
      id: "q-0",
      sessionId: SESSION,
      text: "what now?",
      options: [],
      at: 1_000,
    });

    expect(raised.ok).toBe(false);
    if (raised.ok) return;
    expect(raised.refusal.reason).toBe("no_options");
  });

  it("refuses two options with the same id", () => {
    const raised = raiseQuestion({
      id: "q-0",
      sessionId: SESSION,
      text: "pick",
      options: [
        { id: "same", label: "a", detail: null },
        { id: "same", label: "b", detail: null },
      ],
      at: 1_000,
    });

    expect(raised.ok).toBe(false);
    if (raised.ok) return;
    expect(raised.refusal.reason).toBe("duplicate_option");
  });

  it("defaults to options-only: free-form is opt-in", () => {
    expect(ask().freeForm).toBe("none");
  });
});

describe("answering returns structurally, and only a human answers", () => {
  it("returns the picked option as a machine-readable result", () => {
    const answered = answerQuestion(ask(), {
      optionId: "opt-2",
      by: humanAuthor,
      at: 2_000,
    });

    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    expect(isAnswered(answered.value)).toBe(true);
    expect(pickedOption(answered.value)?.label).toBe("add a column");
    expect(encodeQuestionAnswer(answered.value)).toEqual({
      question: "the migration needs a decision",
      answer: { id: "opt-2", label: "add a column" },
      text: null,
      pathsNotTaken: [{ id: "opt-1", label: "rebuild the table" }],
    });
    // The runtime settles the blocked request with the option pi handed us.
    expect(questionOutcome(answered.value)).toEqual({
      kind: "answer",
      value: "add a column",
    });
  });

  it("keeps unpicked options visible as paths not taken", () => {
    const question = ask({
      options: optionsFromLabels(["a", "b", "c"]),
    });
    const answered = answerQuestion(question, {
      optionId: "opt-2",
      by: humanAuthor,
      at: 2_000,
    });

    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    expect(answered.value.options).toHaveLength(3);
    expect(pathsNotTaken(answered.value).map((option) => option.label)).toEqual(
      ["a", "c"],
    );
    // Before an answer, every option is still a path not taken.
    expect(pathsNotTaken(question)).toHaveLength(3);
  });

  it("refuses a session answering a question put to the user", () => {
    const answered = answerQuestion(ask(), {
      optionId: "opt-1",
      by: sessionAuthor(SESSION),
      at: 2_000,
    });

    expect(answered.ok).toBe(false);
    if (answered.ok) return;
    expect(answered.refusal.reason).toBe("human_only");
  });

  it("refuses an option the question never offered", () => {
    const answered = answerQuestion(ask(), {
      optionId: "opt-9",
      by: humanAuthor,
      at: 2_000,
    });

    expect(answered.ok).toBe(false);
    if (answered.ok) return;
    expect(answered.refusal.reason).toBe("unknown_option");
  });

  it("refuses free-form text unless the question declared it", () => {
    const refused = answerQuestion(ask(), {
      optionId: "opt-1",
      text: "actually, do neither",
      by: humanAuthor,
      at: 2_000,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.reason).toBe("free_form_not_allowed");

    const allowed = answerQuestion(ask({ freeForm: "allowed" }), {
      optionId: "opt-1",
      text: "rebuild it, but tomorrow",
      by: humanAuthor,
      at: 2_000,
    });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.value.answer?.text).toBe("rebuild it, but tomorrow");
  });

  it("keeps the first answer: one gesture, one answer", () => {
    const first = answerQuestion(ask(), {
      optionId: "opt-1",
      by: humanAuthor,
      at: 2_000,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = answerQuestion(first.value, {
      optionId: "opt-2",
      by: humanAuthor,
      at: 3_000,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.refusal.reason).toBe("already_answered");
  });
});

describe("no timed defaults, structurally (§6.4, §14, principle 2)", () => {
  it("escalates attention when a deadline passes, and answers nothing", () => {
    const question = ask({ attention: escalateAfter(600) });

    expect(questionAttention(question, 1_000)).toBe("asked");
    expect(questionAttention(question, 1_599)).toBe("asked");
    expect(questionAttention(question, 1_600)).toBe("escalated");

    // The escalation changed nothing about the answer: it is still unanswered,
    // and there is no value anywhere that could stand in for one.
    expect(question.answer).toBeNull();
    expect(isAnswered(question)).toBe(false);
    expect(encodeQuestionAnswer(question)).toBeNull();
    expect(questionOutcome(question)).toBeNull();
  });

  it("an answered question never escalates", () => {
    const answered = answerQuestion(ask({ attention: escalateAfter(60) }), {
      optionId: "opt-1",
      by: humanAuthor,
      at: 1_010,
    });
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    expect(questionAttention(answered.value, 9_999_999)).toBe("asked");
  });

  /**
   * The structural half of the prohibition. Each of these is a compile error, and
   * this test exists so that stays true: if any of them ever typechecks, the
   * `@ts-expect-error` becomes an unused-directive error and this file fails to
   * build. That is the whole mechanism — a timed default is not refused at
   * runtime, it is *inexpressible*.
   */
  it("cannot express a timeout that proceeds", () => {
    // 1. There is no default option, fallback, or on-timeout field to set.
    // @ts-expect-error a question cannot carry a default that proceeds (§6.4)
    const withDefault: SessionQuestion = { ...ask(), defaultOptionId: "opt-1" };
    // @ts-expect-error nor a deadline that resolves it
    const withTimeout: SessionQuestion = { ...ask(), timeoutSeconds: 30 };
    // @ts-expect-error nor an on-timeout behaviour
    const withOnTimeout: SessionQuestion = { ...ask(), onTimeout: "proceed" };

    // 2. A deadline exists only to escalate attention. `onElapsed` is a single
    //    literal, so no other meaning is representable.
    const answersOnElapse: QuestionAttention = {
      escalateAfterSeconds: 30,
      // @ts-expect-error "answer" is not a thing elapsing can do
      onElapsed: "answer",
    };
    const proceedsOnElapse: QuestionAttention = {
      escalateAfterSeconds: 30,
      // @ts-expect-error and neither is proceeding
      onElapsed: "proceed",
    };

    // 3. An answer needs an author, and `Author` has no system variant, so
    //    "answered by the timer" cannot be written down either.
    const answeredByNobody = answerQuestion(ask(), {
      optionId: "opt-1",
      // @ts-expect-error there is no author that is not somebody
      by: { kind: "system" },
      at: 2_000,
    });

    // Referenced so the bindings are not merely unused locals.
    expect([
      withDefault,
      withTimeout,
      withOnTimeout,
      answersOnElapse,
      proceedsOnElapse,
      answeredByNobody,
    ]).toHaveLength(6);
  });

  it("keeps the only clock-reading function to attention", () => {
    // `questionAttention` is the one function here that takes a `now`. Everything
    // else is a pure function of the record, so no code path can time out.
    const question = ask({ attention: escalateAfter(1) });
    expect(questionAttention(question, 9_999)).toBe("escalated");
    expect(pathsNotTaken(question)).toHaveLength(2);
    expect(pickedOption(question)).toBeNull();
  });
});
