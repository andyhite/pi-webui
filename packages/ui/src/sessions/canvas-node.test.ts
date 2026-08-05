import { describe, expect, it } from "vitest";
import { humanAuthor, INHERIT_APP_TOOLS, startSession } from "@plotroom/core";
import type { Session } from "@plotroom/core";

import { sessionCanvasNode } from "./canvas-node.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  const session = startSession(
    {
      id: "sess_1" as Session["id"],
      workstreamId: "ws_1" as Session["workstreamId"],
      commandId: null,
      mode: "open",
      launch: {
        model: "anthropic/claude-sonnet-4",
        effort: "medium",
        toolPermissions: INHERIT_APP_TOOLS,
      },
      initiatedBy: humanAuthor,
      runtime: { adapterId: "omp-session-host", ref: "session-1" },
    },
    1_000,
  );
  return { ...session, ...overrides };
}

describe("sessionCanvasNode", () => {
  it("renders a running session's node from core session types", () => {
    const node = sessionCanvasNode({
      session: makeSession(),
      phase: { kind: "thinking" },
      label: "session #1",
      defaultPosition: { x: 0, y: 0 },
    });
    expect(node.id).toBe("sess_1");
    expect(node.role).toBe("session");
    expect(node.running).toBe(true);
    expect(node.refId).toBe("sess_1");
    expect(node.label).toBe("session #1 (thinking)");
  });

  it("renders an ended session as not running", () => {
    const ended = makeSession({
      end: { kind: "completed", at: 2_000 },
    });
    const node = sessionCanvasNode({
      session: ended,
      phase: { kind: "idle" },
      label: "session #2",
      defaultPosition: { x: 0, y: 0 },
    });
    expect(node.running).toBe(false);
  });

  it("carries a tool-running phase's tool name into the label", () => {
    const node = sessionCanvasNode({
      session: makeSession(),
      phase: { kind: "tool-running", toolName: "bash" },
      label: "session #1",
      defaultPosition: { x: 0, y: 0 },
    });
    expect(node.label).toBe("session #1 (tool-running (bash))");
  });

  it("carries containerId through only when given", () => {
    const withContainer = sessionCanvasNode({
      session: makeSession(),
      phase: { kind: "idle" },
      label: "s",
      containerId: "ws-container",
      defaultPosition: { x: 0, y: 0 },
    });
    expect(withContainer.containerId).toBe("ws-container");

    const bare = sessionCanvasNode({
      session: makeSession(),
      phase: { kind: "idle" },
      label: "s",
      defaultPosition: { x: 0, y: 0 },
    });
    expect(bare.containerId).toBeUndefined();
  });
});
