import {
  deriveDrift,
  type DriftFlag,
  type DriftReport,
  type NodeId,
  type ObjectId,
  type VersionId,
  type WorkstreamId,
} from "@plotroom/core";
import type { ApiStores } from "../routes/api.js";

/**
 * Drift, derived over what runs actually consumed (§3.2, §4.5).
 *
 * The rule is `@plotroom/core`'s `deriveDrift`, one pure function over recorded
 * consumption. What lives here is the graph it is given, which only the store can
 * build: what each command's newest run read, which version each of those objects
 * is on now, and what each command produced so drift can travel downstream.
 *
 * **Drift is a state, never an action.** Nothing here starts, queues, or
 * schedules anything (principle 2). "Re-run all drifted" is a human gesture over
 * these flags, and it is the caller that makes it.
 *
 * The newest run per command is the consumer, deliberately: every historical run
 * consumed some older version, so counting them all would report a command as
 * drifted for every run it ever had rather than for what it currently reflects.
 */
export function deriveBoardDrift(stores: ApiStores): DriftReport {
  const consumptions: {
    readonly consumer: NodeId;
    readonly objectId: ObjectId;
    readonly versionId: VersionId;
    readonly consumedAt: number;
  }[] = [];
  const produces = new Map<NodeId, ObjectId[]>();
  const consumerWorkstreams = new Map<NodeId, WorkstreamId | null>();
  const objectWorkstreams = new Map<ObjectId, WorkstreamId | null>();
  const latestVersions = new Map<ObjectId, VersionId>();

  for (const command of stores.commands.liveCommands()) {
    const node = stores.commands.commandNode(command.id);
    const nodeId = node.id as NodeId;
    consumerWorkstreams.set(
      nodeId,
      (command.workstreamId as WorkstreamId | null) ?? null,
    );

    const history = stores.runs.history(command.id);
    const newest = history.at(-1);
    if (newest !== undefined) {
      for (const input of stores.runs.inputs(newest.id)) {
        consumptions.push({
          consumer: nodeId,
          objectId: input.objectId,
          versionId: input.versionId,
          consumedAt: newest.startedAt,
        });
      }
    }

    // The edge drift travels down: a command's outputs are what its consumers
    // consume, so a drifted command makes everything it produced suspect.
    const produced = stores.commands
      .outputs(command.id)
      .map((output) => output.boundObjectId)
      .filter((objectId): objectId is ObjectId => objectId !== null);
    if (produced.length > 0) produces.set(nodeId, produced);
  }

  for (const object of stores.objects.live()) {
    objectWorkstreams.set(
      object.id as ObjectId,
      (object.workstreamId as WorkstreamId | null) ?? null,
    );
    // The current version, read the same way assembly reads it, so "the version
    // a run consumed" and "the version there is now" are comparable facts.
    latestVersions.set(
      object.id as ObjectId,
      stores.objects.read(object.id).versionId as VersionId,
    );
  }

  return deriveDrift(
    {
      consumptions,
      latestVersions,
      produces,
      consumerWorkstreams,
      objectWorkstreams,
    },
    { now: stores.clock() },
  );
}

/**
 * Which commands are drifted, in the scope asked for.
 *
 * `attention` rather than every flag: acknowledged, snoozed, and muted drift is
 * still true, but "re-run all drifted" is a triage gesture and a feed you learned
 * to ignore is worse than none (§4.5). A command with no visible flag is not
 * re-run — **the scope never runs anything that is not drifted.**
 */
export function driftedCommands(
  stores: ApiStores,
  scope: { readonly workstreamId?: string } = {},
): readonly {
  readonly commandId: string;
  readonly flags: readonly DriftFlag[];
}[] {
  const report = deriveBoardDrift(stores);
  const byCommand = new Map<string, DriftFlag[]>();

  for (const flag of report.attention) {
    const node = stores.graph.node(flag.consumer);
    if (node.role !== "command") continue;
    if (
      scope.workstreamId !== undefined &&
      node.workstreamId !== scope.workstreamId
    ) {
      continue;
    }
    const existing = byCommand.get(node.refId);
    if (existing) existing.push(flag);
    else byCommand.set(node.refId, [flag]);
  }

  return [...byCommand].map(([commandId, flags]) => ({ commandId, flags }));
}
