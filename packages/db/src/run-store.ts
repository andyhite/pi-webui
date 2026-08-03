import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  aggregateRunOutcomes,
  checkContentBudget,
  checkSubmission,
  effectiveAskPoints,
  estimateRunCost,
  estimateTokens,
  isRunCompactable,
  newRunId,
  systemClock,
  DEFAULT_RUN_RETENTION_POLICY,
  ZERO_COST,
  type AssembledInput,
  type BudgetCheck,
  type Clock,
  type CostEstimate,
  type CommandDefinitionId,
  type CommandId,
  type ComparableRun,
  type CompletionProof,
  type ConditionEvaluation,
  type NodeId,
  type ObjectId,
  type OutputAddress,
  type PriorRunCost,
  type Run,
  type RunConfiguration,
  type RunCost,
  type RunId,
  type RunOutcomeAggregate,
  type RunOutput,
  type RunRetentionPolicy,
  type VersionId,
} from "@plotroom/core";
import { BlobStore } from "./blob-store.js";
import type { PlotroomDatabase } from "./client.js";
import { EntityNotFound } from "./errors.js";
import { CommandStore } from "./command-store.js";
import { GraphStore } from "./graph-store.js";
import { ObjectStore } from "./object-store.js";
import { StandingInstructionStore } from "./standing-instruction-store.js";
import {
  commandOutputs,
  objectVersions,
  objects,
  runInitiations,
  runInputs,
  runOutputs,
  runSubmissions,
  runs,
  type RunInitiationRow,
  type RunRow,
} from "./schema.js";

const BLOB_OWNER = "run";

/** Why a run could not start. Every reason is actionable, never a truncation. */
export type RunRefusal =
  | { readonly reason: "command_deleted"; readonly message: string }
  | { readonly reason: "parameters_unconfirmed"; readonly message: string }
  | { readonly reason: "blocked_input"; readonly message: string }
  | { readonly reason: "content_budget"; readonly message: string }
  /**
   * A spend budget that binds this work is exhausted (§8). Collected by the
   * preview like every other refusal and raised by the run path — which is why it
   * belongs to this vocabulary rather than being a special case at one call site:
   * "why can't I run this" has one answer, and "there is no money left" is one of
   * the things it says.
   */
  | { readonly reason: "out_of_budget"; readonly message: string }
  | { readonly reason: "already_ended"; readonly message: string }
  | { readonly reason: "initiation_key_reused"; readonly message: string }
  | { readonly reason: "initiation_in_flight"; readonly message: string };

export class RunRefused extends Error {
  constructor(readonly refusal: RunRefusal) {
    super(refusal.message);
    this.name = "RunRefused";
  }
}

export interface StartRunInput {
  readonly commandId: string;
  /**
   * The cap the operator accepted at the preview (§4.1). Recorded on the run;
   * enforcing it is Phase 6's job.
   */
  readonly spendCapMicros?: number | null;
}

export interface StartedRun {
  readonly run: Run;
  /** Present when assembly approached the model's window (§3.5). */
  readonly warning: string | null;
}

/** One assembled input, with the title and content the preview shows (§4.1). */
export interface PlannedInput extends AssembledInput {
  readonly title: string;
  readonly content: string;
}

/**
 * What a run *would* be, computed without writing anything (§4.1).
 *
 * This is the one description of a run's inputs and configuration, and both the
 * preview and {@link RunStore.start} read it — so "exactly what will execute"
 * means exactly, and a preview that says a run is ready cannot be contradicted
 * by the run refusing. The difference between them is only what they do with
 * `blockers`: the preview reports them, the run path refuses on the first.
 */
export interface RunPlan {
  readonly commandId: CommandId;
  readonly definitionId: CommandDefinitionId;
  readonly definitionName: string;
  /** The ordered inputs, exactly as assembly would send them (§3.5). */
  readonly inputs: readonly PlannedInput[];
  /** The assembled content itself: what the agent would be given, whole. */
  readonly body: string;
  readonly bytes: number;
  readonly estimatedTokens: number;
  /** Warn / refuse / ok against this command's content budget (§3.5). */
  readonly budget: BudgetCheck;
  /** Null exactly when a parameter is still a proposal (§3.5). */
  readonly configuration: RunConfiguration | null;
  /** Everything that would refuse this run, in the order the run path checks. */
  readonly blockers: readonly RunRefusal[];
  /** The `n` this run would answer at, were it started now (§15-4). */
  readonly nextOrdinal: number;
}

/** A plan plus what history says it will cost (§4.1). */
export interface RunPreview extends RunPlan {
  readonly estimate: CostEstimate;
  /** True when nothing would refuse the run right now. */
  readonly runnable: boolean;
}

export interface ProducedOutput {
  readonly name: string;
  readonly objectId: string;
  readonly versionId: string;
}

export interface CompleteRunInput {
  readonly outputs?: readonly ProducedOutput[];
  readonly cost?: RunCost;
  /** World-condition results, evaluated by whoever can observe them (§3.5). */
  readonly evaluations?: readonly ConditionEvaluation[];
}

