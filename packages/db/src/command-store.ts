import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  checkPublish,
  confirmParameter,
  effectiveAskPoints,
  effectOfDeletingProducer,
  newCommandDefinitionId,
  newCommandId,
  newOutputId,
  outputBindState,
  resolveParameters,
  systemClock,
  type AskPoint,
  type Author,
  type Clock,
  type CommandDefinition,
  type CommandId,
  type CommandLifecycle,
  type CommandOutput,
  type CommandParameter,
  type ContentBudget,
  type DefinitionSource,
  type Effort,
  type ExpectedOutcome,
  type ObjectId,
  type ObjectKind,
  type OutputBindState,
  type OutputId,
  type ParameterBinding,
  type ParameterResolution,
  type ParameterValue,
  type ProducerDeletionEffect,
  type PublishRefusal,
  type RunId,
  type ToolPermissions,
} from "@plotroom/core";
import type { PlotroomDatabase } from "./client.js";
import { EntityNotFound } from "./errors.js";
import { GraphStore } from "./graph-store.js";
import { ObjectStore } from "./object-store.js";
import {
  commandDefinitions,
  commandOutputs,
  commandParameterBindings,
  commands,
  type CommandDefinitionRow,
  type CommandOutputRow,
  type CommandRow,
  type NodeRow,
} from "./schema.js";

/** Thrown when publish is used where promote is the verb, and vice versa (§3.5). */
export class PublishRefused extends Error {
  constructor(readonly refusal: PublishRefusal) {
    super(refusal.message);
    this.name = "PublishRefused";
  }
}

export interface DefineCommandInput {
  readonly name: string;
  readonly instruction: string;
  readonly model: string;
  readonly effort: Effort;
  readonly lifecycle: CommandLifecycle;
  /** Required for producing definitions, refused for open ones (§3.5). */
  readonly outcome?: ExpectedOutcome | null;
  readonly permissions?: ToolPermissions;
  readonly askPoints?: readonly AskPoint[];
  readonly parameters?: readonly CommandParameter[];
  readonly budget?: ContentBudget;
  readonly source?: DefinitionSource;
  readonly folder?: string | null;
}

/** Everything a definition's user-editable content covers (§3.5). */
export type EditDefinitionInput = Partial<
  Omit<DefineCommandInput, "source"> & { readonly folder: string | null }
>;

export interface InstantiateInput {
  readonly definitionId: string;
  readonly workstreamId: string;
  /** §15 invariant 2: wiring the target is an authored edge. */
  readonly author: Author;
  /**
   * Wired as context in this order, which is assembly order (§3.5). Dropping
   * a definition onto a ticket passes the ticket's node here.
   */
  readonly context?: readonly string[];
}

export interface InstantiatedCommand {
  readonly command: CommandRow;
  readonly node: NodeRow;
  /** Typed placeholders, present before any run (§3.5). */
  readonly outputs: CommandOutputRow[];
}

const DEFAULT_BUDGET: ContentBudget = {
  modelWindowTokens: 200_000,
  warnAtFraction: 0.85,
  hardCapTokens: null,
};

/**
 * Command definitions and command nodes (spec §3.5).
 *
 * Every rule this store enforces is a predicate in @plotroom/core — publish
 * versus promote, parameter confirmation, what deleting a producer does — so
 * the canvas, the API, and agent tools cannot disagree (principle 8). Legality
 * and acyclicity of the wiring belong to GraphStore, which this store calls
 * rather than reimplements.
 */
export class CommandStore {
  private readonly graph: GraphStore;
  private readonly objects: ObjectStore;

  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {
    this.graph = new GraphStore(state, now);
    this.objects = new ObjectStore(state, now);
  }

  /** Create a definition: reusable, editable content, not code (§3.5). */
  define(input: DefineCommandInput): CommandDefinitionRow {
    const id = newCommandDefinitionId();
    const at = this.now();

    if (input.lifecycle === "producing" && !input.outcome) {
      throw new Error("a producing command must declare its expected outcome");
    }
    if (input.lifecycle === "open" && input.outcome) {
      throw new Error("open work has no declared outcome; that is the point");
    }

    this.state.db
      .insert(commandDefinitions)
      .values({
        id,
        name: input.name,
        instruction: input.instruction,
        model: input.model,
        effort: input.effort,
        permissionsJson: JSON.stringify(
          input.permissions ?? { allowed: [], denied: [] },
        ),
        askPointsJson: JSON.stringify(input.askPoints ?? []),
        lifecycle: input.lifecycle,
        outcomeJson: input.outcome ? JSON.stringify(input.outcome) : null,
        parametersJson: JSON.stringify(input.parameters ?? []),
        budgetJson: JSON.stringify(input.budget ?? DEFAULT_BUDGET),
        source: input.source ?? "user",
        folder: input.folder ?? null,
        duplicatedFrom: null,
        createdAt: at,
        updatedAt: at,
      })
      .run();

    return this.definitionRow(id);
  }

