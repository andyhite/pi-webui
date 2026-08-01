/**
 * The bubble placement engine (spec §5), pure like the rest of the canvas's
 * derived state (`off-screen.ts`, `derive.ts`): given the nodes currently on
 * screen, what could show as a bubble on each, and which nodes are focused,
 * compute where every bubble draws — or that it collapses to a count
 * instead. Every constraint the spec states for bubbles is a rule this
 * function enforces, not a rendering nicety:
 *
 * - **Attached to the sender** (§5): a bubble's rect is always anchored to
 *   its `nodeId`'s current extent — never a floating position of its own.
 * - **Width-capped** (§5, "never exceed the width of what they attach to"):
 *   a bubble's width is exactly its node's width, always.
 * - **Never obscures a reserved region** (§5, "never obscure the minimap or
 *   controls"): a candidate rect that would overlap any `ReservedRegion` is
 *   tried at its alternate anchor (below the node instead of above); if
 *   neither anchor is clear, the bubble does not render at all — folded
 *   into its node's collapsed count instead of drawing somewhere illegal.
 * - **Collapses when unfocused** (§5): every source on a node outside
 *   `focusedNodeIds` becomes one collapsed badge, never individual bubbles.
 *   Focus is the caller's concern — PlotCanvas defines it as selection or
 *   hover (documented at that call site) — this engine only reads the set.
 * - **Global cap, deterministic priority** (§5, "cap how many show at
 *   once"): among candidates from focused nodes, attention-wanting ones are
 *   selected first, then by recency (`updatedAt` descending), then by id for
 *   a stable tie-break; anything past the cap folds into its node's
 *   collapsed badge exactly like an unfocused source would.
 * - **Never silently drops a source** (principle 12): a source whose
 *   `nodeId` matches no entry in `nodes` at all — a stale id, a race
 *   between a node leaving the canvas and its source arriving — folds into
 *   one deterministic `UNATTACHED_BUBBLE_NODE_ID` badge, fixed at the
 *   canvas origin, rather than vanishing with no trace. The caller
 *   (`PlotCanvas`) computes an absolute extent for every visible node,
 *   contained ones included, so this path is expected to be unreachable in
 *   practice — it exists so "unreachable" is provable, not assumed.
 *
 * Coordinates are whatever space the caller passes for `nodes` and
 * `reservedRegions` — PlotCanvas passes screen space (post pan/zoom) because
 * a minimap's reserved rect is screen-anchored, not flow-anchored; the
 * engine itself never converts between spaces.
 */

import type { NodeExtent } from "../solver/push.js";
import type { BubbleSource } from "./model.js";

export interface BubbleRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ReservedRegion extends BubbleRect {
  readonly id: string;
}

export type BubblePlacement =
  | {
      readonly kind: "bubble";
      readonly source: BubbleSource;
      readonly rect: BubbleRect;
    }
  | {
      readonly kind: "collapsed";
      readonly nodeId: string;
      readonly rect: BubbleRect;
      /** Every source folded into this badge — unfocused, or over the cap. */
      readonly sourceIds: readonly string[];
    };

export interface BubblePlacementOptions {
  /** "cap how many show at once" (§5) — default a sensible six. */
  readonly globalCap?: number;
  /** Pure text-to-lines estimate, injectable so tests stay deterministic. */
  readonly measureLines?: (text: string, width: number) => number;
  /** Vertical gap between a node's edge and its nearest bubble/badge. */
  readonly gap?: number;
}

export const DEFAULT_GLOBAL_BUBBLE_CAP = 6;
/**
 * The sentinel `nodeId` a `collapsed` placement carries when its sources
 * matched no node extent at all (see the file doc comment's "never
 * silently drops a source" bullet). Not a real node id — a host renders
 * this placement the same as any other collapsed badge, just not attached
 * to anything on screen.
 */
export const UNATTACHED_BUBBLE_NODE_ID = "__unattached__";
const DEFAULT_GAP = 6;
const LINE_HEIGHT = 16;
const BUBBLE_PADDING = 8;
const CHAR_WIDTH_ESTIMATE = 7;
const BADGE_SIZE = 20;

function defaultMeasureLines(text: string, width: number): number {
  const charsPerLine = Math.max(1, Math.floor(width / CHAR_WIDTH_ESTIMATE));
  return Math.max(1, Math.ceil(text.length / charsPerLine));
}

