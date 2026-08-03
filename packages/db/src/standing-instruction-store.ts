import { and, eq } from "drizzle-orm";
import {
  markStandingInstruction,
  newStandingInstructionId,
  optIn as coreOptIn,
  optOut as coreOptOut,
  resolveStandingInstructions,
  retireStandingInstruction,
  sessionAuthor,
  systemClock,
  humanAuthor,
  type Author,
  type Clock,
  type ObjectId,
  type ObjectKind,
  type SessionId,
  type StandingInstruction,
  type StandingInstructionCandidate,
  type StandingInstructionId,
  type StandingInstructionOptIn,
  type StandingInstructionResult,
  type WorkstreamId,
} from "@plotroom/core";
import type { PlotroomDatabase } from "./client.js";
import { EntityNotFound } from "./errors.js";
import { ObjectStore } from "./object-store.js";
import {
  standingInstructionOptIns,
  standingInstructions,
  type StandingInstructionOptInRow,
  type StandingInstructionRow,
} from "./schema.js";

/**
 * Standing instructions and their opt-ins, at rest (§3.8, migration 26).
 *
 * Every rule is `@plotroom/core`'s `standing-instructions.ts` and this store calls
 * it: what may be standing (`checkStandingInstruction`), who may declare one
 * (`markStandingInstruction` — a human, always), which instructions a workstream's
 * assembly includes and **in what order** (`resolveStandingInstructions`). A store
 * that re-derived any of those would be the second implementation principle 8 exists
 * to prevent — the canvas, the API and an agent tool have to refuse identically.
 *
 * What this class adds is the part only the store can do: it reads the object's own
 * kind and scope so the predicate has something to check, and it enforces
 * `already_standing` twice — once as the predicate's refusal and once as the partial
 * unique index, so an illegal row cannot be written even by a caller that skipped
 * the check.
 *
 * Nothing is deleted. Retiring writes `retired_at` and opting out writes
 * `opted_out_at`, because "retired yesterday" and "never standing" are different
 * facts, and the content object survives either way (principle 10).
 */
export class StandingInstructionStore {
  private readonly objects: ObjectStore;

  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {
    this.objects = new ObjectStore(state, now);
  }

  /** Every marker, retired ones included: history is readable (§3.6's posture). */
  list(): readonly StandingInstruction[] {
    return this.state.db
      .select()
      .from(standingInstructions)
      .all()
      .map(toInstruction);
  }

  live(): readonly StandingInstruction[] {
    return this.list().filter((instruction) => instruction.retiredAt === null);
  }

  get(instructionId: string): StandingInstruction {
    const found = this.find(instructionId);
    if (found === undefined) {
      throw new EntityNotFound("standing_instruction", instructionId);
    }
    return found;
  }

  find(instructionId: string): StandingInstruction | undefined {
    const row = this.state.db
      .select()
      .from(standingInstructions)
      .where(eq(standingInstructions.id, instructionId))
      .get();
    return row === undefined ? undefined : toInstruction(row);
  }

  /**
   * Mark content as applying everywhere, or return core's own refusal.
   *
   * The candidate is read here rather than supplied, because scope and kind are
   * facts about the stored object: a caller that passed them in could pass a
   * `note`/`world` pair for a `ticket` that is neither.
   */
  declare(input: {
    readonly objectId: string;
    readonly by: Author;
    readonly id?: StandingInstructionId;
  }): StandingInstructionResult<StandingInstruction> {
    const candidate = this.candidate(input.objectId);
    const marked = markStandingInstruction({
      id: input.id ?? newStandingInstructionId(),
      object: candidate,
      by: input.by,
      at: this.now(),
      existing: this.list(),
    });
    if (!marked.ok) return marked;

    this.state.db
      .insert(standingInstructions)
      .values(toRow(marked.value))
      .onConflictDoNothing()
      .run();

    return { ok: true, value: this.get(marked.value.id) };
  }

  /** Retire one. Idempotent: retiring a retired marker returns it unchanged. */
  retire(
    instructionId: string,
    by: Author,
  ): StandingInstructionResult<StandingInstruction> {
    const instruction = this.get(instructionId);
    const retired = retireStandingInstruction(instruction, by, this.now());
    if (!retired.ok) return retired;

    this.state.db
      .update(standingInstructions)
      .set({ retiredAt: retired.value.retiredAt })
      .where(eq(standingInstructions.id, instructionId))
      .run();

    return { ok: true, value: this.get(instructionId) };
  }

  /* ------------------------------------------------------------ opting in */

  optIns(instructionId?: string): readonly StandingInstructionOptIn[] {
    const rows =
      instructionId === undefined
        ? this.state.db.select().from(standingInstructionOptIns).all()
        : this.state.db
            .select()
            .from(standingInstructionOptIns)
            .where(eq(standingInstructionOptIns.instructionId, instructionId))
            .all();
    return rows.map(toOptIn);
  }

  findOptIn(
    workstreamId: string,
    instructionId: string,
  ): StandingInstructionOptIn | undefined {
    const row = this.state.db
      .select()
      .from(standingInstructionOptIns)
      .where(
        and(
          eq(standingInstructionOptIns.workstreamId, workstreamId),
          eq(standingInstructionOptIns.instructionId, instructionId),
        ),
      )
      .get();
    return row === undefined ? undefined : toOptIn(row);
  }

