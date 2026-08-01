import type { RunScopeKind } from "@plotroom/core";
import type { ApiStores } from "../routes/api.js";
import { badRequest } from "../http/errors.js";
import { driftedCommands } from "./drift.js";

/**
 * What a scoped run covers (§4.1).
 *
 * "One initiation may cover: **run one** — this command; **run subgraph** — this
 * plus everything downstream that becomes runnable, in dependency order; **run
 * what's missing** — the upstream chain that would unblock a blocked command;
 * **re-run all drifted** — within a workstream, or fleet-wide."
 *
 * Every scope here resolves to an ordered list of commands and nothing else. The
 * order is a dependency order, because a subgraph run whose downstream command
 * started before its input existed would be a run of the wrong thing.
 *
 * The dependency relation is read off the graph rather than declared: a command
 * depends on another when one of its context inputs is that command's output —
 * either the placeholder itself, or the object the placeholder bound to. There is
 * no second notion of "depends on" anywhere in the product.
 */
export interface ScopedCommand {
  readonly commandId: string;
  /** Dependency order within the scope; 1-based, stable. */
  readonly position: number;
  /**
   * Why this command is in the scope. Shown in the preview, so "waiting on: …"
   * and "drifted because …" are the scope's own words rather than a guess.
   */
  readonly reason: string;
}

export interface ResolvedScope {
  readonly scope: RunScopeKind;
  readonly scopeId: string | null;
  readonly commands: readonly ScopedCommand[];
}

/** The commands whose outputs this command consumes. */
export function dependenciesOf(
  stores: ApiStores,
  commandId: string,
): readonly string[] {
  const node = stores.commands.commandNode(commandId);
  const producers = new Set<string>();

  for (const edge of stores.graph.contextInputs(node.id)) {
    const source = stores.graph.node(edge.fromNode);
    const producer = producerOf(stores, source.refId);
    if (producer !== null && producer !== commandId) producers.add(producer);
  }

  return [...producers];
}

/** The commands that consume this command's outputs. */
export function dependentsOf(
  stores: ApiStores,
  commandId: string,
): readonly string[] {
  const consumers = new Set<string>();

  for (const command of stores.commands.liveCommands()) {
    if (command.id === commandId) continue;
    if (dependenciesOf(stores, command.id).includes(commandId)) {
      consumers.add(command.id);
    }
  }

  return [...consumers];
}

/**
 * Which command produces the object (or placeholder) a content node stands for.
 *
 * A placeholder names its command directly; a bound object is found through the
 * output that bound it. An input that is nobody's output has no producer, which is
 * exactly the "blocked on something a human must supply" case.
 */
function producerOf(stores: ApiStores, refId: string): string | null {
  for (const output of stores.commands.allOutputs()) {
    if (output.id === refId) return output.commandId;
    if (output.boundObjectId !== null && output.boundObjectId === refId) {
      return output.commandId;
    }
  }
  return null;
}

export function resolveScope(
  stores: ApiStores,
  input: { readonly scope: RunScopeKind; readonly scopeId: string | null },
): ResolvedScope {
  switch (input.scope) {
    case "one":
      return {
        ...input,
        commands: [
          {
            commandId: requireCommand(stores, input.scopeId),
            position: 1,
            reason: "the command you asked for",
          },
        ],
      };

    case "subgraph":
      return {
        ...input,
        commands: subgraph(stores, requireCommand(stores, input.scopeId)),
      };

    case "missing":
      return {
        ...input,
        commands: missing(stores, requireCommand(stores, input.scopeId)),
      };

    case "drifted-workstream":
      return {
        ...input,
        commands: drifted(stores, {
          workstreamId: requireId(input.scopeId, "a workstream"),
        }),
      };

    case "drifted-fleet":
      return { ...input, commands: drifted(stores, {}) };
  }
}