  /** Definitions are content: editing one is a normal gesture (§3.5). */
  edit(definitionId: string, patch: EditDefinitionInput): CommandDefinitionRow {
    const current = this.definition(definitionId);
    const next: CommandDefinition = {
      ...current,
      name: patch.name ?? current.name,
      instruction: patch.instruction ?? current.instruction,
      model: {
        model: patch.model ?? current.model.model,
        effort: patch.effort ?? current.model.effort,
      },
      permissions: patch.permissions ?? current.permissions,
      askPoints: patch.askPoints ?? current.askPoints,
      lifecycle: patch.lifecycle ?? current.lifecycle,
      outcome: patch.outcome !== undefined ? patch.outcome : current.outcome,
      parameters: patch.parameters ?? current.parameters,
      budget: patch.budget ?? current.budget,
      folder: patch.folder !== undefined ? patch.folder : current.folder,
      updatedAt: this.now(),
    };

    if (next.lifecycle === "producing" && !next.outcome) {
      throw new Error("a producing command must declare its expected outcome");
    }
    if (next.lifecycle === "open" && next.outcome) {
      throw new Error("open work has no declared outcome; that is the point");
    }

    this.state.db
      .update(commandDefinitions)
      .set({
        name: next.name,
        instruction: next.instruction,
        model: next.model.model,
        effort: next.model.effort,
        permissionsJson: JSON.stringify(next.permissions),
        askPointsJson: JSON.stringify(next.askPoints),
        lifecycle: next.lifecycle,
        outcomeJson: next.outcome ? JSON.stringify(next.outcome) : null,
        parametersJson: JSON.stringify(next.parameters),
        budgetJson: JSON.stringify(next.budget),
        folder: next.folder,
        updatedAt: next.updatedAt,
      })
      .where(eq(commandDefinitions.id, definitionId))
      .run();

    return this.definitionRow(definitionId);
  }

  /** Duplicating is how a user starts from a shipped recipe (§3.5). */
  duplicate(definitionId: string, name?: string): CommandDefinitionRow {
    const source = this.definitionRow(definitionId);
    const id = newCommandDefinitionId();
    const at = this.now();

    this.state.db
      .insert(commandDefinitions)
      .values({
        ...source,
        id,
        name: name ?? `${source.name} (copy)`,
        // A duplicate is the user's own content even when the original shipped.
        source: "user",
        duplicatedFrom: source.id,
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
      })
      .run();

    return this.definitionRow(id);
  }

  /** Organizing is authored: a folder name, or null for the top level (§3.5). */
  organize(definitionId: string, folder: string | null): CommandDefinitionRow {
    this.state.db
      .update(commandDefinitions)
      .set({ folder, updatedAt: this.now() })
      .where(eq(commandDefinitions.id, definitionId))
      .run();

    return this.definitionRow(definitionId);
  }

  definitions(folder?: string | null): CommandDefinition[] {
    const rows = this.state.db
      .select()
      .from(commandDefinitions)
      .where(isNull(commandDefinitions.deletedAt))
      .orderBy(commandDefinitions.name)
      .all();

    return rows
      .filter((row) => folder === undefined || row.folder === folder)
      .map(toDefinition);
  }

  definition(definitionId: string): CommandDefinition {
    return toDefinition(this.definitionRow(definitionId));
  }