  /**
   * Opt a workstream in, recording who decided it (§3.8, principle 1).
   *
   * Idempotent in the pair: opting in twice is one opt-in, and opting in again
   * after opting out is the *same row* live again with the new author and time —
   * "who decided this workstream's sessions know it" has one current answer.
   */
  optIn(input: {
    readonly workstreamId: string;
    readonly instructionId: string;
    readonly by: Author;
  }): StandingInstructionOptIn {
    // Existence is checked rather than assumed: an opt-in naming no instruction
    // would be a row about nothing, and the foreign key would refuse it anyway
    // with a message nobody could act on.
    this.get(input.instructionId);
    const record = coreOptIn({
      workstreamId: input.workstreamId as WorkstreamId,
      instructionId: input.instructionId as StandingInstructionId,
      by: input.by,
      at: this.now(),
    });
    const row = toOptInRow(record);

    this.state.db
      .insert(standingInstructionOptIns)
      .values(row)
      .onConflictDoUpdate({
        target: [
          standingInstructionOptIns.workstreamId,
          standingInstructionOptIns.instructionId,
        ],
        set: {
          byKind: row.byKind,
          bySessionId: row.bySessionId,
          at: row.at,
          optedOutAt: null,
        },
      })
      .run();

    return this.requireOptIn(input.workstreamId, input.instructionId);
  }

  /** Opt out. Recorded, not erased (§3.8) — and a no-op if already out. */
  optOut(
    workstreamId: string,
    instructionId: string,
  ): StandingInstructionOptIn {
    const existing = this.findOptIn(workstreamId, instructionId);
    if (existing === undefined) {
      throw new EntityNotFound(
        "standing_instruction_opt_in",
        `${workstreamId}/${instructionId}`,
      );
    }
    const record = coreOptOut(existing, this.now());
    this.state.db
      .update(standingInstructionOptIns)
      .set({ optedOutAt: record.optedOutAt })
      .where(
        and(
          eq(standingInstructionOptIns.workstreamId, workstreamId),
          eq(standingInstructionOptIns.instructionId, instructionId),
        ),
      )
      .run();
    return this.requireOptIn(workstreamId, instructionId);
  }

  /**
   * What this workstream's assembly includes, in the order it includes them —
   * core's `resolveStandingInstructions` and nothing else, so the preview, the run,
   * and a surface drawing the toggle all agree (§3.8, §15-1).
   */
  resolve(workstreamId: string): readonly StandingInstruction[] {
    return resolveStandingInstructions({
      workstreamId: workstreamId as WorkstreamId,
      instructions: this.list(),
      optIns: this.optIns(),
    });
  }

  /* ------------------------------------------------------------- internals */

  /** The object's own kind and scope, which is what the predicate checks. */
  private candidate(objectId: string): StandingInstructionCandidate {
    const object = this.objects.get(objectId);
    if (object === undefined) throw new EntityNotFound("object", objectId);
    return {
      objectId: object.id as ObjectId,
      kind: object.kind as ObjectKind,
      scope: object.scope,
    };
  }

  private requireOptIn(
    workstreamId: string,
    instructionId: string,
  ): StandingInstructionOptIn {
    const found = this.findOptIn(workstreamId, instructionId);
    if (found === undefined) {
      throw new EntityNotFound(
        "standing_instruction_opt_in",
        `${workstreamId}/${instructionId}`,
      );
    }
    return found;
  }
}

function toRow(instruction: StandingInstruction): StandingInstructionRow {
  return {
    id: instruction.id,
    objectId: instruction.objectId,
    // The column can say nothing else, and neither can the model: every path to a
    // marker refuses a session author (principle 1).
    declaredByKind: "human",
    declaredAt: instruction.declaredAt,
    retiredAt: instruction.retiredAt,
  };
}

function toInstruction(row: StandingInstructionRow): StandingInstruction {
  return {
    id: row.id as StandingInstructionId,
    objectId: row.objectId as ObjectId,
    declaredBy: humanAuthor,
    declaredAt: row.declaredAt,
    retiredAt: row.retiredAt,
  };
}

function toOptInRow(
  optIn: StandingInstructionOptIn,
): StandingInstructionOptInRow {
  return {
    workstreamId: optIn.workstreamId,
    instructionId: optIn.instructionId,
    byKind: optIn.by.kind,
    bySessionId: optIn.by.kind === "session" ? optIn.by.sessionId : null,
    at: optIn.at,
    optedOutAt: optIn.optedOutAt,
  };
}

function toOptIn(row: StandingInstructionOptInRow): StandingInstructionOptIn {
  return {
    workstreamId: row.workstreamId as WorkstreamId,
    instructionId: row.instructionId as StandingInstructionId,
    by:
      row.byKind === "session" && row.bySessionId !== null
        ? sessionAuthor(row.bySessionId as SessionId)
        : humanAuthor,
    at: row.at,
    optedOutAt: row.optedOutAt,
  };
}