export interface RecordSubmissionInput {
  readonly runId: string;
  readonly sessionId?: string | null;
  readonly accepted: boolean;
  readonly evaluations: readonly ConditionEvaluation[];
  /** Present exactly when the submission was not accepted (§3.5). */
  readonly feedback?: string | null;
}

/**
 * The gestures that spend an initiation key. `run` is a command run; the other
 * three are §6.3's, and each produces a session rather than a run.
 */
export const INITIATION_KINDS = ["run", "resume", "fork", "handoff"] as const;

export type InitiationKind = (typeof INITIATION_KINDS)[number];

export type InitiationClaim =
  | { readonly state: "claimed" }
  | { readonly state: "settled"; readonly initiation: RunInitiationRow }
  | { readonly state: "in_flight"; readonly initiation: RunInitiationRow };

export interface RunSubmission {
  readonly runId: RunId;
  readonly ordinal: number;
  readonly sessionId: string | null;
  readonly at: number;
  readonly accepted: boolean;
  readonly evaluations: readonly ConditionEvaluation[];
  readonly feedback: string | null;
}

export type CompleteResult =
  | {
      readonly accepted: true;
      readonly run: Run;
      readonly proof: CompletionProof;
    }
  | {
      readonly accepted: false;
      /** Returned to the session, which continues within its budget (§3.5). */
      readonly feedback: string;
      readonly failed: readonly ConditionEvaluation[];
    };

/**
 * Runs and run history (spec §4.4, §15 invariants 1 and 3 and 4).
 *
 * Starting a run is the moment the two halves of invariant 1 are captured: the
 * exact ordered content, assembled and stored whole, and the configuration it
 * ran under. Nothing here writes a run without both, and nothing here stores
 * which run is "latest" — that is resolved by ordering, so `output@n` stays
 * the general case and `latest` a query over it.
 */
export class RunStore {
  private readonly blobs: BlobStore;
  private readonly commands: CommandStore;
  private readonly graph: GraphStore;
  private readonly objects: ObjectStore;
  private readonly standing: StandingInstructionStore;

  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {
    this.blobs = new BlobStore(state, now);
    this.commands = new CommandStore(state, now);
    this.graph = new GraphStore(state, now);
    this.objects = new ObjectStore(state, now);
    this.standing = new StandingInstructionStore(state, now);
  }

  /* --------------------------------------------------------------- the plan */

  /**
   * What a run of this command would be, written nowhere (§4.1).
   *
   * Every refusal the run path would raise is collected here instead of thrown,
   * in the order the run path checks them, because the preview's job is to say
   * what is missing — a preview that refused to tell you why you cannot run
   * would be useless. {@link start} reads the same plan and refuses on the first
   * blocker, which is what makes "exactly what will execute" true rather than
   * aspirational.
   *
   * Nothing here provisions, starts, or records anything. It is a read.
   */
  plan(commandId: string): RunPlan {
    const command = this.commands.command(commandId);
    const definition = this.commands.definition(command.definitionId);
    const node = this.commands.commandNode(commandId);
    const blockers: RunRefusal[] = [];

    // A soft-deleted command is off the board (principle 10): running it would
    // produce history for work the human deleted. Restore it first.
    if (command.deletedAt !== null) {
      blockers.push({
        reason: "command_deleted",
        message: `command ${commandId} is deleted; restore it before running it`,
      });
    }

    const parameters = this.commands.parameters(commandId);
    if (!parameters.ready) {
      const outstanding = [...parameters.unconfirmed, ...parameters.missing];
      blockers.push({
        reason: "parameters_unconfirmed",
        message: `confirm ${outstanding.join(", ")} before running; a derived default is a proposal, not a value`,
      });
    }

    const assembled = this.assemble(node.id, node.workstreamId);
    blockers.push(...assembled.blockers);

    const body = assembled.parts
      .map((part) => `## ${part.title}\n\n${part.content}`)
      .join("\n\n");

    const estimatedTokens = estimateTokens(body);
    const budget = checkContentBudget(estimatedTokens, definition.budget);
    if (budget.state === "refused") {
      blockers.push({ reason: "content_budget", message: budget.message });
    }

    return {
      commandId: command.id as CommandId,
      definitionId: definition.id,
      definitionName: definition.name,
      inputs: assembled.parts,
      body,
      bytes: Buffer.byteLength(body, "utf8"),
      estimatedTokens,
      budget,
      configuration: parameters.ready
        ? {
            definitionId: definition.id,
            definitionName: definition.name,
            instruction: definition.instruction,
            model: definition.model,
            permissions: definition.permissions,
            askPoints: effectiveAskPoints(definition.askPoints),
            lifecycle: definition.lifecycle,
            outcome: definition.outcome,
            parameters: parameters.values,
            budget: definition.budget,
          }
        : null,
      blockers,
      nextOrdinal: this.nextOrdinal(commandId),
    };
  }

  /**
   * The run preview (§4.1): the plan, plus what history says it will cost.
   *
   * The estimate is priced from this definition's own run history — which is
   * what §15-1 is for — and states its basis in words. Where there is no priced
   * history it says so and prices nothing, rather than turning input size into a
   * number that looks like a quote (principle 7).
   */
  preview(commandId: string): RunPreview {
    const plan = this.plan(commandId);

    return {
      ...plan,
      estimate: estimateRunCost({
        inputTokens: plan.estimatedTokens,
        priorRuns: this.pricedHistory(plan.definitionId),
      }),
      runnable: plan.blockers.length === 0,
    };
  }

