import type { Author } from "../author.js";
import type { SessionId } from "../ids.js";
import type { RequestOutcome, RuntimeRequestId } from "./runtime.js";

/**
 * Structured questions (§6.4).
 *
 * "A session can ask the user a question with selectable options; the answer
 * returns to the session as a result rather than prose it has to interpret.
 * Options not picked remain visible as paths not taken. Questions render as
 * bubbles on the session node, answerable inline without opening anything. **No
 * question may carry a default that proceeds on a timeout** (principle 2)."
 *
 * ## No timed defaults, structurally
 *
 * §14 lists "timed defaults on questions" as a non-goal: "a timer that resumes a
 * session is the system acting with nobody behind it — the one kind of spend
 * principle 2 still forbids." A prohibition enforced by review is a prohibition
 * that lands the first time someone is in a hurry, so it is enforced by the
 * types instead. Three things together make a timeout-that-proceeds
 * *inexpressible* rather than merely refused:
 *
 * 1. **There is no default option.** `SessionQuestion` has no `defaultOptionId`,
 *    no `fallback`, no `onTimeout` — a resolution has nowhere to come from
 *    except a picked option.
 * 2. **A deadline can only escalate attention.** `QuestionAttention.onElapsed`
 *    is the literal type `"escalate-attention"`, so `"answer"`, `"proceed"`, and
 *    `"default"` are type errors. Elapsing produces an attention level and
 *    nothing else: `questionAttention` is the only function here that reads a
 *    clock, and its return type is `QuestionAttentionLevel`, which cannot carry
 *    an answer.
 * 3. **Answering requires an author, and `Author` has no system variant.** Every
 *    answer records the human who picked it (`answerQuestion` refuses a session
 *    author outright — a session answering its own question would be principle
 *    1 with extra steps). There is no code path that produces an answer nobody
 *    made.
 *
 * `questions.test.ts` documents (1)–(3) as `@ts-expect-error` assertions: the
 * test fails if the shape ever becomes expressible, which is the only way a
 * structural prohibition stays structural.
 */

export type QuestionId = string;

export interface QuestionOption {
  /** Stable within the question, so an answer names a token and not prose. */
  readonly id: string;
  /** What the operator reads on the bubble. */
  readonly label: string;
  /** One line of "what this would mean", optional. */
  readonly detail: string | null;
}

/**
 * Whether the question accepts text as well as a choice. Deliberately not a
 * boolean: `"none"` is a question that can only be answered by picking one of
 * the paths the session declared, which is the §6.4 default, and a free-form
 * answer to such a question is refused rather than quietly accepted.
 */
export type QuestionFreeForm = "none" | "allowed";

export const QUESTION_ATTENTION_LEVELS = [
  /** Asked; on the bubble and in the queue like anything else (§7.1). */
  "asked",
  /** Old enough to escalate. Still unanswered — escalation is not resolution. */
  "escalated",
] as const;

export type QuestionAttentionLevel = (typeof QUESTION_ATTENTION_LEVELS)[number];

/**
 * The *only* legal use of a clock on a question: after this long, the question
 * shouts louder. `onElapsed` is a single literal so the type system refuses
 * every other meaning — see the module comment's point (2).
 */
export interface QuestionAttention {
  readonly escalateAfterSeconds: number;
  readonly onElapsed: "escalate-attention";
}

export function escalateAfter(seconds: number): QuestionAttention {
  return { escalateAfterSeconds: seconds, onElapsed: "escalate-attention" };
}

export interface QuestionAnswer {
  /** One of the question's declared options; validated, never trusted. */
  readonly optionId: string;
  /** Free-form text, only when the question declared `freeForm: "allowed"`. */
  readonly text: string | null;
  /** Who answered. There is no variant of `Author` that is not somebody. */
  readonly by: Author;
  readonly at: number;
}

