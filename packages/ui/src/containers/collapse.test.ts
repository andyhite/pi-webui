import { describe, expect, it } from "vitest";

import type { ContainerEdge } from "./collapse.js";
import {
  isNodeHidden,
  remapEdgesForCollapse,
  visibleNodeIds,
} from "./collapse.js";

const parentOf = new Map([
  ["ticket-1", "ws-1"],
  ["command-1", "ws-1"],
  ["ticket-2", "ws-2"],
]);

describe("isNodeHidden", () => {
  it("is not hidden when its container is not collapsed", () => {
    expect(isNodeHidden("ticket-1", new Set(), parentOf)).toBe(false);
  });

  it("is hidden when its container is collapsed", () => {
    expect(isNodeHidden("ticket-1", new Set(["ws-1"]), parentOf)).toBe(true);
  });

  it("a node with no container is never hidden", () => {
    expect(isNodeHidden("ws-1", new Set(["ws-1"]), parentOf)).toBe(false);
  });
});

describe("visibleNodeIds", () => {
  it("filters out nodes inside a collapsed container", () => {
    const ids = ["ws-1", "ticket-1", "command-1", "ws-2", "ticket-2"];
    expect(visibleNodeIds(ids, new Set(["ws-1"]), parentOf)).toEqual([
      "ws-1",
      "ws-2",
      "ticket-2",
    ]);
  });

  it("returns everything when nothing is collapsed", () => {
    const ids = ["ws-1", "ticket-1"];
    expect(visibleNodeIds(ids, new Set(), parentOf)).toEqual(ids);
  });
});

describe("remapEdgesForCollapse", () => {
  it("leaves edges alone when neither endpoint is collapsed", () => {
    const edges: ContainerEdge[] = [
      { id: "e1", source: "ticket-1", target: "command-1" },
    ];
    expect(remapEdgesForCollapse(edges, new Set(), parentOf)).toEqual(edges);
  });

  it("remaps an endpoint inside a collapsed container to its frame", () => {
    const edges: ContainerEdge[] = [
      { id: "e1", source: "ticket-2", target: "command-1" },
    ];
    const result = remapEdgesForCollapse(edges, new Set(["ws-1"]), parentOf);
    expect(result).toEqual([{ id: "e1", source: "ticket-2", target: "ws-1" }]);
  });

  it("drops an edge that collapses into a self-loop", () => {
    const edges: ContainerEdge[] = [
      { id: "e1", source: "ticket-1", target: "command-1" },
    ];
    const result = remapEdgesForCollapse(edges, new Set(["ws-1"]), parentOf);
    expect(result).toEqual([]);
  });

  it("dedupes parallel edges the collapse produces", () => {
    const edges: ContainerEdge[] = [
      { id: "e1", source: "ticket-2", target: "ticket-1" },
      { id: "e2", source: "ticket-2", target: "command-1" },
    ];
    const result = remapEdgesForCollapse(edges, new Set(["ws-1"]), parentOf);
    expect(result).toEqual([{ id: "e1", source: "ticket-2", target: "ws-1" }]);
  });
});
