import { describe, expect, it } from "vitest";

import { humanAuthor } from "../author.js";
import {
  newNodeId,
  newWorkstreamId,
  type NodeId,
  type ObjectId,
  type VersionId,
} from "../ids.js";
import { deriveDrift, type DriftGraph } from "./drift.js";
import { objectIds, versionIds } from "./testing.js";
import { EMPTY_TRIAGE, applyTriage, driftItemKey } from "./triage.js";

const NOW = 5_000;

const objects = objectIds("ticket", "output", "downstream");
const versions = versionIds("ticketV1", "ticketV2", "outputV1", "downstreamV1");

const command: NodeId = newNodeId();
const downstreamCommand: NodeId = newNodeId();

function graph(overrides: Partial<DriftGraph> = {}): DriftGraph {
  return {
    consumptions: [
      {
        consumer: command,
        objectId: objects.ticket,
        versionId: versions.ticketV1,
        consumedAt: 1_000,
      },
      {
        consumer: downstreamCommand,
        objectId: objects.output,
        versionId: versions.outputV1,
        consumedAt: 1_100,
      },
    ],
    latestVersions: new Map<ObjectId, VersionId>([
      [objects.ticket, versions.ticketV2],
      [objects.output, versions.outputV1],
    ]),
    produces: new Map<NodeId, readonly ObjectId[]>([
      [command, [objects.output]],
    ]),
    ...overrides,
  };
}

describe("drift derivation (§3.2, §4.5)", () => {
  it("flags the consumer of a version that is no longer latest", () => {
    const report = deriveDrift(graph(), { now: NOW });
    const direct = report.flags.find((flag) => flag.consumer === command);

    expect(direct).toMatchObject({
      objectId: objects.ticket,
      consumedVersionId: versions.ticketV1,
      latestVersionId: versions.ticketV2,
      cause: "direct",
    });
  });

  it("flags downstream consumers transitively, naming the origin", () => {
    const report = deriveDrift(graph(), { now: NOW });
    const transitive = report.flags.find(
      (flag) => flag.consumer === downstreamCommand,
    );

    expect(transitive).toMatchObject({
      cause: "transitive",
      via: command,
      originObjectId: objects.ticket,
      objectId: objects.output,
    });
    // The downstream input itself is at its latest version — it drifted
    // because what produced it did.
    expect(transitive?.latestVersionId).toBeNull();
  });

  it("carries drift across as many hops as the graph has", () => {
    const third = newNodeId();
    const report = deriveDrift(
      graph({
        consumptions: [
          ...graph().consumptions,
          {
            consumer: third,
            objectId: objects.downstream,
            versionId: versions.downstreamV1,
            consumedAt: 1_200,
          },
        ],
        produces: new Map<NodeId, readonly ObjectId[]>([
          [command, [objects.output]],
          [downstreamCommand, [objects.downstream]],
        ]),
      }),
      { now: NOW },
    );

    expect(report.flags.map((flag) => flag.consumer)).toContain(third);
    expect(report.flags.find((flag) => flag.consumer === third)).toMatchObject({
      cause: "transitive",
      via: downstreamCommand,
      originObjectId: objects.ticket,
    });
  });

  it("marks a change that arrived from another workstream", () => {
    const consumerWorkstream = newWorkstreamId();
    const report = deriveDrift(
      graph({
        consumerWorkstreams: new Map([
          [command, consumerWorkstream],
          [downstreamCommand, consumerWorkstream],
        ]),
        objectWorkstreams: new Map([[objects.ticket, newWorkstreamId()]]),
      }),
      { now: NOW },
    );

    expect(report.flags.every((flag) => flag.crossWorkstream)).toBe(true);
  });

  it("reports nothing when nothing changed", () => {
    const report = deriveDrift(
      graph({
        latestVersions: new Map([
          [objects.ticket, versions.ticketV1],
          [objects.output, versions.outputV1],
        ]),
      }),
      { now: NOW },
    );

    expect(report.flags).toHaveLength(0);
  });

  it("clears a flag once the consumer's baseline is acknowledged (§4.5)", () => {
    const triage = applyTriage(
      EMPTY_TRIAGE,
      driftItemKey(command, objects.ticket),
      "acknowledge",
      { at: NOW, by: humanAuthor, baselineVersionId: versions.ticketV2 },
    );

    const report = deriveDrift(graph(), { now: NOW, triage });

    expect(report.flags.some((flag) => flag.consumer === command)).toBe(false);
    // Acknowledging advanced a baseline; it started nothing, so the downstream
    // consumer's transitive flag is gone with its cause rather than run.
    expect(report.flags).toHaveLength(0);
  });

  it("keeps a snoozed flag as state but out of the queue", () => {
    const key = driftItemKey(command, objects.ticket);
    const triage = applyTriage(EMPTY_TRIAGE, key, "snooze", {
      at: NOW,
      by: humanAuthor,
      snoozedUntil: NOW + 3_600,
    });

    const report = deriveDrift(graph(), { now: NOW, triage });

    expect(report.flags.some((flag) => flag.consumer === command)).toBe(true);
    expect(report.attention.some((flag) => flag.consumer === command)).toBe(
      false,
    );
  });

  it("brings a snooze back when it elapses", () => {
    const key = driftItemKey(command, objects.ticket);
    const triage = applyTriage(EMPTY_TRIAGE, key, "snooze", {
      at: NOW,
      by: humanAuthor,
      snoozedUntil: NOW + 100,
    });

    const report = deriveDrift(graph(), { now: NOW + 200, triage });

    expect(report.attention.some((flag) => flag.consumer === command)).toBe(
      true,
    );
  });

  it("keeps a muted flag out of the queue forever", () => {
    const triage = applyTriage(
      EMPTY_TRIAGE,
      driftItemKey(command, objects.ticket),
      "mute",
      { at: NOW, by: humanAuthor },
    );

    const report = deriveDrift(graph(), { now: NOW + 10_000_000, triage });

    expect(report.flags.find((flag) => flag.consumer === command)?.triage).toBe(
      "muted",
    );
    expect(report.attention.some((flag) => flag.consumer === command)).toBe(
      false,
    );
  });

  it("counts drift per consumer for the workstream rollup", () => {
    const report = deriveDrift(graph(), { now: NOW });

    expect(report.byConsumer.get(command)).toBe(1);
    expect(report.byConsumer.get(downstreamCommand)).toBe(1);
  });

  it("is a state, not an action: the input graph is untouched", () => {
    const input = graph();
    const snapshot = JSON.stringify(input.consumptions);

    deriveDrift(input, { now: NOW });

    expect(JSON.stringify(input.consumptions)).toBe(snapshot);
  });
});