  /**
   * Instantiate a command node: a definition plus its wiring (§3.5). A
   * producing definition's outputs become typed placeholders here, before any
   * run, so the whole topology can be composed and then run in any order.
   */
  instantiate(input: InstantiateInput): InstantiatedCommand {
    const definition = this.definition(input.definitionId);
    const id = newCommandId();

    // One gesture, one transaction (principle 9): a refused context edge must
    // not leave a half-instantiated command — a node with no command row, or
    // a placeholder wired nowhere — behind on the board.
    return this.state.db.transaction(() => {
      this.state.db
        .insert(commands)
        .values({
          id,
          definitionId: definition.id,
          workstreamId: input.workstreamId,
          createdAt: this.now(),
        })
        .run();

      const node = this.graph.place({
        role: "command",
        refId: id,
        workstreamId: input.workstreamId,
      });

      const outputs = definition.outcome
        ? [this.declareOutput(id as CommandId, definition.outcome, node.id)]
        : [];

      for (const from of input.context ?? []) {
        this.graph.addContextEdge({ from, to: node.id, author: input.author });
      }

      return { command: this.commandRow(id), node, outputs };
    });
  }

  command(commandId: string): CommandRow {
    return this.commandRow(commandId);
  }

  /** The graph node standing for this command (§3.7). */
  commandNode(commandId: string): NodeRow {
    return this.graph.nodeFor("command", commandId);
  }

  /**
   * Propose a derived default (§3.5). The proposal is recorded as a proposal:
   * it contributes no value until the user confirms it, so nothing downstream
   * can read it by mistake.
   */
  proposeDefault(
    commandId: string,
    name: string,
    proposal: ParameterValue,
    derivedFrom: string,
  ): void {
    this.state.db
      .insert(commandParameterBindings)
      .values({
        commandId,
        name,
        state: "proposed",
        valueJson: JSON.stringify(proposal),
        derivedFrom,
        confirmedAt: null,
      })
      .onConflictDoUpdate({
        target: [
          commandParameterBindings.commandId,
          commandParameterBindings.name,
        ],
        set: {
          state: "proposed",
          valueJson: JSON.stringify(proposal),
          derivedFrom,
          confirmedAt: null,
        },
      })
      .run();
  }

  /** The confirming gesture, and the only path from proposal to value (§3.5). */
  confirmDefault(
    commandId: string,
    name: string,
    replacement?: ParameterValue,
  ): ParameterBinding {
    const existing = this.state.db
      .select()
      .from(commandParameterBindings)
      .where(
        and(
          eq(commandParameterBindings.commandId, commandId),
          eq(commandParameterBindings.name, name),
        ),
      )
      .get();

    if (!existing && replacement === undefined) {
      throw new Error(`no proposal to confirm for parameter ${name}`);
    }

    const at = this.now();
    // Confirming a value with no prior proposal is the ordinary case of a
    // parameter the user simply fills in; the predicate handles both.
    const binding = confirmParameter(
      existing
        ? toBinding(existing)
        : { name, state: "confirmed", value: replacement!, confirmedAt: at },
      at,
      replacement,
    );

    this.state.db
      .insert(commandParameterBindings)
      .values({
        commandId,
        name,
        state: "confirmed",
        valueJson: JSON.stringify(valueOf(binding)),
        derivedFrom: existing?.derivedFrom ?? null,
        confirmedAt: at,
      })
      .onConflictDoUpdate({
        target: [
          commandParameterBindings.commandId,
          commandParameterBindings.name,
        ],
        set: {
          state: "confirmed",
          valueJson: JSON.stringify(valueOf(binding)),
          confirmedAt: at,
        },
      })
      .run();

    return binding;
  }

  bindings(commandId: string): ParameterBinding[] {
    return this.state.db
      .select()
      .from(commandParameterBindings)
      .where(eq(commandParameterBindings.commandId, commandId))
      .all()
      .map(toBinding);
  }

  /** The predicate decides; this only supplies it with rows (§3.5). */
  parameters(commandId: string): ParameterResolution {
    const command = this.commandRow(commandId);
    const definition = this.definition(command.definitionId);
    return resolveParameters(definition.parameters, this.bindings(commandId));
  }

  outputs(commandId: string): CommandOutput[] {
    return this.state.db
      .select()
      .from(commandOutputs)
      .where(eq(commandOutputs.commandId, commandId))
      .all()
      .map(toOutput);
  }

  output(outputId: string): CommandOutput {
    const row = this.state.db
      .select()
      .from(commandOutputs)
      .where(eq(commandOutputs.id, outputId))
      .get();
    if (!row) throw new EntityNotFound("output", outputId);
    return toOutput(row);
  }

  bindState(outputId: string): OutputBindState {
    return outputBindState(this.output(outputId));
  }

