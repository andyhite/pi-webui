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
 * publish/bind timestamps) the canvas maps into these facts once, upstream
 * (`packages/ui/src/data-source/build-snapshot.ts`). The five checks below
 * are the five the spec names as examples, no more:
 *
 *   - a chain that cannot run because nothing upstream produced its input
 *   - content assembled beyond the model's window
 *   - a command with no context at all
 *   - a published output nobody consumes
 *   - an unreachable node
 */

import type { ContentBudget, NodeRole } from "@plotroom/core";
import {
  DEFAULT_CONTENT_BUDGET,
  checkContentBudget,
  estimateTokens,
} from "@plotroom/core";

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
  /**
   * Command nodes only: its context inputs' real content, joined in
   * assembly order (§3.5) — what the fifth check below sizes. Absent means
   * "not known" (e.g. still loading), never "empty"; a command with
   * genuinely no context is `no_context`'s job, not this one's.
   */
  readonly assembledContent?: string;
  /** Command nodes only: this command's own budget, if not the shipped default. */
  readonly budget?: ContentBudget;
}

/** A context edge: content wired into a command or a running session (§3.7). */
export interface WarningGraphEdge {
  readonly from: string;
  readonly to: string;
}

export type GraphWarningKind =
  | "blocked_chain"
  | "no_context"
  | "unconsumed_output"
  | "unreachable"
  | "content_budget";

export interface GraphWarning {
  readonly kind: GraphWarningKind;
  readonly nodeId: string;
  readonly message: string;
  /**
   * `content_budget` only: names the sizing method honestly rather than
   * implying a real token count — `@plotroom/core`'s `estimateTokens` is a
   * documented, deliberately crude chars/4 estimate, the one basis assembly,
   * the run preview, and this warning all agree on (never a separately
   * invented guess).
   */
  readonly basis?: string;
}

const CONTENT_BUDGET_BASIS =
  "character-based estimate (chars \u00f7 4), the same estimator " +
  "@plotroom/core's estimateTokens uses for assembly and the run preview";

/**
 * Spec §5's five named examples, derived once over the graph. Order is by
 * node id first, then declaration order of the checks below, so the result
 * is deterministic and diffable in tests.
 *
 * A node with zero edges of any kind is reported only as `unreachable` — the
 * other checks all presuppose *some* edge exists to be wrong about, so
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

      if (node.assembledContent !== undefined) {
        const budget = node.budget ?? DEFAULT_CONTENT_BUDGET;
        const check = checkContentBudget(
          estimateTokens(node.assembledContent),
          budget,
        );
        if (check.state === "warn" || check.state === "refused") {
          warnings.push({
            kind: "content_budget",
            nodeId: node.id,
            message: check.message,
            basis: CONTENT_BUDGET_BASIS,
          });
        }
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
