import { describe, expect, it } from "bun:test";
import { OMP_ASK_TOOL_NAME } from "@plotroom/core";
import type {
  RequestOutcome,
  RuntimeRequest,
  RuntimeRequestId,
  SessionHostEvent,
} from "@plotroom/core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { createAskToolExtension } from "./ask-tool.js";
import { createRequestBridge, type RequestBridge } from "./request-bridge.js";

/**
 * A minimal `ExtensionAPI` stand-in: only `typebox.Type` (schema authoring,
 * never validated here — `execute` is called directly with typed params) and
 * `registerTool` (captured, so the test drives the exact function the SDK
 * would call).
 */
interface CapturedTool {
  readonly execute: (
    toolCallId: string,
    params: { question: string; options: string[] },
    signal: undefined,
    onUpdate: undefined,
    ctx: undefined,
  ) => Promise<{
    readonly content: readonly {
      readonly type: string;
      readonly text: string;
    }[];
    readonly isError?: boolean;
    readonly details?: unknown;
  }>;
}

function registerAskTool(bridge: RequestBridge): CapturedTool {
  let captured: CapturedTool | undefined;
  const identity = (schema: unknown) => schema;
  // A real `ExtensionAPI` is a large surface this factory touches only
  // through `typebox.Type` (schema authoring — never validated here,
  // `execute` is called directly with typed params) and `registerTool`
  // (captured, so the test drives the exact function the SDK would call).
  const fakePi = {
    typebox: {
      Type: {
        Object: identity,
        String: identity,
        Array: identity,
      },
    },
    registerTool(tool: CapturedTool) {
      captured = tool;
    },
  } as unknown as ExtensionAPI;

  createAskToolExtension(bridge)(fakePi);
  if (captured === undefined) throw new Error("the tool never registered");
  return captured;
}

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

describe(`the ${OMP_ASK_TOOL_NAME} tool (§6.4, issue #81)`, () => {
  it("refuses to ask with no selectable options", async () => {
    const frames: SessionHostEvent[] = [];
    const bridge = createRequestBridge(
      (frame) => frames.push(frame),
      () => 1_000,
    );
    const tool = registerAskTool(bridge);

    const result = await tool.execute(
      "call-1",
      { question: "which?", options: [] },
      undefined,
      undefined,
      undefined,
    );

    expect(result.isError).toBe(true);
    expect(frames).toHaveLength(0);
  });

  it("raises a question and returns the picked option, structurally", async () => {
    const frames: SessionHostEvent[] = [];
    const bridge = createRequestBridge(
      (frame) => frames.push(frame),
      () => 1_000,
    );
    const tool = registerAskTool(bridge);

    const pending = tool.execute(
      "call-1",
      { question: "which fork?", options: ["native", "seeded"] },
      undefined,
      undefined,
      undefined,
    );

    const { requestId, request } = lastRaised(frames);
    expect(request).toEqual({
      kind: "question",
      text: "which fork?",
      options: ["native", "seeded"],
    });

    bridge.settle(requestId, {
      kind: "answer",
      value: "native",
    } satisfies RequestOutcome);

    const result = await pending;
    expect(result.isError).toBeUndefined();
    expect(result.details).toEqual({
      question: "which fork?",
      answer: "native",
      pathsNotTaken: ["seeded"],
    });
  });

  it("reports an error, not a guessed choice, when nothing answers it", async () => {
    const frames: SessionHostEvent[] = [];
    const bridge = createRequestBridge(
      (frame) => frames.push(frame),
      () => 1_000,
    );
    const tool = registerAskTool(bridge);

    const pending = tool.execute(
      "call-1",
      { question: "which fork?", options: ["native", "seeded"] },
      undefined,
      undefined,
      undefined,
    );

    const { requestId } = lastRaised(frames);
    bridge.settle(requestId, {
      kind: "deny",
      reason: "the operator dismissed it",
    });

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.details).toEqual({
      question: "which fork?",
      options: ["native", "seeded"],
      answer: null,
    });
  });
});