export interface SessionQuestion {
  readonly id: QuestionId;
  readonly sessionId: SessionId;
  /**
   * The runtime request this question stands for, so answering it settles the
   * blocked tool call rather than a copy of it (§6.4 via `respond`). Null when
   * the question arrived over HTTP (`session_ask`) instead of from a runtime.
   */
  readonly requestId: RuntimeRequestId | null;
  readonly text: string;
  readonly options: readonly QuestionOption[];
  readonly freeForm: QuestionFreeForm;
  readonly attention: QuestionAttention | null;
  readonly askedAt: number;
  readonly answer: QuestionAnswer | null;
}

export const QUESTION_REFUSAL_REASONS = [
  /** No options: a question with nothing to pick is prose, not a question. */
  "no_options",
  /**
   * Two options sharing an id, or reading the same — either way an answer would
   * be ambiguous, since a runtime answers with the label and PlotRoom with the id.
   */
  "duplicate_option",
  /** The answer names an option the question never offered. */
  "unknown_option",
  /** Free-form text against a question that declared `freeForm: "none"`. */
  "free_form_not_allowed",
  /** Already answered: one gesture, one answer (principle 9). */
  "already_answered",
  /**
   * A session answering a question. §6.4's answer comes from the user; a
   * session answering one would expand its own knowledge from itself
   * (principle 1).
   */
  "human_only",
] as const;

export type QuestionRefusalReason = (typeof QUESTION_REFUSAL_REASONS)[number];

export interface QuestionRefusal {
  readonly reason: QuestionRefusalReason;
  readonly message: string;
}

export type QuestionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: QuestionRefusal };

function refuse<T>(
  reason: QuestionRefusalReason,
  message: string,
): QuestionResult<T> {
  return { ok: false, refusal: { reason, message } };
}

/**
 * What a caller may say when raising a question. Note what is absent: there is
 * no field here that could resolve the question without a person.
 */
export interface RaiseQuestionInput {
  readonly id: QuestionId;
  readonly sessionId: SessionId;
  readonly requestId?: RuntimeRequestId | null;
  readonly text: string;
  readonly options: readonly QuestionOption[];
  readonly freeForm?: QuestionFreeForm;
  readonly attention?: QuestionAttention | null;
  readonly at: number;
}

export function raiseQuestion(
  input: RaiseQuestionInput,
): QuestionResult<SessionQuestion> {
  if (input.options.length === 0) {
    return refuse(
      "no_options",
      "a structured question offers selectable options; one with none is prose the user has to interpret (§6.4)",
    );
  }

  // Both halves of an option have to be unique, and for different reasons.
  //
  // The **id** is what an answer names, so a repeat makes the answer ambiguous.
  // The **label** is what a human reads and what a runtime's select returns —
  // `questionOutcome` settles the blocked request with the label, and the
  // `plotroom_ask` extension computes paths-not-taken by filtering the picked
  // label out of the list. Two identical labels therefore pick each other's
  // option and delete each other from the paths not taken (§6.4), and there is no
  // reading of a question with two identical choices that is worth preserving.
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  for (const option of input.options) {
    if (seenIds.has(option.id)) {
      return refuse(
        "duplicate_option",
        `two options share the id ${JSON.stringify(option.id)}; an answer naming it would be ambiguous`,
      );
    }
    const label = option.label.trim();
    if (seenLabels.has(label)) {
      return refuse(
        "duplicate_option",
        `two options read ${JSON.stringify(option.label)}; a runtime answers with the label, so the two would be indistinguishable and each would erase the other from the paths not taken (§6.4)`,
      );
    }
    seenIds.add(option.id);
    seenLabels.add(label);
  }

  return {
    ok: true,
    value: {
      id: input.id,
      sessionId: input.sessionId,
      requestId: input.requestId ?? null,
      text: input.text,
      options: input.options,
      freeForm: input.freeForm ?? "none",
      attention: input.attention ?? null,
      askedAt: input.at,
      answer: null,
    },
  };
}

/** Build options from plain labels, which is what a runtime's select carries. */
export function optionsFromLabels(
  labels: readonly string[],
): readonly QuestionOption[] {
  return labels.map((label, index) => ({
    id: `opt-${index + 1}`,
    label,
    detail: null,
  }));
}

