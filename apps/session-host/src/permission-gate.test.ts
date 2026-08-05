import { describe, expect, it } from "bun:test";
import type {
  RequestOutcome,
  RuntimeRequest,
  RuntimeRequestId,
  SessionHostEvent,
} from "@plotroom/core";

import {
  BOOT_ASSERTION_TOOL_NAME,
  createPermissionGateHandler,
} from "./permission-gate.js";
import { createRequestBridge, type RequestBridge } from "./request-bridge.js";

interface Harness {
  readonly bridge: RequestBridge;
  readonly frames: SessionHostEvent[];
}

function harness(): Harness {
  const frames: SessionHostEvent[] = [];
  const bridge = createRequestBridge(
    (frame) => frames.push(frame),
    () => 1_000,
  );
  return { bridge, frames };
}

/** The request the most recently raised `request-raised` observation carries. */
function lastRaised(frames: readonly SessionHostEvent[]): {
  readonly requestId: RuntimeRequestId;
  readonly request: RuntimeRequest;
} {
  const frame = frames
    .filter(
      (candidate) =>
        candidate.type === "observation" &&
        candidate.observation.kind === "request-raised",
    )
    .at(-1);
  if (
    frame?.type !== "observation" ||
    frame.observation.kind !== "request-raised"
  ) {
    throw new Error("expected a request-raised observation");
  }
  return {
    requestId: frame.observation.requestId,
    request: frame.observation.request,
  };
}

describe("the permission gate handler (issue #81)", () => {
  it("denies its own boot assertion without touching the bridge", async () => {
    const { bridge, frames } = harness();
    const handler = createPermissionGateHandler(bridge);

    const result = await handler({
      type: "tool_call",
      toolName: BOOT_ASSERTION_TOOL_NAME,
      toolCallId: "boot-assertion",
      input: {},
    });

    expect(result).toEqual({ block: true, reason: "boot assertion" });
    expect(frames).toHaveLength(0);
  });

  it("raises a tool-permission request and allows on the answer", async () => {
    const { bridge, frames } = harness();
    const handler = createPermissionGateHandler(bridge);

    const pending = handler({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "call-1",
      input: { command: "ls" },
    });

    const { requestId, request } = lastRaised(frames);
    expect(request).toEqual({
      kind: "tool-permission",
      toolName: "bash",
      input: { command: "ls" },
    });

    bridge.settle(requestId, { kind: "allow" } satisfies RequestOutcome);
    await expect(pending).resolves.toEqual({});
  });

  it("blocks with the operator's own reason on a denial", async () => {
    const { bridge, frames } = harness();
    const handler = createPermissionGateHandler(bridge);

    const pending = handler({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "call-1",
      input: {},
    });

    const { requestId } = lastRaised(frames);
    bridge.settle(requestId, {
      kind: "deny",
      reason: "claimed by another session",
    });

    await expect(pending).resolves.toEqual({
      block: true,
      reason: "claimed by another session",
    });
  });

  it("fails closed on the wrong outcome shape rather than allowing", async () => {
    const { bridge, frames } = harness();
    const handler = createPermissionGateHandler(bridge);

    const pending = handler({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "call-1",
      input: {},
    });

    // A tool-permission request is never answered with an "answer" — that
    // outcome belongs to §6.4 questions. Fail closed rather than allow.
    const { requestId } = lastRaised(frames);
    bridge.settle(requestId, { kind: "answer", value: "yes" });

    const result = await pending;
    expect(result.block).toBe(true);
  });
});
