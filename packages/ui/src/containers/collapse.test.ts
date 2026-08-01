import { describe, expect, it } from "vitest";

import type { ContainerEdge } from "./collapse.js";
import {
  effectiveCollapsedContainers,
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

describe("effectiveCollapsedContainers", () => {
  const containerIds = ["ws-1", "ws-2"];

  it("returns only the manually collapsed containers when zoom isn't forcing", () => {
    const result = effectiveCollapsedContainers(
      containerIds,
      new Set(["ws-1"]),
      false,
    );
    expect(result).toEqual(new Set(["ws-1"]));
  });

  it("returns every container when the zoom level forces collapse", () => {
    const result = effectiveCollapsedContainers(containerIds, new Set(), true);
    expect(result).toEqual(new Set(["ws-1", "ws-2"]));
  });

  it("zoom-forced collapse doesn't erase which ones were manually collapsed", () => {
    // Manual state is the caller's source of truth across zoom changes;
    // this function only computes the *effective* set for the current
    // render, so a manual choice made while zoomed out is still visible
    // once the caller re-derives with collapseAll=false after zooming in.
    const zoomedOut = effectiveCollapsedContainers(
      containerIds,
      new Set(["ws-1"]),
      true,
    );
    expect(zoomedOut).toEqual(new Set(["ws-1", "ws-2"]));

    const zoomedBackIn = effectiveCollapsedContainers(
      containerIds,
      new Set(["ws-1"]),
      false,
    );
    expect(zoomedBackIn).toEqual(new Set(["ws-1"]));
  });

  it("ignores a manually collapsed id that isn't a known container", () => {
    const result = effectiveCollapsedContainers(
      containerIds,
      new Set(["stale-id"]),
      false,
    );
    expect(result).toEqual(new Set());
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
