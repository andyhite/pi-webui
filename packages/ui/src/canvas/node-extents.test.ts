import { describe, expect, it } from "vitest";

import {
  computeAbsoluteScreenExtents,
  type ExtentAwareNode,
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
