import { describe, expect, it } from "bun:test";
import type { SessionHostEvent } from "@plotroom/core";

import { createRequestBridge, type RequestBridge } from "./request-bridge.js";

interface Harness {
  readonly frames: SessionHostEvent[];
  readonly bridge: RequestBridge;
}

function harness(): Harness {
  const frames: SessionHostEvent[] = [];
  const bridge = createRequestBridge(
    (frame) => frames.push(frame),
    () => 1_000,
  );
  return { frames, bridge };
}

function requestIdOf(frame: SessionHostEvent | undefined): string {
  const observation =
    frame?.type === "observation" ? frame.observation : undefined;
  if (observation?.kind !== "request-raised") {
    throw new Error("expected a request-raised observation");
  }
  return observation.requestId;
}

describe("the request bridge (issue #81)", () => {
  it("raises a request-raised observation and resolves once settled", async () => {
    const { frames, bridge } = harness();

    const answered = bridge.raise({
      kind: "tool-permission",
      toolName: "bash",
      input: { command: "ls" },
    });

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "observation",
      observation: {
        kind: "request-raised",
        request: {
          kind: "tool-permission",
          toolName: "bash",
          input: { command: "ls" },
        },
        at: 1_000,
      },
    });
    const requestId = requestIdOf(frames[0]);

    expect(bridge.settle(requestId, { kind: "allow" })).toBe(true);
    await expect(answered).resolves.toEqual({ kind: "allow" });

    // The sidecar's own fact: nothing else observes that the answer reached
    // the blocked call.
    expect(frames).toContainEqual({
      type: "observation",
      observation: {
        kind: "request-settled",
        requestId,
        outcome: { kind: "allow" },
        at: 1_000,
      },
    });
  });

  it("refuses to settle an id nothing raised, or already settled", () => {
    const { frames, bridge } = harness();
    bridge.raise({ kind: "question", text: "?", options: [] });
    const requestId = requestIdOf(frames[0]);

    expect(bridge.settle("never-raised", { kind: "deny", reason: "x" })).toBe(
      false,
    );

    expect(bridge.settle(requestId, { kind: "allow" })).toBe(true);
    // Settled once already: a second answer to the same call would tell
    // PlotRoom a blocked call had been released twice.
    expect(bridge.settle(requestId, { kind: "allow" })).toBe(false);
  });

  it("gives every raised request its own id", () => {
    const { frames, bridge } = harness();
    bridge.raise({ kind: "question", text: "a", options: [] });
    bridge.raise({ kind: "question", text: "b", options: [] });

    const ids = frames.map((frame) => requestIdOf(frame));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
