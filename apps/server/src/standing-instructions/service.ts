import {
  isStandingInstructionAvailableTo,
  type Author,
  type StandingInstruction,
  type StandingInstructionOptIn,
} from "@plotroom/core";
import type { StandingInstructionStore } from "@plotroom/db";
import type { EventBus } from "../events/bus.js";
import { badRequest, refused } from "../http/errors.js";

/**
 * Standing instructions as a service (§3.8, Epic 7.4's server half).
 *
 * Every rule is `@plotroom/core`'s and reaches here through `StandingInstructionStore`:
 * what may be standing, who may declare it, which instructions a workstream's
 * assembly includes and in what order. This adds the two things only the server has —
 * the event stream a live surface reads, and the HTTP shape of a refusal.
 *
 * ## Two different refusals, on purpose
 *
 * **Declaring or retiring** is refused for a session as a *refusal with a reason*
 * (409, `human_only`), not as a 403 "operator-only": the answer to "may I mark this
 * standing?" is not "no" but "propose it, and a human accepts" (principle 1, §3.8),
 * and the predicate's own message names `proposal_create`. A 403 would tell a session
 * to stop where the product wants it to do something else.
 *
 * **Opting a workstream in** is ordinary authoring and is not operator-only at all:
 * a session may opt another workstream in and may not opt in one in its own chain,
 * which is the lineage check the tool catalog declares (`target-session`) rather than
 * anything this file decides.
 */
export interface StandingInstructionServiceDeps {
  readonly instructions: StandingInstructionStore;
  readonly bus: EventBus;
}

/** One instruction with the workstreams that opted into it (§3.8's read). */
export interface StandingInstructionView {
  readonly instruction: StandingInstruction;
  readonly optIns: readonly StandingInstructionOptIn[];
}

export class StandingInstructionService {
  constructor(private readonly deps: StandingInstructionServiceDeps) {}

  /**
   * Every marker, retired ones included, each with its live opt-ins.
   *
   * Retired ones are listed rather than filtered out because "retired" and "never
   * standing" are different facts (§3.8) and a surface that hid the first would make
   * a marker's disappearance unexplainable.
   */
  list(): readonly StandingInstructionView[] {
    const optIns = this.deps.instructions.optIns();
    return this.deps.instructions.list().map((instruction) => ({
      instruction,
      optIns: optIns.filter((entry) => entry.instructionId === instruction.id),
    }));
  }

  /** Whether this instruction reaches this workstream — core's own predicate. */
  reaches(instruction: StandingInstruction, workstreamId: string): boolean {
    return isStandingInstructionAvailableTo(
      instruction,
      this.deps.instructions.optIns(instruction.id),
      workstreamId as never,
    );
  }

  declare(input: {
    readonly objectId: string;
    readonly actor: Author;
  }): StandingInstruction {
    const declared = this.deps.instructions.declare({
      objectId: input.objectId,
      by: input.actor,
    });
    if (!declared.ok) throw refused(declared.refusal);

    this.publish(declared.value, "created", input.actor);
    return declared.value;
  }

  retire(instructionId: string, actor: Author): StandingInstruction {
    const retired = this.deps.instructions.retire(instructionId, actor);
    if (!retired.ok) throw refused(retired.refusal);

    this.publish(retired.value, "updated", actor);
    return retired.value;
  }

  optIn(input: {
    readonly workstreamId: string;
    readonly instructionId: string;
    readonly actor: Author;
  }): StandingInstructionOptIn {
    const instruction = this.deps.instructions.get(input.instructionId);
    if (instruction.retiredAt !== null) {
      throw badRequest(
        `${instruction.id} was retired; opting into it would assemble nothing (§3.8)`,
      );
    }
    const optedIn = this.deps.instructions.optIn({
      workstreamId: input.workstreamId,
      instructionId: input.instructionId,
      by: input.actor,
    });
    this.publishOptIn(optedIn, "created", input.actor);
    return optedIn;
  }

  optOut(input: {
    readonly workstreamId: string;
    readonly instructionId: string;
    readonly actor: Author;
  }): StandingInstructionOptIn {
    const optedOut = this.deps.instructions.optOut(
      input.workstreamId,
      input.instructionId,
    );
    this.publishOptIn(optedOut, "updated", input.actor);
    return optedOut;
  }

  private publish(
    instruction: StandingInstruction,
    verb: "created" | "updated",
    author: Author,
  ): void {
    this.deps.bus.publish({
      entity: "standing_instruction",
      verb,
      instruction,
      objectId: instruction.objectId,
      author,
    });
  }

  private publishOptIn(
    optIn: StandingInstructionOptIn,
    verb: "created" | "updated",
    author: Author,
  ): void {
    this.deps.bus.publish({
      entity: "standing_instruction_opt_in",
      verb,
      optIn,
      author,
    });
  }
}