  /**
   * What every past run of this definition cost. Per definition rather than per
   * command node, matching retention's own grain (§4.4) — the same recipe run in
   * two workstreams is the same evidence about what it costs.
   */
  pricedHistory(definitionId: string): PriorRunCost[] {
    return this.state.db
      .select({
        costMicros: runs.costMicros,
        inputTokens: runs.inputTokens,
        outputTokens: runs.outputTokens,
      })
      .from(runs)
      .where(eq(runs.definitionId, definitionId))
      .all();
  }

  /**
   * Assemble and record a run. Refused rather than degraded when a parameter
   * is still a proposal, when an input is a placeholder nothing has produced
   * yet, or when assembly is over an opt-in hard cap — the product never
   * silently truncates and never silently guesses (§3.5, principle 12).
   */
  start(input: StartRunInput): StartedRun {
    const plan = this.plan(input.commandId);

    // Every refusal the preview would have reported, in the order it reports
    // them: the run path and the preview read one plan, so a preview that says
    // "this will run" and a run that refuses cannot disagree (§4.1).
    const blocker = plan.blockers[0];
    if (blocker) throw new RunRefused(blocker);

    const { inputs, body, budget, configuration } = plan;
    if (configuration === null) {
      // Unreachable: a null configuration always comes with a blocker above.
      throw new RunRefused({
        reason: "parameters_unconfirmed",
        message: "this command has no runnable configuration",
      });
    }

    const id = newRunId();
    const at = this.now();

    // §15-1 is all-or-nothing: a run row without its inputs, or inputs whose
    // versions were never marked retained, is the uncomparable half-record
    // the invariant exists to prevent. One transaction, or none of it.
    return this.state.db.transaction(() => {
      const blob = this.blobs.put(body, { kind: "assembled_content" });
      this.blobs.reference(blob.id, { ownerKind: BLOB_OWNER, ownerId: id });

      this.state.db
        .insert(runs)
        .values({
          id,
          commandId: input.commandId,
          definitionId: configuration.definitionId,
          ordinal: this.nextOrdinal(input.commandId),
          status: "running",
          assembledBlobId: blob.id,
          assembledHash: createHash("sha256").update(body).digest("hex"),
          assembledBytes: Buffer.byteLength(body, "utf8"),
          configJson: JSON.stringify(configuration),
          // §4.1: the cap the operator accepted at the preview, recorded with
          // the rest of what this run was authorised to do.
          spendCapMicros: input.spendCapMicros ?? null,
          startedAt: at,
        })
        .run();

      for (const part of inputs) {
        this.state.db
          .insert(runInputs)
          .values({
            runId: id,
            ordinal: part.ordinal,
            nodeId: part.nodeId,
            objectId: part.objectId,
            versionId: part.versionId,
            contentHash: part.contentHash,
            bytes: part.bytes,
          })
          .run();
      }

      // §15 invariant 3's other half: a version a run consumed is retained, so
      // any two runs stay comparable forever (§4.4).
      this.objects.markRunReferenced(inputs.map((part) => part.versionId));

      return {
        run: this.run(id),
        warning: budget.state === "warn" ? budget.message : null,
      };
    });
  }

  /**
   * End a run. When the command declared an outcome, the submission is checked
   * against its world conditions first: a failing condition is returned as
   * feedback and the run stays open, because the session continues (§3.5).
   */
  complete(runId: string, input: CompleteRunInput = {}): CompleteResult {
    const row = this.requireRunning(runId);
    const configuration = this.configuration(row);
    const at = this.now();

    let proof: CompletionProof = { provenAt: at, conditions: [] };

    if (configuration.outcome) {
      const submission = checkSubmission(
        configuration.outcome,
        input.evaluations ?? [],
        at,
      );

      if (!submission.accepted) {
        return {
          accepted: false,
          feedback: submission.feedback,
          failed: submission.failed,
        };
      }

      proof = submission.proof;
    }

    const cost = input.cost ?? ZERO_COST;

    // Recording the outputs, binding the placeholders, and ending the run are
    // one act: a run that ended "completed" while an output failed to bind is
    // a completion nobody can address (§15-4).
    return this.state.db.transaction(() => {
      for (const produced of input.outputs ?? []) {
        this.state.db
          .insert(runOutputs)
          .values({
            runId,
            name: produced.name,
            objectId: produced.objectId,
            versionId: produced.versionId,
          })
          .run();

        this.objects.markRunReferenced([produced.versionId]);

        const output = this.state.db
          .select()
          .from(commandOutputs)
          .where(
            and(
              eq(commandOutputs.commandId, row.commandId),
              eq(commandOutputs.name, produced.name),
            ),
          )
          .get();

        // Post-bind: the placeholder now stands for a real object (§3.5).
        if (output) {
          this.commands.bindOutput(output.id, {
            runId,
            objectId: produced.objectId,
          });
        }
      }

      this.state.db
        .update(runs)
        .set({
          status: "completed",
          endedAt: at,
          outcomeProofJson: JSON.stringify(proof),
          inputTokens: cost.inputTokens,
          outputTokens: cost.outputTokens,
          costMicros: cost.costMicros,
        })
        .where(eq(runs.id, runId))
        .run();

      return { accepted: true, run: this.run(runId), proof };
    });
  }

