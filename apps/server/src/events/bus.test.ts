import { humanAuthor } from "@plotroom/core";
import { expect, describe, it } from "bun:test";
import { createEventBus } from "./bus.js";

describe("EventBus (Epic 2.1: the publication seam)", () => {
  it("assigns a monotonic sequence number and timestamp to each publish", () => {
    let now = 100;
    const bus = createEventBus(() => now);

    const first = bus.publish({
      entity: "workstream",
      verb: "deleted",
      workstreamId: "ws_1" as never,
      author: humanAuthor,
    });
    now = 200;
    const second = bus.publish({
      entity: "workstream",
      verb: "deleted",
      workstreamId: "ws_2" as never,
      author: humanAuthor,
    });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.occurredAt).toBe(100);
    expect(second.occurredAt).toBe(200);
    expect(first.id).not.toBe(second.id);
  });

  it("delivers a published event to every current subscriber", () => {
    const bus = createEventBus(() => 0);
    const received: unknown[] = [];
    const receivedTwo: unknown[] = [];
    bus.subscribe((event) => received.push(event));
    bus.subscribe((event) => receivedTwo.push(event));

    bus.publish({
      entity: "run",
      verb: "deleted",
      runId: "run_1" as never,
      author: humanAuthor,
    });

    expect(received).toHaveLength(1);
    expect(receivedTwo).toHaveLength(1);
  });

  it("stops delivering to a subscriber after it unsubscribes", () => {
    const bus = createEventBus(() => 0);
    const received: unknown[] = [];
    const unsubscribe = bus.subscribe((event) => received.push(event));

    unsubscribe();
    bus.publish({
      entity: "run",
      verb: "deleted",
      runId: "run_1" as never,
      author: humanAuthor,
    });

    expect(received).toHaveLength(0);
  });

  it("reports nextSeq as the sequence the next publish will use", () => {
    const bus = createEventBus(() => 0);
    expect(bus.nextSeq).toBe(1);
    bus.publish({
      entity: "run",
      verb: "deleted",
      runId: "run_1" as never,
      author: humanAuthor,
    });
    expect(bus.nextSeq).toBe(2);
  });
});
