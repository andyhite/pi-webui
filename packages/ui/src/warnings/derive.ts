/**
 * Graph warnings (spec §5): "legal but probably wrong" topologies, flagged on
 * the card and in an editor surface — never a refusal. A check that blocks
 * authoring is a check people route around; a warning is read, not enforced.
 *
 * The shape is deliberately machine-readable (a closed `kind` union plus the
 * node it is about) so a session that produced the mistake can read and fix
 * it in the same turn, once agent tools exist to read it (§5: "warnings are
 * readable by agents too").
 *
 * This is a pure derivation over a minimal graph shape — not `@plotroom/core`'s
 * full `Edge`/`CommandOutput` types, which carry server-only state (ordinals,
 * publish/bind timestamps) this epic's fixtures don't model yet. The four
 * checks below are the four the spec names as examples, no more:
 *
 *   - a chain that cannot run because nothing upstream produced its input
 *   - a command with no context at all
 *   - a published output nobody consumes
 *   - an unreachable node
 *
 * (Content-budget warnings are a separate mechanism, already implemented as
 * `checkContentBudget` in `@plotroom/core` — not one of these four.)
 */

import type { NodeRole } from "@plotroom/core";

export interface WarningGraphNode {
  readonly id: string;
  readonly role: NodeRole;
  /**
   * Content nodes only, and only when this content is a command's pre-wired
   * output placeholder (§3.5): `false` while a run has not yet bound it to a
   * produced object, `true` once it has. Absent for content that was never a
   * command's output placeholder at all.
   */
  readonly producedOutput?: boolean;
  /**
   * Content nodes only: `true` once a command has published this placeholder
   * world-visible (§3.5) — the only content whose "nobody consumes it" is
   * worth flagging (an unpublished local output not yet wired to anything is
   * simply not built out yet, not a mistake).
   */
  readonly published?: boolean;
}

/** A context edge: content wired into a command or a running session (§3.7). */
export interface WarningGraphEdge {
  readonly from: string;
  readonly to: string;
}

export type GraphWarningKind =
  "blocked_chain" | "no_context" | "unconsumed_output" | "unreachable";

export interface GraphWarning {
  readonly kind: GraphWarningKind;
  readonly nodeId: string;
  readonly message: string;
}

/**
 * Spec §5's four named examples, derived once over the graph. Order is by
 * node id first, then declaration order of the checks below, so the result
 * is deterministic and diffable in tests.
 *
 * A node with zero edges of any kind is reported only as `unreachable` — the
 * other three checks all presuppose *some* edge exists to be wrong about, so
 * flagging both would restate the same fact twice.
 */
export function deriveGraphWarnings(
  nodes: readonly WarningGraphNode[],
  edges: readonly WarningGraphEdge[],
): readonly GraphWarning[] {
  const incomingFrom = new Map<string, WarningGraphNode[]>();
  const incomingCount = new Map<string, number>();
  const outgoingCount = new Map<string, number>();
  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (const edge of edges) {
    outgoingCount.set(edge.from, (outgoingCount.get(edge.from) ?? 0) + 1);
    incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);

    const sourceNode = byId.get(edge.from);
    if (sourceNode) {
      const sources = incomingFrom.get(edge.to) ?? [];
      sources.push(sourceNode);
      incomingFrom.set(edge.to, sources);
    }
  }

  const warnings: GraphWarning[] = [];

  for (const node of nodes) {
    const degree =
      (incomingCount.get(node.id) ?? 0) + (outgoingCount.get(node.id) ?? 0);

    if (degree === 0) {
      warnings.push({
        kind: "unreachable",
        nodeId: node.id,
        message: `${node.id} is not connected to anything on the graph`,
      });
      continue;
    }

    if (node.role === "command") {
      const sources = incomingFrom.get(node.id) ?? [];
      if (sources.length === 0) {
        warnings.push({
          kind: "no_context",
          nodeId: node.id,
          message: `${node.id} has no context wired in at all`,
        });
      } else if (sources.some((source) => source.producedOutput === false)) {
        warnings.push({
          kind: "blocked_chain",
          nodeId: node.id,
          message: `${node.id} cannot run yet: an upstream command has not produced one of its inputs`,
        });
      }
    }

    if (node.role === "content" && node.published === true) {
      const consumers = outgoingCount.get(node.id) ?? 0;
      if (consumers === 0) {
        warnings.push({
          kind: "unconsumed_output",
          nodeId: node.id,
          message: `${node.id} is published but nothing consumes it`,
        });
      }
    }
  }

  return warnings;
}