  /**
   * Publish (§3.5): mark a *placeholder* world-visible before a run so
   * commands in other workstreams may wire to it. Refused once the output has
   * bound — then the verb is promote, on the object (§3.2).
   */
  publish(outputId: string): CommandOutput {
    const output = this.output(outputId);
    const check = checkPublish(output);
    if (!check.allowed) throw new PublishRefused(check.refusal);

    this.state.db
      .update(commandOutputs)
      .set({ publishedAt: this.now() })
      .where(eq(commandOutputs.id, outputId))
      .run();

    return this.output(outputId);
  }

  /**
   * Post-bind (§3.5): what crosses is the produced object. A published
   * placeholder's object is promoted to world scope here, which is what makes
   * the command dependency evaporate — deleting the command afterward leaves
   * the object intact.
   */
  bindOutput(
    outputId: string,
    binding: { readonly runId: RunId | string; readonly objectId: string },
  ): CommandOutput {
    const output = this.output(outputId);

    this.state.db
      .update(commandOutputs)
      .set({
        boundObjectId: binding.objectId,
        boundRunId: binding.runId,
        boundAt: this.now(),
      })
      .where(eq(commandOutputs.id, outputId))
      .run();

    if (output.publishedAt !== null) this.objects.promote(binding.objectId);

    return this.output(outputId);
  }

  /**
   * Delete a command node. Soft, like every authored deletion (principle 10),
   * and the two-state rule decides what happens downstream: a pre-bind output
   * becomes a visibly broken placeholder and its wires stay exactly where they
   * are, so nothing is silently unblocked; a bound output's object is
   * untouched (§3.5).
   */
  delete(commandId: string): ProducerDeletionEffect[] {
    this.commandRow(commandId);
    const at = this.now();

    // Marking the placeholders broken and marking the command deleted are one
    // gesture: a partially applied delete would leave downstream silently
    // unblocked, which is exactly what §3.5's two-state rule forbids.
    return this.state.db.transaction(() => {
      const effects: ProducerDeletionEffect[] = [];

      for (const output of this.outputs(commandId)) {
        const effect = effectOfDeletingProducer(output);
        effects.push(effect);

        if (effect.effect === "broken_placeholder") {
          this.state.db
            .update(commandOutputs)
            .set({ brokenAt: at })
            .where(eq(commandOutputs.id, output.id))
            .run();
        }
      }

      this.state.db
        .update(commands)
        .set({ deletedAt: at })
        .where(eq(commands.id, commandId))
        .run();

      return effects;
    });
  }

  /** Recoverable, because the deletion was (principle 10). */
  restore(commandId: string): CommandRow {
    this.commandRow(commandId);

    return this.state.db.transaction(() => {
      this.state.db
        .update(commands)
        .set({ deletedAt: null })
        .where(eq(commands.id, commandId))
        .run();

      for (const output of this.outputs(commandId)) {
        if (output.brokenAt === null) continue;
        this.state.db
          .update(commandOutputs)
          .set({ brokenAt: null })
          .where(eq(commandOutputs.id, output.id))
          .run();
      }

      return this.commandRow(commandId);
    });
  }

  /** Soft-deleted commands, the restorable set the undo verb lists (§10). */
  deletedCommands(): CommandRow[] {
    return this.state.db
      .select()
      .from(commands)
      .where(isNotNull(commands.deletedAt))
      .all();
  }

  /**
   * Deleting a definition removes the recipe, never the command nodes already
   * instantiated from it: those carry their own configuration into run history
   * (§15-1). Soft, and restorable, like every authored deletion.
   */
  deleteDefinition(definitionId: string): CommandDefinitionRow {
    this.definitionRow(definitionId);

    this.state.db
      .update(commandDefinitions)
      .set({ deletedAt: this.now() })
      .where(eq(commandDefinitions.id, definitionId))
      .run();

    return this.definitionRow(definitionId);
  }

  restoreDefinition(definitionId: string): CommandDefinitionRow {
    this.definitionRow(definitionId);

    this.state.db
      .update(commandDefinitions)
      .set({ deletedAt: null })
      .where(eq(commandDefinitions.id, definitionId))
      .run();

    return this.definitionRow(definitionId);
  }

