import { describe, expect, it } from "vitest";

import type { NodeExtent } from "../solver/push.js";
import type { BubbleSource } from "./model.js";
import {
  DEFAULT_GLOBAL_BUBBLE_CAP,
  computeBubblePlacements,
  type BubblePlacement,
  type ReservedRegion,
} from "./placement.js";

function node(id: string, overrides: Partial<NodeExtent> = {}): NodeExtent {
  return { id, x: 0, y: 200, width: 140, height: 40, ...overrides };
}

function source(overrides: Partial<BubbleSource> = {}): BubbleSource {
  return {
    id: "s1",
    nodeId: "n1",
    kind: "session-output",
    text: "hello",
    updatedAt: 0,
    wantsAttention: false,
    ...overrides,
  };
}

function bubbleFor(
  placements: readonly BubblePlacement[],
  sourceId: string,
): Extract<BubblePlacement, { kind: "bubble" }> | undefined {
  return placements.find(
    (p): p is Extract<BubblePlacement, { kind: "bubble" }> =>
      p.kind === "bubble" && p.source.id === sourceId,
  );
}

function collapsedFor(
  placements: readonly BubblePlacement[],
  nodeId: string,
): Extract<BubblePlacement, { kind: "collapsed" }> | undefined {
  return placements.find(
    (p): p is Extract<BubblePlacement, { kind: "collapsed" }> =>
      p.kind === "collapsed" && p.nodeId === nodeId,
  );
}