  /** A run that failed. Distinct from one PlotRoom stopped (§3.6, §8). */
  fail(runId: string, reason: string, cost?: RunCost): Run {
    return this.end(runId, "failed", cost, reason);
  }

  /**
   * PlotRoom stopped the work because the budget ran out. Its own outcome, not
   * a failure — reporting it as one makes cross-run outcomes dishonest (§8).
   */
  stopOutOfBudget(runId: string, cost?: RunCost): Run {
    return this.end(runId, "out_of_budget", cost, null);
  }

  /**
   * Somebody stopped it (§6.7). `reason` records who or what asked, verbatim.
   */
  stop(runId: string, cost?: RunCost, reason?: string): Run {
    return this.end(runId, "stopped", cost, reason ?? null);
  }

  /**
   * A crash or restart caught the run in flight (principle 11). Its own outcome:
   * not stopped, because nobody decided to stop it, and not failed. The session
   * that executed it records the same thing (§3.6), so the two halves of the
   * record agree instead of one of them rounding to the nearest available word.
   */
  interrupt(runId: string, message: string, cost?: RunCost): Run {
    return this.end(runId, "interrupted", cost, message);
  }

  /**
   * One submission attempt in the producing completion loop (§3.5): what was
   * checked, what held, and the feedback the session got back. Recorded whole,
   * so "how many tries did this take, and why" is answerable afterwards (§6.4)
   * without re-evaluating anything — proof stays point-in-time.
   */
  recordSubmission(input: RecordSubmissionInput): RunSubmission {
    const at = this.now();

    return this.state.db.transaction(() => {
      const max = this.state.db
        .select({ max: sql<number | null>`MAX(${runSubmissions.ordinal})` })
        .from(runSubmissions)
        .where(eq(runSubmissions.runId, input.runId))
        .get();
      const ordinal = (max?.max ?? 0) + 1;

      this.state.db
        .insert(runSubmissions)
        .values({
          runId: input.runId,
          ordinal,
          sessionId: input.sessionId ?? null,
          at,
          accepted: input.accepted,
          evaluationsJson: JSON.stringify(input.evaluations),
          feedback: input.feedback ?? null,
        })
        .run();

      return {
        runId: input.runId as RunId,
        ordinal,
        sessionId: input.sessionId ?? null,
        at,
        accepted: input.accepted,
        evaluations: input.evaluations,
        feedback: input.feedback ?? null,
      };
    });
  }

  /* ------------------------------------------------- idempotent initiation */

  /**
   * Claim a client-supplied initiation key (principle 9: one gesture, one run
   * and one session, across retries and reconnects).
   *
   * Three answers, and no fourth: the key is new and now claimed; the key
   * already produced a run, which is what a retry gets handed back; or the key
   * is claimed but not settled, meaning the first attempt is still in flight and
   * a second must not start a second run.
   */
  claimInitiation(
    key: string,
    /**
     * The command being run, or null where there is none: a fork, a handoff, and a
     * resume each spend a key and produce no run (§6.3), and passing a session id
     * in a column named `command_id` is what the foreign key correctly refused.
     */
    commandId: string | null,
    /**
     * Which gesture is spending it. Compared as strictly as the command is, because
     * a key names one **gesture**: a run of command X and a fork of a session of
     * command X agree about X and are not the same act, and handing the second the
     * first one's answer would call it a retry of something it never was.
     */
    kind: InitiationKind = "run",
    /**
     * What this gesture is about: the session a resume resumes, the source a fork
     * forks, the brief a handoff sends. Omitted for a run, whose subject is the
     * command.
     *
     * Compared as strictly as the other two, and for a sharper reason: a key whose
     * kind and command match but whose **subject** differs is a different gesture
     * wearing the same clothes, and answering it as a retry hands it the first
     * gesture's session to write into.
     */
    subjectId: string | null = null,
  ): InitiationClaim {
    return this.state.db.transaction(() => {
      const existing = this.initiation(key);

      if (existing) {
        if (existing.commandId !== commandId) {
          throw new RunRefused({
            reason: "initiation_key_reused",
            message: `initiation key ${key} already started a run of a different command; use a new key`,
          });
        }
        if (existing.kind !== kind) {
          throw new RunRefused({
            reason: "initiation_key_reused",
            message: `initiation key ${key} already spent on a ${existing.kind} gesture; a ${kind} is a different gesture and needs its own key (principle 9)`,
          });
        }
        if (existing.subjectId !== subjectId) {
          throw new RunRefused({
            reason: "initiation_key_reused",
            message: `initiation key ${key} already spent on ${kind} of ${String(existing.subjectId)}; the same key cannot name a second ${kind} (principle 9)`,
          });
        }
        // Settled means the key produced what it was going to produce. A run-less
        // initiation (§6.3) settles with a session and no run, so "no run" is not
        // evidence it is still in flight — the settle timestamp is.
        return existing.settledAt === null
          ? { state: "in_flight" as const, initiation: existing }
          : { state: "settled" as const, initiation: existing };
      }

      this.state.db
        .insert(runInitiations)
        .values({
          initiationKey: key,
          commandId,
          kind,
          subjectId,
          createdAt: this.now(),
        })
        .run();

      return { state: "claimed" as const };
    });
  }