/**
 * "This plus everything downstream that becomes runnable, in dependency order."
 *
 * Downstream is transitive, and the order is a topological one over the
 * dependency relation restricted to the scope — a command whose producer is also
 * in the scope must come after it, and a command whose producers are all outside
 * it can go as soon as the root has.
 */
function subgraph(
  stores: ApiStores,
  commandId: string,
): readonly ScopedCommand[] {
  const included = new Set<string>([commandId]);
  const queue = [commandId];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const dependent of dependentsOf(stores, current)) {
      if (included.has(dependent)) continue;
      included.add(dependent);
      queue.push(dependent);
    }
  }

  return order(stores, included, (id) =>
    id === commandId
      ? "the command you asked for"
      : "downstream of it, and runnable once its inputs exist",
  );
}

/**
 * "The run affordance never disables; a blocked command shows *waiting on: …* and
 * offers to reveal and run the upstream chain that would unblock it, asking once."
 *
 * So this scope is the upstream chain **plus** the command itself, in dependency
 * order: one confirmation covers the chain, and the blocked command runs last
 * because by then its inputs exist.
 */
function missing(
  stores: ApiStores,
  commandId: string,
): readonly ScopedCommand[] {
  const included = new Set<string>([commandId]);
  const queue = [commandId];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const dependency of dependenciesOf(stores, current)) {
      if (included.has(dependency)) continue;
      included.add(dependency);
      queue.push(dependency);
    }
  }

  return order(stores, included, (id) =>
    id === commandId
      ? "the command you asked for"
      : "upstream of it: running this is what unblocks the one you asked for",
  );
}

/**
 * "Re-run all drifted — within a workstream, or fleet-wide."
 *
 * Never anything that is not drifted, and never on a schedule: this is a human
 * gesture over derived state (principle 2). The reason names the object whose
 * change started it, so the confirmation is about something rather than a count.
 */
function drifted(
  stores: ApiStores,
  scope: { readonly workstreamId?: string },
): readonly ScopedCommand[] {
  const flagged = driftedCommands(stores, scope);
  const reasons = new Map(
    flagged.map((entry) => [
      entry.commandId,
      `drifted: ${entry.flags.length} input${entry.flags.length === 1 ? "" : "s"} changed since this last ran (${entry.flags
        .map((flag) => flag.originObjectId)
        .join(", ")})`,
    ]),
  );

  return order(
    stores,
    new Set(flagged.map((entry) => entry.commandId)),
    (id) => reasons.get(id) ?? "drifted",
  );
}

/**
 * Dependency order over a set of commands: Kahn's algorithm restricted to the
 * set, with a deterministic tie-break so the same scope always previews the same
 * way. A cycle cannot happen — command topology is acyclic (§3.7, `wouldCycle`) —
 * but anything left over is appended rather than dropped, because silently losing
 * a command from a scope the operator confirmed would be worse than running it in
 * an imperfect order.
 */
function order(
  stores: ApiStores,
  included: ReadonlySet<string>,
  reason: (commandId: string) => string,
): readonly ScopedCommand[] {
  const remaining = new Set(included);
  const ordered: string[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) =>
        dependenciesOf(stores, id).every(
          (dependency) => !remaining.has(dependency),
        ),
      )
      .sort();

    if (ready.length === 0) {
      ordered.push(...[...remaining].sort());
      break;
    }

    for (const id of ready) {
      ordered.push(id);
      remaining.delete(id);
    }
  }

  return ordered.map((commandId, index) => ({
    commandId,
    position: index + 1,
    reason: reason(commandId),
  }));
}

function requireCommand(stores: ApiStores, scopeId: string | null): string {
  const id = requireId(scopeId, "a command");
  // Reads through the store, so an id naming nothing is the same 404 every other
  // command read reports.
  stores.commands.command(id);
  return id;
}

function requireId(scopeId: string | null, what: string): string {
  if (scopeId === null || scopeId.length === 0) {
    throw badRequest(`this scope needs ${what} to take the scope from`);
  }
  return scopeId;
}