describe("computeBubblePlacements", () => {
  it("attaches a bubble to its sender node, width-capped to the node's width", () => {
    const nodes = [node("n1", { x: 100, y: 200, width: 160 })];
    const src = source({ nodeId: "n1", text: "a very long dispatched prompt" });
    const placements = computeBubblePlacements(nodes, [src], new Set(["n1"]));

    const bubble = bubbleFor(placements, "s1");
    expect(bubble).toBeDefined();
    expect(bubble!.rect.width).toBe(160);
    expect(bubble!.rect.x).toBe(100);
  });

  it("collapses every source on an unfocused node to one count badge", () => {
    const nodes = [node("n1")];
    const sources = [
      source({ id: "a", nodeId: "n1" }),
      source({ id: "b", nodeId: "n1", kind: "tool-in-flight" }),
    ];
    const placements = computeBubblePlacements(nodes, sources, new Set());

    expect(placements).toHaveLength(1);
    const collapsed = collapsedFor(placements, "n1");
    expect(collapsed).toBeDefined();
    expect([...collapsed!.sourceIds].sort()).toEqual(["a", "b"]);
  });

  it("a node with no sources produces no placement at all", () => {
    const nodes = [node("n1")];
    const placements = computeBubblePlacements(nodes, [], new Set(["n1"]));
    expect(placements).toHaveLength(0);
  });

  it("never obscures a reserved region — falls back to the opposite anchor", () => {
    const nodes = [node("n1", { x: 0, y: 200, width: 140, height: 40 })];
    const src = source({ nodeId: "n1", text: "hi" });
    // The default "above" anchor sits roughly y in [200-gap-height, 200-gap);
    // reserve exactly that band so placement must fall back to "below".
    const reserved: ReservedRegion[] = [
      { id: "minimap", x: 0, y: 100, width: 200, height: 120 },
    ];
    const placements = computeBubblePlacements(
      nodes,
      [src],
      new Set(["n1"]),
      reserved,
    );

    const bubble = bubbleFor(placements, "s1");
    expect(bubble).toBeDefined();
    expect(bubble!.rect.y).toBeGreaterThan(node("n1").y + node("n1").height);
  });

  it("collapses (never draws) a bubble reserved regions block on both anchors", () => {
    const nodes = [node("n1", { x: 0, y: 200, width: 140, height: 40 })];
    const src = source({ nodeId: "n1", text: "hi" });
    const reserved: ReservedRegion[] = [
      { id: "everything", x: -1000, y: -1000, width: 3000, height: 3000 },
    ];
    const placements = computeBubblePlacements(
      nodes,
      [src],
      new Set(["n1"]),
      reserved,
    );

    expect(bubbleFor(placements, "s1")).toBeUndefined();
    const collapsed = collapsedFor(placements, "n1");
    expect(collapsed?.sourceIds).toEqual(["s1"]);
  });

  it("defaults the global cap to a sensible six", () => {
    expect(DEFAULT_GLOBAL_BUBBLE_CAP).toBe(6);
  });

  it("under the global cap, attention-wanting candidates win regardless of recency", () => {
    const nodes = [node("n1"), node("n2", { x: 300 })];
    const sources = [
      source({
        id: "old-attention",
        nodeId: "n1",
        wantsAttention: true,
        updatedAt: 1,
      }),
      source({
        id: "new-no-attention",
        nodeId: "n2",
        wantsAttention: false,
        updatedAt: 100,
      }),
    ];
    const placements = computeBubblePlacements(
      nodes,
      sources,
      new Set(["n1", "n2"]),
      [],
      { globalCap: 1 },
    );

    expect(bubbleFor(placements, "old-attention")).toBeDefined();
    expect(bubbleFor(placements, "new-no-attention")).toBeUndefined();
    expect(collapsedFor(placements, "n2")?.sourceIds).toEqual([
      "new-no-attention",
    ]);
  });

  it("among equal attention, recency (newest first) breaks the tie", () => {
    const nodes = [node("n1"), node("n2", { x: 300 })];
    const sources = [
      source({ id: "older", nodeId: "n1", updatedAt: 1 }),
      source({ id: "newer", nodeId: "n2", updatedAt: 2 }),
    ];
    const placements = computeBubblePlacements(
      nodes,
      sources,
      new Set(["n1", "n2"]),
      [],
      { globalCap: 1 },
    );

    expect(bubbleFor(placements, "newer")).toBeDefined();
    expect(bubbleFor(placements, "older")).toBeUndefined();
  });

  it("ties on attention and recency break deterministically by id", () => {
    const nodes = [node("n1"), node("n2", { x: 300 })];
    const sources = [
      source({ id: "b", nodeId: "n2", updatedAt: 5 }),
      source({ id: "a", nodeId: "n1", updatedAt: 5 }),
    ];
    const placements = computeBubblePlacements(
      nodes,
      sources,
      new Set(["n1", "n2"]),
      [],
      { globalCap: 1 },
    );

    expect(bubbleFor(placements, "a")).toBeDefined();
    expect(bubbleFor(placements, "b")).toBeUndefined();
  });

  it("candidates past the global cap fold into their node's collapsed badge", () => {
    const nodes = [node("n1"), node("n2", { x: 300 }), node("n3", { x: 600 })];
    const sources = [
      source({ id: "s1", nodeId: "n1", updatedAt: 3 }),
      source({ id: "s2", nodeId: "n2", updatedAt: 2 }),
      source({ id: "s3", nodeId: "n3", updatedAt: 1 }),
    ];
    const placements = computeBubblePlacements(
      nodes,
      sources,
      new Set(["n1", "n2", "n3"]),
      [],
      { globalCap: 2 },
    );

    expect(bubbleFor(placements, "s1")).toBeDefined();
    expect(bubbleFor(placements, "s2")).toBeDefined();
    expect(bubbleFor(placements, "s3")).toBeUndefined();
    expect(collapsedFor(placements, "n3")?.sourceIds).toEqual(["s3"]);
  });

  it("stacks multiple bubbles on the same focused node without overlapping", () => {
    const nodes = [node("n1", { x: 0, y: 400, width: 140, height: 40 })];
    const sources = [
      source({ id: "output", nodeId: "n1", text: "saying something" }),
      source({
        id: "tool",
        nodeId: "n1",
        kind: "tool-in-flight",
        text: "grep",
      }),
    ];
    const placements = computeBubblePlacements(nodes, sources, new Set(["n1"]));

    const a = bubbleFor(placements, "output")!.rect;
    const b = bubbleFor(placements, "tool")!.rect;
    const overlap =
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y;
    expect(overlap).toBe(false);
  });
});