function rectsIntersect(a: BubbleRect, b: BubbleRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function collidesWithAny(
  rect: BubbleRect,
  regions: readonly ReservedRegion[],
): boolean {
  return regions.some((region) => rectsIntersect(rect, region));
}

/** Sort order for the global cap (§5): attention first, then recency, then id. */
function comparePriority(a: BubbleSource, b: BubbleSource): number {
  if (a.wantsAttention !== b.wantsAttention) {
    return a.wantsAttention ? -1 : 1;
  }
  if (a.updatedAt !== b.updatedAt) {
    return b.updatedAt - a.updatedAt;
  }
  return a.id.localeCompare(b.id);
}

function badgeRect(node: NodeExtent): BubbleRect {
  return {
    x: node.x + node.width - BADGE_SIZE,
    y: node.y - BADGE_SIZE,
    width: BADGE_SIZE,
    height: BADGE_SIZE,
  };
}

export function computeBubblePlacements(
  nodes: readonly NodeExtent[],
  sources: readonly BubbleSource[],
  focusedNodeIds: ReadonlySet<string>,
  reservedRegions: readonly ReservedRegion[] = [],
  options: BubblePlacementOptions = {},
): readonly BubblePlacement[] {
  const globalCap = options.globalCap ?? DEFAULT_GLOBAL_BUBBLE_CAP;
  const measureLines = options.measureLines ?? defaultMeasureLines;
  const gap = options.gap ?? DEFAULT_GAP;

  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  const byNode = new Map<string, BubbleSource[]>();
  const unattachedSourceIds: string[] = [];
  for (const source of sources) {
    if (!nodesById.has(source.nodeId)) {
      // Never silently drops a source (principle 12) — folded into the
      // deterministic unattached badge below instead of vanishing.
      unattachedSourceIds.push(source.id);
      continue;
    }
    const bucket = byNode.get(source.nodeId) ?? [];
    bucket.push(source);
    byNode.set(source.nodeId, bucket);
  }

  const overflow = new Map<string, string[]>();
  function addOverflow(source: BubbleSource): void {
    const bucket = overflow.get(source.nodeId) ?? [];
    bucket.push(source.id);
    overflow.set(source.nodeId, bucket);
  }

  const placements: BubblePlacement[] = [];
  const placedRectsByNode = new Map<string, BubbleRect[]>();

  // Every source on a focused node competes for the global cap, in one
  // priority order across the whole canvas — not per node — so "attention-
  // wanting first, then recency" is a fact about the canvas, not a fact
  // decided independently per node.
  const candidates: BubbleSource[] = [];
  for (const [nodeId, group] of byNode) {
    if (!focusedNodeIds.has(nodeId)) {
      // Unfocused: every source on this node collapses, unconditionally.
      overflow.set(
        nodeId,
        group.map((source) => source.id),
      );
      continue;
    }
    candidates.push(...group);
  }
  candidates.sort(comparePriority);

  let placedCount = 0;
  for (const source of candidates) {
    if (placedCount >= globalCap) {
      addOverflow(source);
      continue;
    }
    const node = nodesById.get(source.nodeId);
    if (!node) continue; // unreachable given the byNode filter above

    const stack = placedRectsByNode.get(source.nodeId) ?? [];
    const index = stack.length;
    const width = node.width;
    const height =
      measureLines(source.text, width) * LINE_HEIGHT + BUBBLE_PADDING;

    const above: BubbleRect = {
      x: node.x,
      y: node.y - gap - height - index * (height + gap),
      width,
      height,
    };
    const below: BubbleRect = {
      x: node.x,
      y: node.y + node.height + gap + index * (height + gap),
      width,
      height,
    };

    const rect = !collidesWithAny(above, reservedRegions)
      ? above
      : !collidesWithAny(below, reservedRegions)
        ? below
        : null;

    if (rect === null) {
      // Never obscure a reserved region (§5) — collapse rather than draw
      // somewhere illegal.
      addOverflow(source);
      continue;
    }

    placements.push({ kind: "bubble", source, rect });
    placedRectsByNode.set(source.nodeId, [...stack, rect]);
    placedCount++;
  }

  for (const [nodeId, sourceIds] of overflow) {
    const node = nodesById.get(nodeId);
    if (!node || sourceIds.length === 0) continue;
    placements.push({
      kind: "collapsed",
      nodeId,
      rect: badgeRect(node),
      sourceIds,
    });
  }

  if (unattachedSourceIds.length > 0) {
    placements.push({
      kind: "collapsed",
      nodeId: UNATTACHED_BUBBLE_NODE_ID,
      rect: { x: 0, y: 0, width: BADGE_SIZE, height: BADGE_SIZE },
      sourceIds: unattachedSourceIds,
    });
  }

  return placements;
}
