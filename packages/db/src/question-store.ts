import { and, asc, eq, isNull } from "drizzle-orm";
import {
  systemClock,
  type Clock,
  type QuestionAttention,
  type QuestionOption,
  type RuntimeRequestId,
  type SessionId,
  type SessionQuestion,
} from "@plotroom/core";
import type { PlotroomDatabase } from "./client.js";
import { EntityNotFound } from "./errors.js";
import { sessionQuestions, type SessionQuestionRow } from "./schema.js";

/**
 * Structured questions at rest (§6.4, Epic 5.2's deferred persistence).
 *
 * `@plotroom/core`'s `questions.ts` owns every rule — what a valid question is,
 * who may answer, what the answer encodes, and the prohibition on timed defaults.
 * This store keeps the records so a question outlives the tool call it blocks:
 * "unpicked options remain visible" is only possible if something remembers the
 * options, and asking the runtime what it asked would have nothing to return once
 * the call settled.
 *
 * Every row round-trips through core's own `SessionQuestion`, so a stored question
 * and a freshly raised one are the same value to every caller.
 */
export class QuestionStore {
  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {}

  /**
   * Record a question core has already validated. Idempotent in the question's
   * own id: the same gesture replayed writes the same row (principle 9).
   */
  raise(question: SessionQuestion): SessionQuestion {
    this.state.db
      .insert(sessionQuestions)
      .values(toRow(question))
      .onConflictDoNothing()
      .run();
    return this.get(question.id);
  }

  /**
   * Replace a question with its answered form. Written as a whole record rather
   * than as an update of three columns, because `answerQuestion` returned the
   * record and disagreeing with it here is how a store starts deciding things.
   */
  save(question: SessionQuestion): SessionQuestion {
    const row = toRow(question);
    this.state.db
      .update(sessionQuestions)
      .set({
        answerOptionId: row.answerOptionId,
        answerText: row.answerText,
        answerByKind: row.answerByKind,
        answeredAt: row.answeredAt,
      })
      .where(eq(sessionQuestions.id, question.id))
      .run();
    return this.get(question.id);
  }

  get(questionId: string): SessionQuestion {
    const row = this.state.db
      .select()
      .from(sessionQuestions)
      .where(eq(sessionQuestions.id, questionId))
      .get();
    if (!row) throw new EntityNotFound("question", questionId);
    return toQuestion(row);
  }

  find(questionId: string): SessionQuestion | undefined {
    const row = this.state.db
      .select()
      .from(sessionQuestions)
      .where(eq(sessionQuestions.id, questionId))
      .get();
    return row === undefined ? undefined : toQuestion(row);
  }

  /**
   * The question standing for a blocked runtime request, if one was raised. Keyed
   * by the request rather than the session, so answering settles that call and not
   * some other question the same session asked.
   */
  forRequest(requestId: string): SessionQuestion | undefined {
    const row = this.state.db
      .select()
      .from(sessionQuestions)
      .where(eq(sessionQuestions.requestId, requestId))
      .get();
    return row === undefined ? undefined : toQuestion(row);
  }

  forSession(sessionId: string): readonly SessionQuestion[] {
    return this.state.db
      .select()
      .from(sessionQuestions)
      .where(eq(sessionQuestions.sessionId, sessionId))
      .orderBy(asc(sessionQuestions.askedAt))
      .all()
      .map((row) => toQuestion(row));
  }

  /**
   * Every question nobody has answered. The attention surface's own list (§7.1),
   * and the reason a restart does not lose a question: the record is here, and the
   * blocked call is named on it.
   */
  unanswered(sessionId?: string): readonly SessionQuestion[] {
    return this.state.db
      .select()
      .from(sessionQuestions)
      .where(
        sessionId === undefined
          ? isNull(sessionQuestions.answeredAt)
          : and(
              eq(sessionQuestions.sessionId, sessionId),
              isNull(sessionQuestions.answeredAt),
            ),
      )
      .orderBy(asc(sessionQuestions.askedAt))
      .all()
      .map((row) => toQuestion(row));
  }

  /** Unix seconds, for a caller that wants the store's own clock. */
  clock(): number {
    return this.now();
  }
}

function toRow(question: SessionQuestion): SessionQuestionRow {
  return {
    id: question.id,
    sessionId: question.sessionId,
    requestId: question.requestId,
    text: question.text,
    optionsJson: JSON.stringify(question.options),
    freeForm: question.freeForm,
    attentionJson:
      question.attention === null ? null : JSON.stringify(question.attention),
    askedAt: question.askedAt,
    answerOptionId: question.answer?.optionId ?? null,
    answerText: question.answer?.text ?? null,
    // Human-only by §6.4, and the column's CHECK says so too — a session
    // answering a question posed to the operator is principle 1 with extra steps.
    answerByKind: question.answer === null ? null : "human",
    answeredAt: question.answer?.at ?? null,
  };
}

function toQuestion(row: SessionQuestionRow): SessionQuestion {
  return {
    id: row.id,
    sessionId: row.sessionId as SessionId,
    requestId:
      row.requestId === null ? null : (row.requestId as RuntimeRequestId),
    text: row.text,
    options: JSON.parse(row.optionsJson) as QuestionOption[],
    freeForm: row.freeForm,
    attention:
      row.attentionJson === null
        ? null
        : (JSON.parse(row.attentionJson) as QuestionAttention),
    askedAt: row.askedAt,
    answer:
      row.answerOptionId === null || row.answeredAt === null
        ? null
        : {
            optionId: row.answerOptionId,
            text: row.answerText,
            by: { kind: "human" },
            at: row.answeredAt,
          },
  };
}
