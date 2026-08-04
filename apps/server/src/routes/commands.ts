import { Hono } from "hono";
import { z } from "zod";
import {
  ASK_POINTS,
  EFFORT_LEVELS,
  OBJECT_KINDS,
  PARAMETER_TYPES,
  type CommandParameter,
  type ExpectedOutcome,
} from "@plotroom/core";
import { toDefinition, toOutput, type EditDefinitionInput } from "@plotroom/db";
import { validateJsonBody } from "../http/validate.js";
import {
  destroyCommand,
  destroyCommandDefinition,
} from "../approvals/destruction.js";
import {
  actorOf,
  body,
  destructionGate,
  param,
  type ApiEnv,
  type ApiStores,
} from "./api.js";
import { toCommandNode, toEdge, toPlacedNode } from "./mappers.js";

const permissions = z.object({
  allowed: z.array(z.string()),
  denied: z.array(z.string()),
});

/**
 * World conditions (§3.5): predicates checked against the outside world, so
 * completion is proof rather than a claim. The description is what comes back
 * as feedback when one fails, which is why it is not optional.
 */
const condition = z.object({
  id: z.string().min(1),
  predicate: z.string().min(1),
  description: z.string().min(1),
  args: z.record(z.string(), z.string()).optional(),
});

const outcome = z.object({
  name: z.string().min(1),
  kind: z.enum(OBJECT_KINDS),
  structure: z.record(z.string(), z.unknown()).optional(),
  conditions: z.array(condition).default([]),
});

const parameter = z
  .object({
    name: z.string().min(1),
    label: z.string(),
    type: z.enum(PARAMETER_TYPES),
    required: z.boolean(),
    options: z.array(z.string()).optional(),
  })
  .transform((value): CommandParameter => ({
    name: value.name,
    label: value.label,
    type: value.type,
    required: value.required,
    ...(value.options !== undefined ? { options: value.options } : {}),
  }));

const budget = z.object({
  modelWindowTokens: z.number().int().positive(),
  warnAtFraction: z.number().positive().max(1),
  hardCapTokens: z.number().int().positive().nullable(),
});

const defineBody = z.object({
  name: z.string().min(1),
  instruction: z.string().min(1),
  model: z.string().min(1),
  effort: z.enum(EFFORT_LEVELS),
  lifecycle: z.enum(["producing", "open"]),
  outcome: outcome.nullable().optional(),
  permissions: permissions.optional(),
  askPoints: z.array(z.enum(ASK_POINTS)).optional(),
  parameters: z.array(parameter).optional(),
  budget: budget.optional(),
  folder: z.string().nullable().optional(),
});

const editBody = defineBody.partial();

const duplicateBody = z.object({ name: z.string().min(1).optional() });

const instantiateBody = z.object({
  definitionId: z.string().min(1),
  workstreamId: z.string().min(1),
  /** Dropped onto a ticket: the ticket's node, wired as context (§3.5). */
  context: z.array(z.string().min(1)).optional(),
});

const confirmBody = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

/**
 * Commands (spec §3.5): definitions as editable content, command nodes as
 * instances on the graph, and the publish verb on a typed output placeholder.
 *
 * Two §3.5 rules show up here as refusals rather than as documentation: a
 * producing definition must declare its outcome and an open one must not, and
 * publish is refused once an output has bound — then the verb is promote, on
 * the object (`POST /api/objects/:id/promote`).
 */
