import { describe, expect, it } from "vitest";

import type { ClosestQueryable } from "./focused-node.js";
import { CANVAS_NODE_SELECTOR, focusedCanvasNodeId } from "./focused-node.js";

function element(nodeId: string | null): ClosestQueryable {
  return {
    closest: (selector) =>
      selector === CANVAS_NODE_SELECTOR && nodeId !== null
        ? { getAttribute: (name) => (name === "data-id" ? nodeId : null) }
        : null,
  };
}

describe("focusedCanvasNodeId", () => {
  it("reads the id off the xyflow node wrapper the focused element sits inside", () => {
    expect(focusedCanvasNodeId(element("node-7"))).toBe("node-7");
  });

  it("answers null when focus is not inside a node at all", () => {
    expect(focusedCanvasNodeId(element(null))).toBeNull();
  });

  it("answers null for no focused element, rather than guessing at a selection", () => {
    expect(focusedCanvasNodeId(null)).toBeNull();
    expect(focusedCanvasNodeId(undefined)).toBeNull();
  });
});