export interface AnswerQuestionInput {
  readonly optionId: string;
  readonly text?: string | null;
  readonly by: Author;
  readonly at: number;
}

/**
 * Answer a question. The result is a new record — the question keeps its
 * options, so "paths not taken" survives the answer (§6.4).
 */
export function answerQuestion(
  question: SessionQuestion,
  input: AnswerQuestionInput,
): QuestionResult<SessionQuestion> {
  if (question.answer !== null) {
    return refuse(
      "already_answered",
      "this question was already answered; a second answer would rewrite what the session was told (principle 9)",
    );
  }
  if (input.by.kind !== "human") {
    return refuse(
      "human_only",
      "a question is answered by the user; a session answering one would expand its own knowledge from itself (§6.4, principle 1)",
    );
  }
  if (!question.options.some((option) => option.id === input.optionId)) {
    return refuse(
      "unknown_option",
      `${JSON.stringify(input.optionId)} is not one of the options this question offered`,
    );
  }
  const text = input.text ?? null;
  if (text !== null && question.freeForm === "none") {
    return refuse(
      "free_form_not_allowed",
      "this question declared selectable options only; free-form text would be prose the session has to interpret (§6.4)",
    );
  }

  return {
    ok: true,
    value: {
      ...question,
      answer: { optionId: input.optionId, text, by: input.by, at: input.at },
    },
  };
}

/**
 * The options nobody picked, which stay visible (§6.4). Derived rather than
 * stored: a stored list could disagree with the question's own options.
 */
export function pathsNotTaken(
  question: SessionQuestion,
): readonly QuestionOption[] {
  const picked = question.answer?.optionId;
  if (picked === undefined) return question.options;
  return question.options.filter((option) => option.id !== picked);
}

export function pickedOption(question: SessionQuestion): QuestionOption | null {
  const picked = question.answer?.optionId;
  if (picked === undefined) return null;
  return question.options.find((option) => option.id === picked) ?? null;
}

export function isAnswered(question: SessionQuestion): boolean {
  return question.answer !== null;
}

/**
 * How loudly this question is asking, at `now`. An escalation changes the
 * attention level and **nothing else**: the returned value has no answer in it,
 * and there is no other function that consults the clock.
 */
export function questionAttention(
  question: SessionQuestion,
  now: number,
): QuestionAttentionLevel {
  if (question.answer !== null) return "asked";
  const attention = question.attention;
  if (attention === null) return "asked";
  const due = question.askedAt + attention.escalateAfterSeconds;
  return now >= due ? "escalated" : "asked";
}

/**
 * The answer as the session receives it: a machine-readable result, not prose
 * (§6.4). Both entry points encode it identically — the runtime path returns
 * this string as the blocked tool call's result, and the HTTP path returns it as
 * the answer body — so a session cannot tell the two apart, and neither can a
 * reader of the transcript.
 */
export interface EncodedQuestionAnswer {
  readonly question: string;
  readonly answer: { readonly id: string; readonly label: string };
  readonly text: string | null;
  /** Named in the result too: the session should know what was declined. */
  readonly pathsNotTaken: readonly {
    readonly id: string;
    readonly label: string;
  }[];
}

export function encodeQuestionAnswer(
  question: SessionQuestion,
): EncodedQuestionAnswer | null {
  const picked = pickedOption(question);
  if (picked === null || question.answer === null) return null;
  return {
    question: question.text,
    answer: { id: picked.id, label: picked.label },
    text: question.answer.text,
    pathsNotTaken: pathsNotTaken(question).map((option) => ({
      id: option.id,
      label: option.label,
    })),
  };
}

/**
 * The runtime outcome that settles the blocked request.
 *
 * `value` is the picked option's **label**, because that is the token a
 * runtime's select returned to PlotRoom and the one it can match — the
 * structured payload rides along in the extension's tool result
 * (`encodeQuestionAnswer`), which is what the model actually reads.
 */
export function questionOutcome(
  question: SessionQuestion,
): RequestOutcome | null {
  const picked = pickedOption(question);
  if (picked === null) return null;
  return { kind: "answer", value: picked.label };
}
