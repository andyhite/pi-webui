import { describe, expect, it } from "vitest";

import type { NodeExtent } from "./push.js";
import { solvePush } from "./push.js";

function box(id: string, x: number, y: number, w = 100, h = 50): NodeExtent {
  return { id, x, y, width: w, height: h };
}

describe("solvePush", () => {
  it("returns nothing when the arrangement has no overlaps", () => {
    const result = solvePush(
      [box("a", 0, 0), box("b", 200, 0), box("c", 0, 200)],
      "a",
    );
    expect(result.size).toBe(0);
  });

  it("treats exactly touching edges as at rest, not overlapping", () => {
    const result = solvePush([box("a", 0, 0), box("b", 100, 0)], "a");
    expect(result.size).toBe(0);
  });

  it("never displaces the dragged node", () => {
    const result = solvePush([box("a", 0, 0), box("b", 50, 0)], "a");
    expect(result.has("a")).toBe(false);
  });

  it("pushes an overlapped node out along the axis of least penetration", () => {
    // b overlaps a by 30 in x and fully in y: push along x, away from a.
    const result = solvePush([box("a", 0, 0), box("b", 70, 0)], "a");
    expect(result.get("b")).toEqual({ x: 100, y: 0 });
  });

  it("pushes left when the mover sits to the left of the dragged node", () => {
    const result = solvePush([box("a", 70, 0), box("b", 0, 0)], "a");
    expect(result.get("b")).toEqual({ x: -30, y: 0 });
  });

  it("pushes vertically when y penetration is smaller", () => {
    // Overlap: x = 90, y = 10 → push down along y.
    const result = solvePush([box("a", 0, 0), box("b", 10, 40)], "a");
    expect(result.get("b")).toEqual({ x: 10, y: 50 });
  });

  it("propagates a push through a chain", () => {
    // a pushed into b; b must move right by 40, landing on c; c moves too.
    const result = solvePush(
      [box("a", 0, 0), box("b", 60, 0), box("c", 170, 0)],
      "a",
    );
    expect(result.get("b")).toEqual({ x: 100, y: 0 });
    expect(result.get("c")).toEqual({ x: 200, y: 0 });
  });

  it("pushes multiple nodes touched by the same dragged node", () => {
    const result = solvePush(
      [box("a", 0, 0), box("b", 80, 0), box("c", -80, 0)],
      "a",
    );
    expect(result.get("b")).toEqual({ x: 100, y: 0 });
    expect(result.get("c")).toEqual({ x: -100, y: 0 });
  });

  it("leaves nodes outside the push chain alone even if they overlap", () => {
    // c and d overlap each other but are far from the drag: at rest stays put.
    const result = solvePush(
      [
        box("a", 0, 0),
        box("b", 200, 0),
        box("c", 1000, 1000),
        box("d", 1010, 1000),
      ],
      "a",
    );
    expect(result.size).toBe(0);
  });

  it("is settled after one application (no residual motion)", () => {
    const extents = [box("a", 0, 0), box("b", 60, 0), box("c", 170, 0)];
    const first = solvePush(extents, "a");
    const settled = extents.map((e) => {
      const moved = first.get(e.id);
      return moved ? { ...e, ...moved } : e;
    });
    expect(solvePush(settled, "a").size).toBe(0);
  });

  it("resolves a concentric overlap deterministically", () => {
    const a = solvePush([box("a", 0, 0), box("b", 0, 0)], "a");
    const b = solvePush([box("a", 0, 0), box("b", 0, 0)], "a");
    expect(a.get("b")).toEqual(b.get("b"));
    expect(a.get("b")).toBeDefined();
  });

  it("terminates on a dense pack and leaves every reached pair separated", () => {
    const extents: NodeExtent[] = [];
    for (let i = 0; i < 20; i++) {
      extents.push(box(`n${i}`, i * 60, 0));
    }
    const result = solvePush(extents, "n0");
    const settled = extents.map((e) => {
      const moved = result.get(e.id);
      return moved ? { ...e, ...moved } : e;
    });

    // No pair involving a node the chain reached may still overlap.
    const reached = new Set(["n0", ...result.keys()]);
    for (const a of settled) {
      for (const b of settled) {
        if (a.id >= b.id) continue;
        if (!reached.has(a.id) && !reached.has(b.id)) continue;
        const overlapX =
          Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY =
          Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(Math.min(overlapX, overlapY)).toBeLessThanOrEqual(1e-6);
      }
    }

    // And the settled arrangement is a fixpoint: nothing moves again.
    expect(solvePush(settled, "n0").size).toBe(0);
  });
});
