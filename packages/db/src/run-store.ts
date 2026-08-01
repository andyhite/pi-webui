import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  checkContentBudget,
  checkSubmission,
  effectiveAskPoints,
  estimateTokens,
  isRunCompactable,
  newRunId,
  systemClock,
  DEFAULT_RUN_RETENTION_POLICY,
  ZERO_COST,
  type AssembledInput,
  type Clock,
  type CommandDefinitionId,
  type CommandId,
  type CompletionProof,
  type ConditionEvaluation,
  type NodeId,
  type ObjectId,
  type OutputAddress,
  type Run,
  type RunConfiguration,
  type RunCost,
  type RunId,
  type RunOutput,
  type RunRetentionPolicy,
  type VersionId,
} from "@plotroom/core";
import { BlobStore } from "./blob-store.js";
import type { PlotroomDatabase } from "./client.js";
import { CommandStore } from "./command-store.js";
import { GraphStore } from "./graph-store.js";
import { ObjectStore } from "./object-store.js";
import {
  commandOutputs,
  objectVersions,
  objects,
  runInputs,
  runOutputs,
  runs,
  type RunRow,
} from "./schema.js";

const BLOB_OWNER = "run";

/** Why a run could not start. Every reason is actionable, never a truncation. */
export type RunRefusal =
  | { readonly reason: "parameters_unconfirmed"; readonly message: string }
  | { readonly reason: "blocked_input"; readonly message: string }
  | { readonly reason: "content_budget"; readonly message: string }
  | { readonly reason: "already_ended"; readonly message: string };

export class RunRefused extends Error {
  constructor(readonly refusal: RunRefusal) {
    super(refusal.message);
    this.name = "RunRefused";
  }
}

export interface StartRunInput {
  readonly commandId: string;
}

export interface StartedRun {
  readonly run: Run;
  /** Present when assembly approached the model's window (§3.5). */
  readonly warning: string | null;
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

  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {
    this.blobs = new BlobStore(state, now);
    this.commands = new CommandStore(state, now);
    this.graph = new GraphStore(state, now);
    this.objects = new ObjectStore(state, now);
  }

  /**
   * Assemble and record a run. Refused rather than degraded when a parameter
   * is still a proposal, when an input is a placeholder nothing has produced
   * yet, or when assembly is over an opt-in hard cap — the product never
   * silently truncates and never silently guesses (§3.5, principle 12).
   */
  start(input: StartRunInput): StartedRun {
    const command = this.commands.command(input.commandId);
    const definition = this.commands.definition(command.definitionId);
    const node = this.commands.commandNode(input.commandId);

    const parameters = this.commands.parameters(input.commandId);
    if (!parameters.ready) {
      const outstanding = [...parameters.unconfirmed, ...parameters.missing];
      throw new RunRefused({
        reason: "parameters_unconfirmed",
        message: `confirm ${outstanding.join(", ")} before running; a derived default is a proposal, not a value`,
      });
    }

    const assembled = this.assemble(node.id);
    const body = assembled
      .map((part) => `## ${part.title}\n\n${part.content}`)
      .join("\n\n");

    const estimated = estimateTokens(body);
    const budget = checkContentBudget(estimated, definition.budget);
    if (budget.state === "refused") {
      throw new RunRefused({
        reason: "content_budget",
        message: budget.message,
      });
    }

    const configuration: RunConfiguration = {
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
    };

    const id = newRunId();
    const at = this.now();
    const blob = this.blobs.put(body, { kind: "assembled_content" });
    this.blobs.reference(blob.id, { ownerKind: BLOB_OWNER, ownerId: id });

    this.state.db
      .insert(runs)
      .values({
        id,
        commandId: input.commandId,
        definitionId: definition.id,
        ordinal: this.nextOrdinal(input.commandId),
        status: "running",
        assembledBlobId: blob.id,
        assembledHash: createHash("sha256").update(body).digest("hex"),
        assembledBytes: Buffer.byteLength(body, "utf8"),
        configJson: JSON.stringify(configuration),
        startedAt: at,
      })
      .run();

    for (const part of assembled) {
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
    this.objects.markRunReferenced(assembled.map((part) => part.versionId));

    return {
      run: this.run(id),
      warning: budget.state === "warn" ? budget.message : null,
    };
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

  /** A human stopped it. */
  stop(runId: string, cost?: RunCost): Run {
    return this.end(runId, "stopped", cost, null);
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
      this.blobs.dereference(row.assembledBlobId, {
        ownerKind: BLOB_OWNER,
        ownerId: row.id,
      });
      this.state.db.delete(runs).where(eq(runs.id, row.id)).run();
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
    status: "failed" | "out_of_budget" | "stopped",
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
   */
  private assemble(
    commandNodeId: string,
  ): Array<
    AssembledInput & { readonly title: string; readonly content: string }
  > {
    const assembled: Array<
      AssembledInput & { readonly title: string; readonly content: string }
    > = [];

    for (const edge of this.graph.contextInputs(commandNodeId)) {
      const source = this.graph.node(edge.fromNode);
      const objectId = this.objectIdOf(source.refId);

      if (!objectId) {
        throw new RunRefused({
          reason: "blocked_input",
          message: `an input has not been produced yet; this command is blocked on ${source.refId}`,
        });
      }

      const content = this.objects.read(objectId);
      const object = this.objects.get(objectId);

      assembled.push({
        ordinal: edge.ordinal ?? assembled.length + 1,
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

    return assembled;
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
    if (!row) throw new Error(`unknown run ${runId}`);
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
      pinned: row.pinned,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
    };
  }
}

/** Re-exported beside the store that mirrors it, as ObjectStore does. */
export { isRunCompactable };