  /** The gesture produced this run and this session; a retry now replays it. */
  /**
   * Bind an initiation key to what it produced.
   *
   * `runId` is nullable because not every initiation produces a run: a fork and a
   * handoff each produce a **session** and no run of their own (§6.3), and the key
   * still has to be spent so a retry answers with the same session rather than
   * starting a second one (principle 9).
   */
  settleInitiation(key: string, runId: string | null, sessionId: string): void {
    this.state.db
      .update(runInitiations)
      .set({ runId, sessionId, settledAt: this.now() })
      .where(eq(runInitiations.initiationKey, key))
      .run();
  }

  /**
   * The gesture failed before it produced anything, so the key is free again.
   * Holding it would turn one refused attempt into a permanently unusable key.
   */
  releaseInitiation(key: string): void {
    this.state.db
      .delete(runInitiations)
      .where(eq(runInitiations.initiationKey, key))
      .run();
  }

  /**
   * At process start, no attempt can genuinely still be in flight: the attempt
   * that claimed a key died with the process that was making it. An unsettled
   * claim left behind by a crash would otherwise refuse that key forever, which
   * turns idempotency into a trap rather than a guarantee (principle 9).
   *
   * Deliberately keyed on "unsettled" and not on age: a settled row is what a
   * retry replays and is never touched, and there is no live attempt to race.
   */
  releaseUnsettledInitiations(): readonly string[] {
    const stranded = this.state.db
      .select({ key: runInitiations.initiationKey })
      .from(runInitiations)
      .where(isNull(runInitiations.settledAt))
      .all()
      .map((row) => row.key);

    if (stranded.length === 0) return [];

    this.state.db
      .delete(runInitiations)
      .where(isNull(runInitiations.settledAt))
      .run();

    return stranded;
  }

  initiation(key: string): RunInitiationRow | undefined {
    return this.state.db
      .select()
      .from(runInitiations)
      .where(eq(runInitiations.initiationKey, key))
      .get();
  }

  submissions(runId: string): RunSubmission[] {
    return this.state.db
      .select()
      .from(runSubmissions)
      .where(eq(runSubmissions.runId, runId))
      .orderBy(runSubmissions.ordinal)
      .all()
      .map((row) => ({
        runId: row.runId as RunId,
        ordinal: row.ordinal,
        sessionId: row.sessionId,
        at: row.at,
        accepted: row.accepted,
        evaluations: JSON.parse(
          row.evaluationsJson,
        ) as readonly ConditionEvaluation[],
        feedback: row.feedback,
      }));
  }

  run(runId: string): Run {
    return this.toRun(this.runRow(runId));
  }

  /**
   * §15 invariant 1: the exact bytes the agent was given, byte for byte, no
   * matter how the objects that fed it have changed since.
   */
  assembledContent(runId: string): string {
    return this.blobs.text(this.runRow(runId).assembledBlobId);
  }

  /**
   * The content-budget verdict for a run that already exists, recomputed rather
   * than remembered.
   *
   * §15-1 makes this exact: both inputs are recorded on the run — the assembled
   * content byte for byte and the budget inside the configuration it ran under —
   * and it is the same `checkContentBudget` {@link start} asked, so the answer is
   * the one that run was started with, not a second opinion about it. That is why
   * there is no `warning` column: a stored copy of a derivable fact is a second
   * source of truth waiting to disagree.
   */
  contentBudget(runId: string): BudgetCheck {
    const row = this.runRow(runId);
    return checkContentBudget(
      estimateTokens(this.blobs.text(row.assembledBlobId)),
      this.configuration(row).budget,
    );
  }

  /** The warning §3.5 requires assembly to give, or null when there was none. */
  assemblyWarning(runId: string): string | null {
    const budget = this.contentBudget(runId);
    return budget.state === "warn" ? budget.message : null;
  }

  /**
   * The two runs §4.4's comparison gesture reads, as `@plotroom/core` wants them.
   *
   * The rule about what may be compared is `compareRuns`', not this method's: it
   * gathers what each run recorded — including where its assembled bytes are
   * addressable, so a diff is derivable without shipping both bodies through the
   * comparison — and lets core refuse. Nothing here reads an object's *current*
   * state, which is why a comparison keeps working after the inputs moved on
   * (§15-1).
   */
  comparable(runId: string): ComparableRun {
    return {
      run: this.run(runId),
      outputs: this.outputsOf(runId),
      assembledAddress: `/api/runs/${runId}/assembled`,
    };
  }