export function commandRoutes(stores: ApiStores): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const { commands, graph, bus } = stores;

  app.post("/command-definitions", validateJsonBody(defineBody), (c) => {
    const input = body<z.infer<typeof defineBody>>(c);
    const author = actorOf(c);
    const row = commands.define({
      name: input.name,
      instruction: input.instruction,
      model: input.model,
      effort: input.effort,
      lifecycle: input.lifecycle,
      ...(input.outcome !== undefined
        ? { outcome: toOutcome(input.outcome) }
        : {}),
      ...(input.permissions ? { permissions: input.permissions } : {}),
      ...(input.askPoints ? { askPoints: input.askPoints } : {}),
      ...(input.parameters ? { parameters: input.parameters } : {}),
      ...(input.budget ? { budget: input.budget } : {}),
      ...(input.folder !== undefined ? { folder: input.folder } : {}),
    });

    const definition = toDefinition(row);
    bus.publish({
      entity: "command_definition",
      verb: "created",
      definition,
      author,
    });

    return c.json({ definition }, 201);
  });

  app.get("/command-definitions", (c) => {
    const folder = c.req.query("folder");
    return c.json({
      definitions: commands.definitions(
        folder === undefined ? undefined : folder === "" ? null : folder,
      ),
    });
  });

  app.get("/command-definitions/:id", (c) =>
    c.json({
      definition: commands.definition(param(c, "id")),
      askPoints: commands.askPoints(param(c, "id")),
    }),
  );

  app.patch("/command-definitions/:id", validateJsonBody(editBody), (c) => {
    const input = body<z.infer<typeof editBody>>(c);
    const author = actorOf(c);
    const definition = toDefinition(
      commands.edit(param(c, "id"), toEditInput(input)),
    );

    bus.publish({
      entity: "command_definition",
      verb: "updated",
      definition,
      author,
    });

    return c.json({ definition });
  });

  /** Duplicating is how a user starts from a shipped recipe (§3.5). */
  app.post(
    "/command-definitions/:id/duplicate",
    validateJsonBody(duplicateBody),
    (c) => {
      const input = body<z.infer<typeof duplicateBody>>(c);
      const author = actorOf(c);
      const definition = toDefinition(
        commands.duplicate(param(c, "id"), input.name),
      );

      bus.publish({
        entity: "command_definition",
        verb: "created",
        definition,
        author,
      });

      return c.json({ definition }, 201);
    },
  );

  app.delete("/command-definitions/:id", (c) => {
    const id = param(c, "id");
    destroyCommandDefinition(stores, bus, id, destructionGate(c));

    return c.json({
      definition: toDefinition(commands.definitionRow(id)),
      restorable: true,
    });
  });

  app.post("/command-definitions/:id/restore", (c) => {
    const id = param(c, "id");
    const author = actorOf(c);
    const wasDeleted = commands.definitionRow(id).deletedAt !== null;
    const definition = toDefinition(commands.restoreDefinition(id));

    if (wasDeleted) {
      bus.publish({
        entity: "command_definition",
        verb: "created",
        definition,
        author,
      });
    }

    return c.json({ definition });
  });

  /**
   * Instantiate a command node: a definition plus its wiring (§3.5). A
   * producing definition's output becomes a typed placeholder here, before any
   * run, which is what makes the whole topology composable up front — and what
   * lets the cycle check see it.
   */
  app.post("/commands", validateJsonBody(instantiateBody), (c) => {
    const input = body<z.infer<typeof instantiateBody>>(c);
    const author = actorOf(c);
    const instantiated = commands.instantiate({
      definitionId: input.definitionId,
      workstreamId: input.workstreamId,
      author,
      ...(input.context ? { context: input.context } : {}),
    });

    const command = toCommandNode(instantiated.command);
    bus.publish({ entity: "command", verb: "created", command, author });
    bus.publish({
      entity: "node",
      verb: "created",
      node: toPlacedNode(instantiated.node),
      author,
    });
    for (const output of instantiated.outputs) {
      bus.publish({
        entity: "command_output",
        verb: "created",
        output: toOutput(output),
        author,
      });
    }

    // Dropping a definition onto a ticket wires the ticket in the same
    // gesture (§3.5), and those edges are authored edges like any other — a
    // subscriber that never heard about them would render the command with no
    // context until it refetched.
    const wired = graph.contextInputs(instantiated.node.id);
    for (const edge of wired) {
      bus.publish({
        entity: "edge",
        verb: "created",
        edge: toEdge(edge),
        author,
      });
    }

    return c.json(
      {
        command,
        node: toPlacedNode(instantiated.node),
        outputs: instantiated.outputs.map((row) => toOutput(row)),
        inputs: wired.map((edge) => toEdge(edge)),
      },
      201,
    );
  });

  app.get("/commands/:id", (c) => {
    const id = param(c, "id");
    return c.json({
      command: toCommandNode(commands.command(id)),
      node: toPlacedNode(commands.commandNode(id)),
      outputs: commands.outputs(id),
      parameters: commands.parameters(id),
      bindings: commands.bindings(id),
    });
  });

  app.delete("/commands/:id", (c) => {
    const id = param(c, "id");
    const { effects } = destroyCommand(stores, bus, id, destructionGate(c));

    return c.json({ effects, restorable: true });
  });

  app.post("/commands/:id/restore", (c) => {
    const id = param(c, "id");
    const author = actorOf(c);
    const wasDeleted = commands.command(id).deletedAt !== null;
    const command = toCommandNode(commands.restore(id));

    if (wasDeleted) {
      bus.publish({ entity: "command", verb: "created", command, author });
      for (const output of commands.outputs(id)) {
        bus.publish({
          entity: "command_output",
          verb: "updated",
          output,
          author,
        });
      }
    }

    return c.json({ command, outputs: commands.outputs(id) });
  });

  /**
   * The confirming gesture, and the only path from proposal to value (§3.5):
   * a derived default contributes nothing until a human confirms it, and
   * starting a run with one outstanding is refused rather than guessed.
   */
  app.post(
    "/commands/:id/parameters/:name/confirm",
    validateJsonBody(confirmBody),
    (c) => {
      const id = param(c, "id");
      const input = body<z.infer<typeof confirmBody>>(c);
      const author = actorOf(c);
      const binding = commands.confirmDefault(
        id,
        param(c, "name"),
        input.value,
      );

      bus.publish({
        entity: "command",
        verb: "updated",
        command: toCommandNode(commands.command(id)),
        author,
      });

      return c.json({ binding, parameters: commands.parameters(id) });
    },
  );

  /**
   * Publish (§3.5): mark a *placeholder* world-visible before a run, so
   * commands in other workstreams may wire to it. Refused once it has bound —
   * publish and promote are two verbs, and the store's predicate says so.
   */
  app.post("/outputs/:id/publish", (c) => {
    const author = actorOf(c);
    const output = commands.publish(param(c, "id"));

    bus.publish({
      entity: "command_output",
      verb: "updated",
      output,
      author,
    });

    return c.json({ output, bindState: commands.bindState(output.id) });
  });

  app.get("/outputs/:id", (c) => {
    const output = commands.output(param(c, "id"));
    return c.json({
      output,
      bindState: commands.bindState(output.id),
      node: toPlacedNode(graph.nodeFor("content", output.id)),
    });
  });

  return app;
}

/**
 * Zod's optional fields arrive as present-and-undefined; the domain types say
 * absent. Normalizing here keeps "a structure was not supplied" and "a
 * structure of undefined was supplied" from becoming two different things.
 */
function toOutcome(
  value: z.infer<typeof outcome> | null,
): ExpectedOutcome | null {
  if (value === null) return null;

  return {
    name: value.name,
    kind: value.kind,
    conditions: value.conditions.map((one) => ({
      id: one.id,
      predicate: one.predicate,
      description: one.description,
      ...(one.args !== undefined ? { args: one.args } : {}),
    })),
    ...(value.structure !== undefined ? { structure: value.structure } : {}),
  };
}

function toEditInput(input: z.infer<typeof editBody>): EditDefinitionInput {
  const patch: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    patch[key] = key === "outcome" ? toOutcome(value as never) : value;
  }

  return patch as EditDefinitionInput;
}
