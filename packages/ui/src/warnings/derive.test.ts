import { describe, expect, it } from "vitest";

import { deriveGraphWarnings } from "./derive.js";
import type { WarningGraphEdge, WarningGraphNode } from "./derive.js";

describe("deriveGraphWarnings", () => {
  it("flags a node with no edges at all as unreachable", () => {
    const nodes: WarningGraphNode[] = [{ id: "note-1", role: "content" }];
    const warnings = deriveGraphWarnings(nodes, []);
    expect(warnings).toEqual([
      {
        kind: "unreachable",
        nodeId: "note-1",
        message: "note-1 is not connected to anything on the graph",
      },
    ]);
  });

  it("flags a command with zero incoming context edges as no_context", () => {
    // The command has *some* edge (an outgoing provenance edge to its
    // declared output) so it is not also reported as unreachable.
    const nodes: WarningGraphNode[] = [
      { id: "command-a", role: "command" },
      { id: "output-a", role: "content" },
    ];
    const edges: WarningGraphEdge[] = [{ from: "command-a", to: "output-a" }];
    const warnings = deriveGraphWarnings(nodes, edges);
    expect(warnings).toContainEqual({
      kind: "no_context",
      nodeId: "command-a",
      message: "command-a has no context wired in at all",
    });
  });

  it("does not flag no_context when a command has an incoming edge", () => {
    const nodes: WarningGraphNode[] = [
      { id: "ticket-a", role: "content" },
      { id: "command-a", role: "command" },
    ];
    const edges: WarningGraphEdge[] = [{ from: "ticket-a", to: "command-a" }];
    const warnings = deriveGraphWarnings(nodes, edges);
    expect(warnings.some((w) => w.kind === "no_context")).toBe(false);
  });

  it("flags a chain that cannot run because an upstream output was not produced", () => {
    const nodes: WarningGraphNode[] = [
      { id: "output-a", role: "content", producedOutput: false },
      { id: "command-b", role: "command" },
    ];
    const edges: WarningGraphEdge[] = [{ from: "output-a", to: "command-b" }];
    const warnings = deriveGraphWarnings(nodes, edges);
    expect(warnings).toContainEqual({
      kind: "blocked_chain",
      nodeId: "command-b",
      message:
        "command-b cannot run yet: an upstream command has not produced one of its inputs",
    });
  });

  it("does not flag blocked_chain once the upstream output was produced", () => {
    const nodes: WarningGraphNode[] = [
      { id: "output-a", role: "content", producedOutput: true },
      { id: "command-b", role: "command" },
    ];
    const edges: WarningGraphEdge[] = [{ from: "output-a", to: "command-b" }];
    const warnings = deriveGraphWarnings(nodes, edges);
    expect(warnings).toHaveLength(0);
  });

  it("flags a published output nobody consumes", () => {
    const nodes: WarningGraphNode[] = [
      { id: "command-a", role: "command" },
      { id: "output-a", role: "content", published: true },
    ];
    // Provenance edge from the command in, nothing wired out.
    const edges: WarningGraphEdge[] = [{ from: "command-a", to: "output-a" }];
    const warnings = deriveGraphWarnings(nodes, edges);
    expect(warnings).toContainEqual({
      kind: "unconsumed_output",
      nodeId: "output-a",
      message: "output-a is published but nothing consumes it",
    });
  });

  it("does not flag unconsumed_output for unpublished content", () => {
    const nodes: WarningGraphNode[] = [
      { id: "command-a", role: "command" },
      { id: "output-a", role: "content", published: false },
    ];
    const edges: WarningGraphEdge[] = [{ from: "command-a", to: "output-a" }];
    const warnings = deriveGraphWarnings(nodes, edges);
    expect(warnings.some((w) => w.kind === "unconsumed_output")).toBe(false);
  });

  it("returns no warnings for a healthy, fully-wired graph", () => {
    const nodes: WarningGraphNode[] = [
      { id: "ticket-a", role: "content" },
      { id: "command-a", role: "command" },
      { id: "session-a", role: "session" },
    ];
    const edges: WarningGraphEdge[] = [
      { from: "ticket-a", to: "command-a" },
      { from: "command-a", to: "session-a" },
    ];
    expect(deriveGraphWarnings(nodes, edges)).toEqual([]);
  });
});