  /** What one run produced, addressable as `output@n` (§15-4). */
  outputsOf(runId: string): RunOutput[] {
    return this.state.db
      .select()
      .from(runOutputs)
      .where(eq(runOutputs.runId, runId))
      .orderBy(runOutputs.name)
      .all()
      .map((row) => ({
        runId: row.runId as RunId,
        name: row.name,
        objectId: row.objectId as ObjectId,
        versionId: row.versionId as VersionId,
      }));
  }

  /**
   * Cross-run outcomes for one definition (§4.4): attempts, the end-state
   * histogram, and what it costs — "how many attempts it typically takes, what
   * usually fails, what it costs".
   *
   * The cost half goes through the **same** `estimateRunCost` the run preview
   * uses, over the same per-definition grain, rather than computing a second set
   * of numbers: a cross-run cost and a pre-run estimate that could disagree would
   * make one of them wrong on every screen showing both.
   */
  outcomes(definitionId: string, inputTokens = 0): RunOutcomeAggregate {
    const rows = this.state.db
      .select({
        id: runs.id,
        commandId: runs.commandId,
        status: runs.status,
        costMicros: runs.costMicros,
        inputTokens: runs.inputTokens,
        outputTokens: runs.outputTokens,
        submissions: sql<number>`(select count(*) from run_submissions where run_submissions.run_id = ${runs.id})`,
      })
      .from(runs)
      .where(eq(runs.definitionId, definitionId))
      .orderBy(runs.startedAt)
      .all();

    return aggregateRunOutcomes({
      definitionId: definitionId as CommandDefinitionId,
      inputTokens,
      runs: rows.map((row) => ({
        commandId: row.commandId as CommandId,
        status: row.status,
        costMicros: row.costMicros,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        submissions: row.submissions,
      })),
    });
  }

  /** Every run of a command, oldest first: the n in output@n is the ordinal. */
  history(commandId: string): Run[] {
    return this.state.db
      .select()
      .from(runs)
      .where(eq(runs.commandId, commandId))
      .orderBy(runs.ordinal)
      .all()
      .map((row) => this.toRun(row));
  }

  /**
   * §15 invariant 4: resolve an output address. `latest` is a query over run
   * ordinals — it is derived here and stored nowhere, so a new run never
   * rewrites what `output@1` means.
   */
  resolve(address: OutputAddress): RunOutput | null {
    const candidates = this.state.db
      .select({
        runId: runOutputs.runId,
        name: runOutputs.name,
        objectId: runOutputs.objectId,
        versionId: runOutputs.versionId,
        ordinal: runs.ordinal,
      })
      .from(runOutputs)
      .innerJoin(runs, eq(runs.id, runOutputs.runId))
      .where(
        and(
          eq(runs.commandId, address.commandId),
          eq(runOutputs.name, address.name),
        ),
      )
      .orderBy(sql`${runs.ordinal} DESC`)
      .all();

    const row =
      address.at === "latest"
        ? candidates[0]
        : address.at === "ordinal"
          ? candidates.find((each) => each.ordinal === address.runOrdinal)
          : candidates.find((each) => each.runId === address.runId);

    if (!row) return null;

    return {
      runId: row.runId as RunId,
      name: row.name,
      objectId: row.objectId as ObjectId,
      versionId: row.versionId as VersionId,
    };
  }

  /**
   * Pinning is the human's word for "never compact this" (§4.4), and it
   * reaches everything the run references: its assembled content and every
   * version that went in or came out.
   */
  pin(runId: string, pinned = true): Run {
    const row = this.runRow(runId);

    this.state.db.update(runs).set({ pinned }).where(eq(runs.id, runId)).run();

    this.blobs.reference(row.assembledBlobId, {
      ownerKind: BLOB_OWNER,
      ownerId: runId,
      pinned,
    });
    this.objects.setPinned(this.referencedVersions([runId]), pinned);

    return this.run(runId);
  }

  /**
   * Run-history retention (§4.4), mirroring the pure predicate rather than
   * restating it: rank runs per definition, mark the ones an address still
   * resolves to, and let `isRunCompactable` decide.
   */
  compactRuns(policy: RunRetentionPolicy = DEFAULT_RUN_RETENTION_POLICY): {
    removed: number;
  } {
    const now = this.now();
    const all = this.state.db
      .select()
      .from(runs)
      .orderBy(sql`${runs.startedAt} DESC`, sql`${runs.id} DESC`)
      .all();

    const rankByDefinition = new Map<string, number>();
    const addressed = this.addressedByLatest();
    const doomed: RunRow[] = [];

    for (const row of all) {
      const rank = (rankByDefinition.get(row.definitionId) ?? 0) + 1;
      rankByDefinition.set(row.definitionId, rank);

      const compactable = isRunCompactable(
        {
          pinned: row.pinned,
          startedAt: row.startedAt,
          recencyRank: rank,
          addressedByLatest: addressed.has(row.id),
        },
        { now, policy },
      );

      if (compactable) doomed.push(row);
    }

    if (doomed.length === 0) return { removed: 0 };

    const ids = doomed.map((row) => row.id);
    const versions = this.referencedVersions(ids);

    for (const row of doomed) {
      // The same pairing as version compaction, and the same reason: between
      // dropping the reference to a run's assembled content and dropping the
      // run, the blob sweep could reclaim bytes §15-1 still requires. One
      // transaction per run.
      this.state.db.transaction(() => {
        this.blobs.dereference(row.assembledBlobId, {
          ownerKind: BLOB_OWNER,
          ownerId: row.id,
        });
        this.state.db.delete(runs).where(eq(runs.id, row.id)).run();
      });
    }

    // A version stays run-referenced only while some run still points at it;
    // otherwise version compaction could never reclaim it (§15 invariant 3).
    this.releaseUnreferencedVersions(versions);

    return { removed: doomed.length };
  }

