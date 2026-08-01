import { describe, expect, it } from "vitest";

import {
  computeAbsoluteScreenExtents,
  toExtentAwareNodes,
  type CanvasNodeLike,
  type ExtentAwareNode,
  type ToExtentAwareNodesOptions,
} from "./node-extents.js";

const IDENTITY_VIEWPORT = { x: 0, y: 0, zoom: 1 };

describe("computeAbsoluteScreenExtents", () => {
  it("a top-level node's position is already absolute", () => {
    const nodes: ExtentAwareNode[] = [
      { id: "n1", x: 100, y: 200, width: 140, height: 40 },
    ];
    expect(computeAbsoluteScreenExtents(nodes, IDENTITY_VIEWPORT)).toEqual([
      { id: "n1", x: 100, y: 200, width: 140, height: 40 },
    ]);
  });

  it("a contained node's absolute position is its parent's position plus its own", () => {
    const nodes: ExtentAwareNode[] = [
      { id: "workstream-1", x: 500, y: 300, width: 420, height: 280 },
      {
        id: "session-1",
        x: 40,
        y: 60,
        width: 140,
        height: 40,
        parentId: "workstream-1",
      },
    ];
    const extents = computeAbsoluteScreenExtents(nodes, IDENTITY_VIEWPORT);
    const session = extents.find((e) => e.id === "session-1");
    expect(session).toEqual({
      id: "session-1",
      x: 540,
      y: 360,
      width: 140,
      height: 40,
    });
  });

  it("applies the viewport transform after resolving the absolute position", () => {
    const nodes: ExtentAwareNode[] = [
      { id: "workstream-1", x: 500, y: 300, width: 420, height: 280 },
      {
        id: "session-1",
        x: 40,
        y: 60,
        width: 140,
        height: 40,
        parentId: "workstream-1",
      },
    ];
    const viewport = { x: 10, y: -20, zoom: 2 };
    const extents = computeAbsoluteScreenExtents(nodes, viewport);
    const session = extents.find((e) => e.id === "session-1");
    // absolute (540, 360) * zoom 2 + pan (10, -20) = (1090, 700)
    expect(session).toEqual({
      id: "session-1",
      x: 1090,
      y: 700,
      width: 280,
      height: 80,
    });
  });

  it("excludes a node hidden by container collapse", () => {
    const nodes: ExtentAwareNode[] = [
      { id: "workstream-1", x: 0, y: 0, width: 420, height: 280 },
      {
        id: "session-1",
        x: 40,
        y: 60,
        width: 140,
        height: 40,
        parentId: "workstream-1",
        hidden: true,
      },
    ];
    const extents = computeAbsoluteScreenExtents(nodes, IDENTITY_VIEWPORT);
    expect(extents.map((e) => e.id)).toEqual(["workstream-1"]);
  });

  it("a parentId with no matching node in the list falls back to no parent offset", () => {
    const nodes: ExtentAwareNode[] = [
      {
        id: "orphaned-child",
        x: 40,
        y: 60,
        width: 140,
        height: 40,
        parentId: "not-in-the-list",
      },
    ];
    const extents = computeAbsoluteScreenExtents(nodes, IDENTITY_VIEWPORT);
    expect(extents).toEqual([
      { id: "orphaned-child", x: 40, y: 60, width: 140, height: 40 },
    ]);
  });
});

/**
 * Call-site-shaped: `toExtentAwareNodes` is the exact wiring `PlotCanvas`
 * calls, and this feeds its output straight into
 * `computeAbsoluteScreenExtents` the same way that call site does — the
 * whole pipeline, not just the pure math in isolation. A regression that
 * filters container nodes out *before* this pipeline runs (the bug this
 * replaces: `PlotCanvas` once passed only box nodes, so a contained node's
 * parent id resolved to nothing and its "absolute" position was silently
 * just its bare parent-relative one) fails the first test below, because
 * `session-1`'s expected position only comes out right if `workstream-1`
 * actually reached `computeAbsoluteScreenExtents`.
 */
describe("toExtentAwareNodes + computeAbsoluteScreenExtents (the PlotCanvas pipeline)", () => {
  const OPTIONS: ToExtentAwareNodesOptions = {
    containerType: "container",
    boxSize: { width: 140, height: 40 },
    containerSize: { width: 420, height: 280 },
  };

  function canvasNodes(): CanvasNodeLike[] {
    return [
      {
        id: "workstream-1",
        type: "container",
        position: { x: 500, y: 300 },
      },
      {
        id: "session-1",
        type: "box",
        position: { x: 40, y: 60 },
        measured: { width: 140, height: 40 },
        parentId: "workstream-1",
      },
    ];
  }

  it("resolves a contained node's absolute position at parent.position + child.position", () => {
    const extents = computeAbsoluteScreenExtents(
      toExtentAwareNodes(canvasNodes(), OPTIONS),
      IDENTITY_VIEWPORT,
    );
    const session = extents.find((e) => e.id === "session-1");
    expect(session).toEqual({
      id: "session-1",
      x: 540, // 500 + 40
      y: 360, // 300 + 60
      width: 140,
      height: 40,
    });
  });

  it("the container itself is not dropped from the pipeline", () => {
    // This is the regression guard: if a caller (re-)filters to box nodes
    // before calling toExtentAwareNodes/computeAbsoluteScreenExtents, the
    // container never reaches either function and this assertion fails.
    const extents = computeAbsoluteScreenExtents(
      toExtentAwareNodes(canvasNodes(), OPTIONS),
      IDENTITY_VIEWPORT,
    );
    expect(extents.find((e) => e.id === "workstream-1")).toEqual({
      id: "workstream-1",
      x: 500,
      y: 300,
      width: 420,
      height: 280,
    });
  });

  it("an unmeasured node falls back to its type's fallback size", () => {
    const nodes: CanvasNodeLike[] = [
      { id: "workstream-1", type: "container", position: { x: 0, y: 0 } },
      {
        id: "ticket-1",
        type: "box",
        position: { x: 10, y: 10 },
        parentId: "workstream-1",
      },
    ];
    const extentAware = toExtentAwareNodes(nodes, OPTIONS);
    expect(extentAware.find((n) => n.id === "workstream-1")).toMatchObject({
      width: 420,
      height: 280,
    });
    expect(extentAware.find((n) => n.id === "ticket-1")).toMatchObject({
      width: 140,
      height: 40,
    });
  });

  it("a hidden contained node (collapsed container) drops out of the final extents", () => {
    const nodes: CanvasNodeLike[] = [
      {
        id: "workstream-1",
        type: "container",
        position: { x: 0, y: 0 },
      },
      {
        id: "session-1",
        type: "box",
        position: { x: 40, y: 60 },
        measured: { width: 140, height: 40 },
        parentId: "workstream-1",
        hidden: true,
      },
    ];
    const extents = computeAbsoluteScreenExtents(
      toExtentAwareNodes(nodes, OPTIONS),
      IDENTITY_VIEWPORT,
    );
    expect(extents.map((e) => e.id)).toEqual(["workstream-1"]);
  });
});
