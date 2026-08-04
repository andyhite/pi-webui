import { describe, expect, it } from "vitest";

import {
  clampExtentsInsideParent,
  clampInsideParent,
} from "./contained-push.js";
import { solvePush, type NodeExtent } from "../solver/push.js";

const PARENT = { width: 420, height: 280 };

function child(
  id: string,
  x: number,
  y: number,
  width = 140,
  height = 40,
): NodeExtent {
  return { id, x, y, width, height };
}

describe("push inside a container", () => {
  it("pushes a sibling in parent-relative space, exactly as the top level does", () => {
    const extents = [child("dragged", 60, 60), child("sibling", 100, 70)];

    const displaced = solvePush(extents, "dragged");

    expect(displaced.get("sibling")).toBeDefined();
    const settled = clampInsideParent(displaced, extents, PARENT);
    // Separated along the axis of least penetration, and still inside.
    const sibling = settled.get("sibling");
    expect(sibling?.y).toBe(100);
    expect(sibling?.x).toBe(100);
  });
  it("stops a push at the frame rather than pushing a child out through it", () => {
    // A sibling flush against the right wall (280 + 140 = the frame's width),
    // and a dragged node overlapping it by less horizontally than vertically,
    // so the solver separates them along x — into a wall.
    const extents = [child("dragged", 180, 20), child("sibling", 280, 20)];

    const displaced = solvePush(extents, "dragged");
    const wanted = displaced.get("sibling");
    const settled = clampInsideParent(displaced, extents, PARENT);

    expect(wanted?.x).toBe(320);
    expect(settled.get("sibling")).toEqual({ x: 280, y: 20 });
    // And the honest consequence: a bounded space can run out of room, so the
    // pair stays overlapping rather than a child leaving its own frame — the
    // same outcome as dragging one into the wall by hand.
    expect(settled.get("sibling")?.x).toBeLessThan(180 + 140);
  });

  it("clamps a child bigger than its frame exactly as xyflow does — negative and all", () => {
    // xyflow's own rule is `min(max(v, 0), frame - size)` with no floor under
    // the upper bound, so an oversized card really does get a negative
    // relative coordinate. Flooring it at zero here would make this module
    // disagree with the thing doing the rendering, and the persisted position
    // would drift from the drawn one by the overflow.
    const settled = clampInsideParent(
      new Map([["huge", { x: 40, y: 40 }]]),
      [child("huge", 40, 40, 900, 900)],
      PARENT,
    );

    expect(settled.get("huge")).toEqual({
      x: PARENT.width - 900,
      y: PARENT.height - 900,
    });
  });

  it("clamps a push back towards the origin at zero, not past it", () => {
    const settled = clampInsideParent(
      new Map([["pushed", { x: -30, y: 12 }]]),
      [child("pushed", -30, 12)],
      PARENT,
    );

    expect(settled.get("pushed")).toEqual({ x: 0, y: 12 });
  });

  it("leaves a position it has no extent for alone rather than guessing", () => {
    const settled = clampInsideParent(
      new Map([["unknown", { x: 9_000, y: 9_000 }]]),
      [child("someone-else", 0, 0)],
      PARENT,
    );

    expect(settled.get("unknown")).toEqual({ x: 9_000, y: 9_000 });
  });

  it("keeps an in-frame push untouched — clamping is a wall, not a layout", () => {
    const displaced = new Map([["pushed", { x: 100, y: 100 }]]);

    expect(
      clampInsideParent(displaced, [child("pushed", 60, 100)], PARENT).get(
        "pushed",
      ),
    ).toEqual({ x: 100, y: 100 });
  });

  it("solves against where the container draws a child, not where it is stored", () => {
    // A third child in one workstream derives to y = 300 inside a 280-tall
    // frame (`placement/derive.ts`): xyflow draws it at 240 and never writes
    // that back, so the stored value is not what anybody can see.
    const stored = [child("dragged", 40, 220), child("stray", 40, 300)];

    // Solved as stored, the pair is 80 apart and nothing overlaps.
    expect(solvePush(stored, "dragged").size).toBe(0);

    // Solved where they are drawn, the dragged node is on top of it.
    const drawn = clampExtentsInsideParent(stored, PARENT);
    expect(drawn[1]?.y).toBe(PARENT.height - 40);
    expect(solvePush(drawn, "dragged").has("stray")).toBe(true);
  });

  it("leaves an extent already inside the frame identical, object and all", () => {
    const extents = [child("inside", 40, 60)];

    expect(clampExtentsInsideParent(extents, PARENT)[0]).toBe(extents[0]);
  });
});
