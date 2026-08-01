/**
 * `BoardState` (the client's live mirror of the server) into a
 * `GraphSnapshot` (what the canvas, the palette, the warnings surface, and
 * the context-input list actually render). Pure and synchronous: every fact
 * that needs IO to produce — an object's real content, chiefly — is resolved
 * by the caller first and handed in as `objectContent`, so this function
 * itself needs nothing but the state already in memory.
 */

import type { NodeRole } from "@plotroom/core";

import type {
  CanvasContainerInput,
  CanvasEdgeInput,
  CanvasNodeInput,
} from "../canvas/PlotCanvas.js";
import type { PaletteEntry, PaletteEntryKind } from "../palette/model.js";
import type { BoardState } from "./board-state.js";
import type { ContextEdgeFact, GraphSnapshot, WarningFacts } from "./types.js";

/** A deterministic placeholder layout — "derived initial arrangement" (Epic 3.1) is still open. */
function gridPosition(index: number): { x: number; y: number } {
  const columns = 6;
  return {
    x: (index % columns) * 220,
    y: Math.floor(index / columns) * 160,
  };
}

const PALETTE_OBJECT_KINDS: ReadonlySet<string> = new Set([
  "ticket",
  "pull_request",
  "review",
  "document",
]);

export function buildGraphSnapshot(
  state: BoardState,
  objectContent: ReadonlyMap<string, string>,
): GraphSnapshot {
  const containers: CanvasContainerInput[] = [
    ...state.workstreams.values(),
  ].map((workstream, index) => {
    const subject = workstream.subjectId
      ? state.objects.get(workstream.subjectId)
      : undefined;
    return {
      id: workstream.id,
      label: `workstream: ${subject?.title ?? workstream.subjectId ?? workstream.id}`,
      defaultPosition: gridPosition(index),
    };
  });

  const liveNodes = [...state.nodes.values()];

  const nodes: CanvasNodeInput[] = liveNodes.map((node, index) => ({
    id: node.id,
    label: labelForNode(node.role, node.refId, state),
    role: node.role,
    ...(node.running !== undefined ? { running: node.running } : {}),
    ...(node.workstreamId ? { containerId: node.workstreamId } : {}),
    defaultPosition: gridPosition(index),
    acceptsDefinitionDrop: acceptsDefinitionDrop(node, state),
  }));

  const edges: CanvasEdgeInput[] = [...state.edges.values()].map((edge) => ({
    id: edge.id,
    source: edge.from,
    target: edge.to,
  }));

  const contextEdges: ContextEdgeFact[] = [...state.edges.values()]
    .filter((edge) => edge.kind === "context")
    .map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      ordinal: edge.kind === "context" ? edge.ordinal : 0,
    }));

  const warningFacts = buildWarningFacts(
    liveNodes,
    state,
    contextEdges,
    objectContent,
  );

  const paletteEntries = buildPaletteEntries(state);

  return {
    nodes,
    edges,
    containers,
    warningFacts,
    paletteEntries,
    contextEdges,
  };
}

function labelForNode(
  role: NodeRole,
  refId: string,
  state: BoardState,
): string {
  if (role === "content") {
    const object = state.objects.get(refId);
    if (object) return object.title;
    const output = state.outputs.get(refId);
    if (output) return `output: ${output.name}`;
    return `content ${refId}`;
  }
  if (role === "command") {
    const command = state.commands.get(refId);
    const definition = command
      ? state.commandDefinitions.get(command.definitionId)
      : undefined;
    return `command: ${definition?.name ?? refId}`;
  }
  // role === "session": no session store wired yet (Epic 4.1's API has not
  // landed), so this is an honest placeholder, not a lookup.
  return `session ${refId}`;
}

/** A bare (containerless) ticket accepts a dropped definition (§3.5, §3.3). */
function acceptsDefinitionDrop(
  node: BoardState["nodes"] extends ReadonlyMap<string, infer N> ? N : never,
  state: BoardState,
): boolean {
  if (node.role !== "content" || node.workstreamId !== null) return false;
  const object = state.objects.get(node.refId);
  return object?.kind === "ticket";
}

/**
 * Per-node facts `deriveGraphWarnings` needs beyond role: a pre-bind output
 * placeholder's produced/published state (§3.5), and a command's assembled
 * context content, real text joined in assembly order — `deriveGraphWarnings`
 * is what runs `@plotroom/core`'s `estimateTokens`/`checkContentBudget` over
 * it for the fifth §5 warning; this only supplies the real content.
 */
function buildWarningFacts(
  liveNodes: readonly {
    readonly id: string;
    readonly role: NodeRole;
    readonly refId: string;
  }[],
  state: BoardState,
  contextEdges: readonly ContextEdgeFact[],
  objectContent: ReadonlyMap<string, string>,
): ReadonlyMap<string, WarningFacts> {
  const facts = new Map<string, WarningFacts>();
  const nodeById = new Map(liveNodes.map((node) => [node.id, node]));

  for (const node of liveNodes) {
    if (node.role !== "content") continue;
    const output = state.outputs.get(node.refId);
    if (!output) continue;
    facts.set(node.id, {
      producedOutput: output.boundObjectId !== null,
      published: output.publishedAt !== null,
    });
  }

  for (const node of liveNodes) {
    if (node.role !== "command") continue;
    const sources = contextEdges
      .filter((edge) => edge.to === node.id)
      .sort((a, b) => a.ordinal - b.ordinal);
    if (sources.length === 0) continue;

    const assembledContent = sources
      .map((edge) => {
        const sourceNode = nodeById.get(edge.from);
        if (!sourceNode) return "";
        return objectContent.get(sourceNode.refId) ?? "";
      })
      .filter((text) => text.length > 0)
      .join("\n");

    if (assembledContent.length === 0) continue;
    facts.set(node.id, { ...facts.get(node.id), assembledContent });
  }

  return facts;
}

/**
 * The palette (§5): live objects of a palette-eligible kind not already
 * placed as a content node, plus every live command definition (a
 * definition never itself becomes a placed node — only instantiating it
 * does). Past sessions are omitted honestly: there is no sessions API yet
 * (Epic 4.1). Ticket `blockedBy` is always empty: the shipped object model
 * carries no "blocks"/"blocked by" relationship yet, so there is nothing
 * honest to report beyond "nothing known to block this".
 */
function buildPaletteEntries(state: BoardState): readonly PaletteEntry[] {
  const placedObjectIds = new Set(
    [...state.nodes.values()]
      .filter((node) => node.role === "content")
      .map((node) => node.refId),
  );

  const objectEntries: PaletteEntry[] = [...state.objects.values()]
    .filter(
      (object) =>
        PALETTE_OBJECT_KINDS.has(object.kind) &&
        !placedObjectIds.has(object.id),
    )
    .map((object) => ({
      id: object.id,
      kind: object.kind as PaletteEntryKind,
      label: object.title,
      ...(object.kind === "ticket" ? { blockedBy: [] } : {}),
    }));

  // `commands.definitions()` (what fills `state.commandDefinitions`, via the
  // snapshot route) already excludes soft-deleted rows.
  const definitionEntries: PaletteEntry[] = [
    ...state.commandDefinitions.values(),
  ].map((definition) => ({
    id: definition.id,
    kind: "command_definition" as const,
    label: `command definition: ${definition.name}`,
  }));

  return [...objectEntries, ...definitionEntries];
}