  deletedDefinitions(): CommandDefinitionRow[] {
    return this.state.db
      .select()
      .from(commandDefinitions)
      .where(isNotNull(commandDefinitions.deletedAt))
      .all();
  }

  /** Effective ask-points: what would actually be asked at run time (§6.6). */
  askPoints(definitionId: string): readonly AskPoint[] {
    return effectiveAskPoints(this.definition(definitionId).askPoints);
  }

  private declareOutput(
    commandId: CommandId,
    outcome: ExpectedOutcome,
    commandNodeId: string,
  ): CommandOutputRow {
    const id = newOutputId();

    this.state.db
      .insert(commandOutputs)
      .values({
        id,
        commandId,
        name: outcome.name,
        kind: outcome.kind,
        structureJson: outcome.structure
          ? JSON.stringify(outcome.structure)
          : null,
        createdAt: this.now(),
      })
      .run();

    // The placeholder is a content node from the moment it exists, so it can
    // be wired into other commands before any run (§3.5) — and so the cycle
    // check sees topology composed ahead of running it (§3.7).
    const workstreamId = this.commandRow(commandId).workstreamId;
    const outputNode = this.graph.place({
      role: "content",
      refId: id,
      workstreamId,
    });
    this.graph.recordProvenance(
      commandNodeId,
      outputNode.id,
      "command_declares_output",
    );

    const row = this.state.db
      .select()
      .from(commandOutputs)
      .where(eq(commandOutputs.id, id))
      .get();
    if (!row) throw new EntityNotFound("output", id);
    return row;
  }

  private definitionRow(definitionId: string): CommandDefinitionRow {
    const row = this.state.db
      .select()
      .from(commandDefinitions)
      .where(eq(commandDefinitions.id, definitionId))
      .get();
    if (!row) {
      throw new EntityNotFound("command definition", definitionId);
    }
    return row;
  }

  private commandRow(commandId: string): CommandRow {
    const row = this.state.db
      .select()
      .from(commands)
      .where(eq(commands.id, commandId))
      .get();
    if (!row) throw new EntityNotFound("command", commandId);
    return row;
  }
}

export function toDefinition(row: CommandDefinitionRow): CommandDefinition {
  return {
    id: row.id as CommandDefinition["id"],
    name: row.name,
    instruction: row.instruction,
    model: { model: row.model, effort: row.effort },
    permissions: JSON.parse(row.permissionsJson) as ToolPermissions,
    askPoints: JSON.parse(row.askPointsJson) as AskPoint[],
    lifecycle: row.lifecycle,
    outcome: row.outcomeJson
      ? (JSON.parse(row.outcomeJson) as ExpectedOutcome)
      : null,
    parameters: JSON.parse(row.parametersJson) as CommandParameter[],
    budget: JSON.parse(row.budgetJson) as ContentBudget,
    source: row.source,
    folder: row.folder,
    duplicatedFrom: row.duplicatedFrom as CommandDefinition["duplicatedFrom"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `confirmParameter` always returns a confirmed binding; this reads its value. */
function valueOf(binding: ParameterBinding): ParameterValue {
  return binding.state === "confirmed" ? binding.value : binding.proposal;
}

function toBinding(row: {
  name: string;
  state: "proposed" | "confirmed";
  valueJson: string;
  derivedFrom: string | null;
  confirmedAt: number | null;
}): ParameterBinding {
  const value = JSON.parse(row.valueJson) as ParameterValue;

  return row.state === "proposed"
    ? {
        name: row.name,
        state: "proposed",
        proposal: value,
        derivedFrom: row.derivedFrom ?? "unknown",
      }
    : {
        name: row.name,
        state: "confirmed",
        value,
        confirmedAt: row.confirmedAt ?? 0,
      };
}

export function toOutput(row: CommandOutputRow): CommandOutput {
  return {
    id: row.id as OutputId,
    commandId: row.commandId as CommandId,
    name: row.name,
    kind: row.kind as ObjectKind,
    publishedAt: row.publishedAt,
    boundObjectId: row.boundObjectId as ObjectId | null,
    boundRunId: row.boundRunId as RunId | null,
    boundAt: row.boundAt,
    brokenAt: row.brokenAt,
  };
}

/**
 * Re-exported beside the store that mirrors them, the way `isCompactable` is
 * re-exported from ObjectStore: the rule and its enforcement stay one thing.
 */
export { checkPublish, effectOfDeletingProducer, resolveParameters };