  /** The configuration the run actually ran under (§15 invariant 1). */
  configuration(row: RunRow | string): RunConfiguration {
    const resolved = typeof row === "string" ? this.runRow(row) : row;
    return JSON.parse(resolved.configJson) as RunConfiguration;
  }

  proof(runId: string): CompletionProof | null {
    const row = this.runRow(runId);
    return row.outcomeProofJson
      ? (JSON.parse(row.outcomeProofJson) as CompletionProof)
      : null;
  }

  inputs(runId: string): AssembledInput[] {
    return this.state.db
      .select()
      .from(runInputs)
      .where(eq(runInputs.runId, runId))
      .orderBy(runInputs.ordinal)
      .all()
      .map((row) => ({
        ordinal: row.ordinal,
        nodeId: row.nodeId as NodeId | null,
        objectId: row.objectId as ObjectId,
        versionId: row.versionId as VersionId,
        contentHash: row.contentHash,
        bytes: row.bytes,
      }));
  }

  private end(
    runId: string,
    status: "failed" | "out_of_budget" | "stopped" | "interrupted",
    cost: RunCost | undefined,
    reason: string | null,
  ): Run {
    this.requireRunning(runId);
    const resolved = cost ?? ZERO_COST;

    this.state.db
      .update(runs)
      .set({
        status,
        endedAt: this.now(),
        failureReason: reason,
        inputTokens: resolved.inputTokens,
        outputTokens: resolved.outputTokens,
        costMicros: resolved.costMicros,
      })
      .where(eq(runs.id, runId))
      .run();

    return this.run(runId);
  }

  /**
   * Assemble the ordered inputs (§3.5). A placeholder nothing has produced yet
   * blocks the run and says which one, rather than being quietly skipped.
   *
   * The workstream's **standing instructions come first** (§3.8), because they are
   * the frame the rest is read in — "this repository uses pnpm, never npm" is not
   * one input among the ticket and the diff. Which ones, and in what order, is
   * `resolveStandingInstructions`'s answer and never this method's: two runs of one
   * command with the same opt-ins have to assemble identically, or the comparison
   * §3.7 promises would report a change nobody made.
   *
   * They are resolved here rather than fanned out into context edges, and the run's
   * own record loses nothing by it: `plan` hands these to `start`, which stores the
   * assembled bytes and every input's version whole (§15-1), so what a run actually
   * saw is recorded whether or not an edge existed.
   */
  private assemble(
    commandNodeId: string,
    workstreamId: string | null,
  ): {
    readonly parts: PlannedInput[];
    readonly blockers: RunRefusal[];
  } {
    const parts: PlannedInput[] = [];
    const blockers: RunRefusal[] = [];

    if (workstreamId !== null) {
      for (const instruction of this.standing.resolve(workstreamId)) {
        // No node: a standing instruction reaches assembly through the
        // workstream's opt-in, not through anything drawn on the board — which is
        // why `run_inputs.node_id` is nullable.
        const content = this.objects.read(instruction.objectId);
        const object = this.objects.get(instruction.objectId);
        parts.push({
          ordinal: parts.length + 1,
          nodeId: null,
          objectId: instruction.objectId,
          versionId: content.versionId as VersionId,
          contentHash: createHash("sha256")
            .update(content.renderings.agentContent)
            .digest("hex"),
          bytes: Buffer.byteLength(content.renderings.agentContent, "utf8"),
          title: object?.title ?? content.renderings.summary,
          content: content.renderings.agentContent,
        });
      }
    }

    for (const edge of this.graph.contextInputs(commandNodeId)) {
      const source = this.graph.node(edge.fromNode);
      const objectId = this.objectIdOf(source.refId);

      if (!objectId) {
        // Reported rather than thrown, because the preview's job is to say what
        // this command is waiting on (§4.1); the run path refuses on it.
        blockers.push({
          reason: "blocked_input",
          message: `an input has not been produced yet; this command is blocked on ${source.refId}`,
        });
        continue;
      }

      const content = this.objects.read(objectId);
      const object = this.objects.get(objectId);

      parts.push({
        // Sequential over the whole assembly rather than the edge's own ordinal:
        // `run_inputs` is keyed by (run, ordinal), and the edges' ordering is
        // already what `contextInputs` returned them in. Standing instructions
        // occupy the first places, so the wired inputs continue from there.
        ordinal: parts.length + 1,
        nodeId: source.id as NodeId,
        objectId: objectId as ObjectId,
        versionId: content.versionId as VersionId,
        contentHash: createHash("sha256")
          .update(content.renderings.agentContent)
          .digest("hex"),
        bytes: Buffer.byteLength(content.renderings.agentContent, "utf8"),
        title: object?.title ?? content.renderings.summary,
        content: content.renderings.agentContent,
      });
    }

    return { parts, blockers };
  }

