import type { NodeId, ObjectId, VersionId, WorkstreamId } from "../ids.js";
import type { TriageLedger, TriageStatus } from "./triage.js";
import { driftItemKey, isVisible, triageStatus } from "./triage.js";

/**
 * Drift derivation (§3.2, §4.5).
 *
 * "When content changes after work consumed it, everything that consumed the
 * old version is flagged drifted — transitively, per consumer, across
 * workstreams. Drift is how the world talks to the board: a review lands
 * overnight, and by morning the board knows, though nothing has run and nothing
 * will until a human decides."
 *
 * **Drift is a state, never an action.** This module is one pure function over
 * recorded consumption. It returns flags. It starts nothing, queues nothing,
 * and schedules nothing — the product never originates work (principle 2).
 */

/** What a consumer read, and which version of it (§15 invariant 1). */
export interface Consumption {
  /** The command or session node that consumed the content. */
  readonly consumer: NodeId;
  readonly objectId: ObjectId;
  readonly versionId: VersionId;
  readonly consumedAt: number;
}

export interface DriftGraph {
  readonly consumptions: readonly Consumption[];
  /** Current version per object; an object absent from the map has not changed. */
  readonly latestVersions: ReadonlyMap<ObjectId, VersionId>;
  /**
   * What each consumer produced — a command's outputs, a session's transcript
   * and objects. This is the edge drift travels down.
   */
  readonly produces: ReadonlyMap<NodeId, readonly ObjectId[]>;
  /** Null for a world object or a consumer outside any workstream. */
  readonly consumerWorkstreams?: ReadonlyMap<NodeId, WorkstreamId | null>;
  readonly objectWorkstreams?: ReadonlyMap<ObjectId, WorkstreamId | null>;
}

export type DriftCause = "direct" | "transitive";

export interface DriftFlag {
  readonly consumer: NodeId;
  /** The input that is stale, or whose producer drifted. */
  readonly objectId: ObjectId;
  readonly consumedVersionId: VersionId;
  /** Null when the input itself did not change (a transitive flag). */
  readonly latestVersionId: VersionId | null;
  readonly cause: DriftCause;
  /** For a transitive flag: the upstream consumer whose drift propagated here. */
  readonly via: NodeId | null;
  /** The object whose change started this, however many hops upstream. */
  readonly originObjectId: ObjectId;
  /** The change came from outside this consumer's workstream (§3.2). */
  readonly crossWorkstream: boolean;
  readonly triage: TriageStatus;
}

export interface DriftReport {
  /** Every flag, including muted and snoozed ones — the state is still true. */
  readonly flags: readonly DriftFlag[];
  /** What the queue shows right now (§7.1). */
  readonly attention: readonly DriftFlag[];
  /** Per-consumer counts, for the workstream rollup (§3.3). */
  readonly byConsumer: ReadonlyMap<NodeId, number>;
}

export interface DriftContext {
  readonly now: number;
  readonly triage?: TriageLedger;
}

/**
 * Derive the drift state of a graph of consumption.
 *
 * Transitivity is a fixpoint over `produces`: a consumer whose input drifted
 * makes everything it produced suspect, and every consumer of those objects
 * drifts in turn — for as many hops as the graph has. Command topology is
 * acyclic (§3.7), but a visited set guards the traversal anyway, because a
 * session ↔ session relationship legitimately is not.
 */
export function deriveDrift(
  graph: DriftGraph,
  context: DriftContext,
): DriftReport {
  const triage = context.triage;
  const consumersOf = new Map<ObjectId, Consumption[]>();
  for (const consumption of graph.consumptions) {
    const list = consumersOf.get(consumption.objectId);
    if (list) list.push(consumption);
    else consumersOf.set(consumption.objectId, [consumption]);
  }

  const flags = new Map<string, DriftFlag>();
  const queue: {
    readonly objectId: ObjectId;
    readonly originObjectId: ObjectId;
    readonly cause: DriftCause;
    readonly via: NodeId | null;
  }[] = [];

  // Seed: every object whose latest version is not the consumed one.
  for (const objectId of consumersOf.keys()) {
    queue.push({
      objectId,
      originObjectId: objectId,
      cause: "direct",
      via: null,
    });
  }

  const visitedConsumers = new Set<NodeId>();

  while (queue.length > 0) {
    const item = queue.shift() as (typeof queue)[number];
    const latest = graph.latestVersions.get(item.objectId) ?? null;

    for (const consumption of consumersOf.get(item.objectId) ?? []) {
      const stale =
        item.cause === "transitive" ||
        (latest !== null && latest !== consumption.versionId);
      if (!stale) continue;

      const key = driftItemKey(consumption.consumer, consumption.objectId);
      const status = triageStatus(triage?.get(key), context.now);
      const acknowledgedBaseline = triage?.get(key)?.baselineVersionId ?? null;
      if (
        item.cause === "direct" &&
        acknowledgedBaseline !== null &&
        acknowledgedBaseline === latest
      ) {
        // Acknowledged at this exact version: the baseline advanced, so there
        // is no drift to report until the next change (§4.5).
        continue;
      }

      if (!flags.has(key)) {
        flags.set(key, {
          consumer: consumption.consumer,
          objectId: consumption.objectId,
          consumedVersionId: consumption.versionId,
          latestVersionId: item.cause === "direct" ? latest : null,
          cause: item.cause,
          via: item.via,
          originObjectId: item.originObjectId,
          crossWorkstream: crossesWorkstream(
            graph,
            consumption.consumer,
            item.originObjectId,
          ),
          triage: status,
        });
      }

      if (visitedConsumers.has(consumption.consumer)) continue;
      visitedConsumers.add(consumption.consumer);

      for (const produced of graph.produces.get(consumption.consumer) ?? []) {
        queue.push({
          objectId: produced,
          originObjectId: item.originObjectId,
          cause: "transitive",
          via: consumption.consumer,
        });
      }
    }
  }

  const ordered = [...flags.values()].sort(
    (a, b) =>
      a.consumer.localeCompare(b.consumer) ||
      a.objectId.localeCompare(b.objectId),
  );

  const byConsumer = new Map<NodeId, number>();
  for (const flag of ordered) {
    byConsumer.set(flag.consumer, (byConsumer.get(flag.consumer) ?? 0) + 1);
  }

  return {
    flags: ordered,
    attention: ordered.filter((flag) => isVisible(flag.triage)),
    byConsumer,
  };
}

function crossesWorkstream(
  graph: DriftGraph,
  consumer: NodeId,
  objectId: ObjectId,
): boolean {
  const consumerWorkstream = graph.consumerWorkstreams?.get(consumer) ?? null;
  const objectWorkstream = graph.objectWorkstreams?.get(objectId) ?? null;
  if (consumerWorkstream === null || objectWorkstream === null) return false;
  return consumerWorkstream !== objectWorkstream;
}