  /**
   * A content node stands for an object directly, or for a command output
   * placeholder that has bound to one. An unbound placeholder resolves to
   * nothing, which is what blocks the run.
   */
  private objectIdOf(refId: string): string | null {
    const object = this.state.db
      .select({ id: objects.id })
      .from(objects)
      .where(eq(objects.id, refId))
      .get();
    if (object) return object.id;

    const output = this.state.db
      .select({ boundObjectId: commandOutputs.boundObjectId })
      .from(commandOutputs)
      .where(eq(commandOutputs.id, refId))
      .get();

    return output?.boundObjectId ?? null;
  }

  /**
   * The runs an `output@latest` address currently resolves to — computed the
   * same way `resolve` computes it, per (command, output name) over the
   * highest run ordinal. Anything coarser (newest run per command, say) is an
   * approximation, and an approximation here makes a live address answer null
   * after compaction: retention must never do that (§4.4, §15-4).
   */
  private addressedByLatest(): Set<string> {
    const best = new Map<string, { runId: string; ordinal: number }>();

    for (const row of this.state.db
      .select({
        runId: runOutputs.runId,
        name: runOutputs.name,
        commandId: runs.commandId,
        ordinal: runs.ordinal,
      })
      .from(runOutputs)
      .innerJoin(runs, eq(runs.id, runOutputs.runId))
      .all()) {
      const key = `${row.commandId}\u0000${row.name}`;
      const current = best.get(key);
      if (!current || row.ordinal > current.ordinal) {
        best.set(key, { runId: row.runId, ordinal: row.ordinal });
      }
    }

    const addressed = new Set([...best.values()].map((each) => each.runId));

    // A placeholder's bound run must also keep existing, because
    // command_outputs.bound_run_id is a real foreign key. Binding follows the
    // newest run producing that name, so this is belt and braces rather than a
    // second rule — but a hard FK failure is not the way to discover that.
    for (const row of this.state.db
      .select({ runId: commandOutputs.boundRunId })
      .from(commandOutputs)
      .all()) {
      if (row.runId) addressed.add(row.runId);
    }

    return addressed;
  }

  private referencedVersions(runIds: readonly string[]): string[] {
    if (runIds.length === 0) return [];

    const fromInputs = this.state.db
      .select({ versionId: runInputs.versionId })
      .from(runInputs)
      .where(inArray(runInputs.runId, [...runIds]))
      .all();
    const fromOutputs = this.state.db
      .select({ versionId: runOutputs.versionId })
      .from(runOutputs)
      .where(inArray(runOutputs.runId, [...runIds]))
      .all();

    return [
      ...new Set(
        [...fromInputs, ...fromOutputs].map((row) => row.versionId as string),
      ),
    ];
  }

  private releaseUnreferencedVersions(versionIds: readonly string[]): void {
    for (const versionId of versionIds) {
      const stillIn = this.state.db
        .select({ runId: runInputs.runId })
        .from(runInputs)
        .where(eq(runInputs.versionId, versionId))
        .get();
      const stillOut = this.state.db
        .select({ runId: runOutputs.runId })
        .from(runOutputs)
        .where(eq(runOutputs.versionId, versionId))
        .get();

      if (stillIn || stillOut) continue;

      this.state.db
        .update(objectVersions)
        .set({ runReferenced: false })
        .where(eq(objectVersions.id, versionId))
        .run();
    }
  }

  private nextOrdinal(commandId: string): number {
    const row = this.state.db
      .select({ max: sql<number | null>`MAX(${runs.ordinal})` })
      .from(runs)
      .where(eq(runs.commandId, commandId))
      .get();

    return (row?.max ?? 0) + 1;
  }

  private requireRunning(runId: string): RunRow {
    const row = this.runRow(runId);

    // Proof is point-in-time and written once: a finished run is never
    // silently re-ended, so completion cannot be revoked or rewritten (§3.5).
    if (row.status !== "running") {
      throw new RunRefused({
        reason: "already_ended",
        message: `run ${runId} already ended as ${row.status}`,
      });
    }

    return row;
  }

  private runRow(runId: string): RunRow {
    const row = this.state.db
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .get();
    if (!row) throw new EntityNotFound("run", runId);
    return row;
  }

  private toRun(row: RunRow): Run {
    return {
      id: row.id as RunId,
      commandId: row.commandId as CommandId,
      definitionId: row.definitionId as CommandDefinitionId,
      ordinal: row.ordinal,
      status: row.status,
      assembledBlobId: row.assembledBlobId,
      assembledHash: row.assembledHash,
      assembledBytes: row.assembledBytes,
      configuration: this.configuration(row),
      inputs: this.inputs(row.id),
      cost: {
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        costMicros: row.costMicros,
      },
      spendCapMicros: row.spendCapMicros,
      pinned: row.pinned,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
    };
  }
}

/** Re-exported beside the store that mirrors it, as ObjectStore does. */
export { isRunCompactable };
