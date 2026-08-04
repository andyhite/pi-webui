/**
 * The canvas (spec §5), mechanics only — no visual design until the design
 * package lands (fleet rule 5). xyflow is the base; rigid-body push, durable
 * placement, mid-drag connection refusal, zoom-level renderers, collapsing
 * containers, multi-select, off-screen attention, and the drag-to-empty
 * create menu are built on top of it. Nodes are DOM-based so plugin card
 * renderers and keyboard access work later.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Connection,
  Edge,
  FinalConnectionState,
  IsValidConnection,
  Node,
  NodeProps,
  NodeTypes,
  OnDelete,
  OnNodeDrag,
  OnSelectionChangeFunc,
} from "@xyflow/react";
import {
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useViewport,
} from "@xyflow/react";
import type { GraphNode, NodeId, NodeRole } from "@plotroom/core";
import { checkConnection } from "@plotroom/core";

// xyflow's base stylesheet: the bare minimum for the canvas to function
// (node positioning, edge rendering, connection interaction). No product
// styling until the design package lands (fleet rule 5).
import "@xyflow/react/dist/style.css";

import type { NodeExtent, Point } from "../solver/push.js";
import { solvePush } from "../solver/push.js";
import type { Placements } from "../placement/store.js";
import { deriveInitialArrangement } from "../placement/derive.js";
import { zoomLevelForScale } from "../zoom/level.js";
import type { ZoomLevel, ZoomThresholds } from "../zoom/level.js";
import {
  effectiveCollapsedContainers,
  remapEdgesForCollapse,
} from "../containers/collapse.js";
import type { ParentOf } from "../containers/collapse.js";
import { actionsForSelection } from "../selection/multi-select.js";
import type { SelectionActionId } from "../selection/multi-select.js";
import { clusterOffScreenAttention } from "../attention/off-screen.js";
import type { OffScreenMarker } from "../attention/off-screen.js";
import {
  computeBubblePlacements,
  DEFAULT_GLOBAL_BUBBLE_CAP,
} from "../bubbles/placement.js";
import type { ReservedRegion } from "../bubbles/placement.js";
import { BubbleLayer } from "../bubbles/BubbleLayer.js";
import type { BubbleSource } from "../bubbles/model.js";
import {
  CREATE_MENU_OPTIONS,
  legalCreateMenuOptions,
} from "../legality/create-menu.js";
import type { CreateMenuOption } from "../legality/create-menu.js";
import type { KeyBinding } from "../keyboard/bindings.js";
import { useFocusTrap } from "../keyboard/use-focus-trap.js";
import { useKeyBindings } from "../keyboard/use-key-bindings.js";
import { LiveRegion } from "../keyboard/LiveRegion.js";
import { createUndoStack } from "../undo/stack.js";
import { focusedCanvasNodeId } from "./focused-node.js";
import {
  addTombstones,
  clearTombstones,
  withoutTombstoned,
} from "./tombstones.js";
import { remotelyDeletedIds, withConfirmed } from "./reconcile.js";
import { applyArrangementReset } from "./arrangement-reset.js";
import {
  computeAbsoluteScreenExtents,
  toExtentAwareNodes,
} from "./node-extents.js";

/**
 * A plugin-contributed card, compact or expanded (§10.1, §3.2): declarative
 * so a plugin cannot break focus management for the whole board — the host
 * draws it, never the plugin's own markup. Deliberately the same shape as
 * `@plotroom/plugin-sdk`'s frozen `CardView` (`docs/plugin-contract.md`),
 * but declared independently here rather than imported: the canvas is core
 * mechanics and must not take a hard dependency on the plugin contract —
 * the contribution registry (`plugins/contribution-registry.ts`) is what
 * maps one onto the other.
 */
export interface CanvasCardAction {
  readonly id: string;
  readonly label: string;
  /** Set when the action is a write, so §6.6's approvals apply to a card button too. */
  readonly writeActionId: string | null;
}

export interface CanvasCardView {
  readonly title: string;
  readonly lines: readonly string[];
  readonly actions: readonly CanvasCardAction[];
}

export interface CanvasNodeInput {
  readonly id: string;
  readonly label: string;
  readonly role: NodeRole;
  /** Sessions only: whether the session is still running (accepts context). */
  readonly running?: boolean;
  /** Position used when no durable placement exists for this node yet. */
  readonly defaultPosition: Point;
  /** The workstream container this node lives inside, if any (§3.3). */
  readonly containerId?: string;
  /**
   * A bare (containerless) ticket accepts a dropped command definition,
   * which creates a workstream in one gesture (§3.5, §3.3).
   */
  readonly acceptsDefinitionDrop?: boolean;
  /**
   * The object/command/output/session this node stands for (a `PlacedNode`'s
   * `refId`, spec §3.7) — opaque to the canvas itself, but what a host needs
   * to resolve "what does this node mean" for a gesture like the one-gesture
   * workstream flow (subject = the ticket's *object*, not its node).
   */
  readonly refId?: string;
  /**
   * A content node's concept kind (§3.1), when it stands for a real object —
   * opaque to the canvas beyond being the key a card renderer is resolved by.
   */
  readonly kind?: string;
  /**
   * A plugin card view for this node, precomputed by the caller (§10.1) —
   * resolving one is async and may need IO, so it is never computed here.
   * Absent: the host's own generic rendering (the `label`) applies —
   * concepts never render broken for want of a plugin (§10.2).
   */
  readonly cardView?: CanvasCardView;
}

export interface CanvasContainerInput {
  readonly id: string;
  readonly label: string;
  readonly defaultPosition: Point;
}

export interface CanvasEdgeInput {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export interface PlotCanvasProps {
  readonly nodes: readonly CanvasNodeInput[];
  readonly edges: readonly CanvasEdgeInput[];
  /** Workstream containers (spec §3.3): collapse and expand as one frame. */
  readonly containers?: readonly CanvasContainerInput[];
  /**
   * Ids the human manually collapsed; edges into them draw to the frame.
   * The workstream zoom level (§5) also forces every container to render
   * collapsed regardless of this set — see `effectiveCollapsedContainerIds`
   * internally. `onToggleContainer` always flips *this* manual set, so a
   * toggle made while zoomed out (rendered collapsed either way) is still
   * the human's real preference once zoomed back in.
   */
  readonly collapsedContainerIds?: ReadonlySet<string>;
  readonly onToggleContainer?: (containerId: string) => void;
  /** Durable placements, loaded by the host through a PlacementStore. */
  readonly placements: Placements;
  /** Called with every node's position whenever an arrangement settles. */
  readonly onPlacementsChange: (placements: Placements) => void;
  /**
   * A one-shot signal for "reset arrangement" (§5's only automatic-layout
   * verb): bump this (e.g. an incrementing counter) *after* the host has
   * already written fresh `placements` for every node, and every currently
   * mounted node jumps to its new placement exactly once. This is
   * deliberately not a react-to-`placements`-changed effect — durable
   * placement means an already-mounted node's position must otherwise never
   * move just because `placements` changed underneath it (a live snapshot
   * updating some other node's stored spot, say); only a genuine bump of
   * this counter re-applies positions to nodes already on the canvas.
   * Omitted or unchanged: nothing resets.
   */
  readonly arrangementEpoch?: number;
  readonly selectedNodeId: string | null;
  /** The one navigation primitive; null clears the selection. */
  readonly onSelectNode: (nodeId: string | null) => void;
  /** Ids of nodes off-screen attention markers should track (spec §5, §7). */
  readonly attentionNodeIds?: readonly string[];
  /**
   * "One derivation, many surfaces" (§7): node state is one of them, and it
   * reads the exact same attention feed `attentionNodeIds` clusters into
   * off-screen markers — same items, one rendering per node instead of one
   * per off-screen cluster. Rendered the same way `warningsByNodeId`
   * already flags a card (a small badge, regardless of zoom), because a
   * node wanting attention and a node with a graph warning are the same
   * *kind* of fact even though they come from different derivations.
   */
  readonly attentionByNodeId?: ReadonlyMap<
    string,
    { readonly count: number; readonly topFeed: string }
  >;
  /** Zoom thresholds for the workstream/inner/detail renderer switch. */
  readonly zoomThresholds?: ZoomThresholds;
  /** A batch action chosen from the contextual action bar over a multi-selection. */
  readonly onBatchAction?: (
    action: SelectionActionId,
    selectedNodeIds: readonly string[],
  ) => void;
  /** The create-menu option chosen after dragging an edge to empty canvas. */
  readonly onCreateFromDrag?: (
    sourceNodeId: string,
    option: CreateMenuOption,
    position: Point,
  ) => void;
  readonly createMenuOptions?: readonly CreateMenuOption[];
  /**
   * A context edge was drawn between two existing, already-legal nodes
   * (§3.5, §3.7) — the host authors it (e.g. `POST /api/edges`); the local
   * xyflow edge always draws immediately regardless, since illegal
   * connections are refused mid-drag and never reach here at all.
   */
  readonly onWireContext?: (from: string, to: string) => void;
  /**
   * A command definition was dropped onto a bare ticket (§3.5): dropping a
   * definition onto a bare ticket creates a workstream in one gesture.
   * `definitionId` is exactly what the drag source set as the
   * `COMMAND_DEFINITION_DRAG_TYPE` payload (the palette's own entry id).
   */
  readonly onDropDefinitionOnTicket?: (
    ticketNodeId: string,
    definitionId: string,
  ) => void;
  /**
   * A palette entry (§5) was dropped onto empty canvas — the palette rail's
   * drag sources place a not-yet-placed object. The host resolves the
   * entry id to whatever node it should become; this only reports where it
   * landed, in flow coordinates.
   */
  readonly onDropPaletteEntry?: (entryId: string, position: Point) => void;
  /** Per-node warning messages (spec §5), flagged on the card regardless of zoom. */
  readonly warningsByNodeId?: ReadonlyMap<string, readonly string[]>;
  /**
   * The minimal run affordance (§4.1): a "run" gesture on a command node.
   * The host generates the initiation key and POSTs `/api/runs` (idempotent,
   * principle 9), surfacing readiness/refusal reasons itself — this only
   * reports which command node asked. Absent: no run button renders at all
   * (mechanics only; offline/fixture hosts can choose not to wire it).
   */
  readonly onRunCommand?: (commandNodeId: string) => void;
  /**
   * Command node ids with a run already in flight (§4.1, principle 9 at the
   * gesture level): the run button disables for exactly these, so a
   * double-click cannot fire a second initiation key before the first
   * request has settled. The host owns the set (e.g. over `run-guard.ts`'s
   * pure `beginRun`/`endRun`) — this only renders it.
   */
  readonly runningCommandNodeIds?: ReadonlySet<string>;
  /**
   * A card action button was clicked (§10.1) — `actionId` is one of the
   * clicked node's own `cardView.actions` ids; the host dispatches it
   * (write actions route through §6.6's approvals, same as any other write).
   */
  readonly onCardAction?: (nodeId: string, actionId: string) => void;
  /**
   * Speech bubbles (§5): every source that could show as a bubble on some
   * node currently on this canvas — the host derives these from its own
   * streams (`bubbles/derive-sources.ts`, a fixture question source, ...).
   * Absent or empty: no bubble layer renders at all.
   */
  readonly bubbleSources?: readonly BubbleSource[];
  /** A `question`-kind bubble's option was clicked (§6.4) — the host answers through its `QuestionDataSource`. */
  readonly onAnswerQuestion?: (source: BubbleSource, option: string) => void;
  /** "cap how many show at once" (§5) — defaults to `DEFAULT_GLOBAL_BUBBLE_CAP`. */
  readonly bubbleCap?: number;
}

/** The drag payload a command-definition drag source sets (host's palette). */
export const COMMAND_DEFINITION_DRAG_TYPE =
  "application/x-plotroom-command-definition";

/** The drag payload a palette row sets (`PaletteRail`'s drag sources, §5). */
export const PALETTE_ENTRY_DRAG_TYPE = "application/x-plotroom-palette-entry";

type BoxNodeData = {
  label: string;
  role: NodeRole;
  running: boolean;
  zoomLevel: ZoomLevel;
  /** Selection-as-route (§5): this node is the one the address points at. */
  routeSelected: boolean;
  /** Set when this is a bare ticket that accepts a dropped definition. */
  acceptsDefinitionDrop: boolean;
  onDropDefinition?: (definitionId: string) => void;
  /** Graph warnings for this node (§5): flagged on the card, regardless of zoom. */
  warnings: readonly string[];
  /** One derivation, many surfaces (§7): this node's own attention badge, if any. */
  attention: { readonly count: number; readonly topFeed: string } | null;
  /** Set on a command node when the host wired the run gesture (§4.1). */
  onRun?: () => void;
  /** True while this command node's run is already in flight (§4.1). */
  runInFlight: boolean;
  /** A plugin card view, precomputed by the caller (§10.1) — absent means the generic `label` rendering applies. */
  cardView: CanvasCardView | null;
  /** Dispatches a card action's id when its button is clicked (§10.1). */
  onCardAction?: (actionId: string) => void;
};

type BoxNode = Node<BoxNodeData, "box">;

type ContainerNodeData = {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
};

type ContainerNode = Node<ContainerNodeData, "container">;

type CanvasNode = BoxNode | ContainerNode;

/** Fallbacks for the first frame, before xyflow has measured the DOM. */
const FALLBACK_WIDTH = 140;
const FALLBACK_HEIGHT = 40;
const CONTAINER_WIDTH = 420;
const CONTAINER_HEIGHT = 280;
/** The unstyled `<MiniMap>`'s own default footprint (§5's reserved region). */
const MINIMAP_WIDTH = 200;
const MINIMAP_HEIGHT = 150;
const MINIMAP_MARGIN = 15;

function BoxNodeView({ data, id, selected }: NodeProps<BoxNode>) {
  // Unstyled by design (fleet rule 5): a visible rectangle with a label is
  // the bare minimum for the mechanics to be exercised. Content varies by
  // zoom level (spec §5): workstream level shows identity only, inner level
  // adds the id, detail level adds role and running state.
  //
  // Two independent selection concepts share this border: `routeSelected`
  // (§5 "selection is the route", one node, drives navigation) and
  // `selected` (xyflow's own multi-select state, driven by marquee/modified
  // click, drives the contextual action bar). They can disagree and both
  // render, deliberately — they answer different questions.
  const border = data.routeSelected
    ? selected
      ? "3px solid black"
      : "2px solid black"
    : selected
      ? "2px dotted black"
      : "1px solid black";
  return (
    <div
      // A stable hook for driving mechanics from outside React (e2e tests,
      // §5's milestone gate in particular) — not a styling decision.
      data-testid={`canvas-node-${id}`}
      style={{
        border,
        background: "white",
        padding: "6px 10px",
      }}
      // One-gesture flow (spec §3.5): dropping a command definition onto a
      // bare ticket creates a workstream. Only nodes flagged as accepting a
      // drop wire up the handlers at all.
      {...(data.acceptsDefinitionDrop
        ? {
            onDragOver: (event: React.DragEvent) => event.preventDefault(),
            onDrop: (event: React.DragEvent) => {
              event.preventDefault();
              if (
                event.dataTransfer.types.includes(COMMAND_DEFINITION_DRAG_TYPE)
              ) {
                const definitionId = event.dataTransfer.getData(
                  COMMAND_DEFINITION_DRAG_TYPE,
                );
                data.onDropDefinition?.(definitionId);
              }
            },
          }
        : {})}
    >
      <Handle type="target" position={Position.Left} />
      {data.cardView ? (
        // A plugin card (§10.1): declarative title/lines/actions the host
        // draws, never the plugin's own markup. Absent `cardView`: the
        // generic `label` below applies — concepts never render broken for
        // want of a plugin contribution (§10.2).
        <div data-testid={`canvas-node-card-${id}`}>
          <div>{data.cardView.title}</div>
          <ul aria-label={`${data.cardView.title} details`}>
            {data.cardView.lines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
          {data.cardView.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              onClick={() => data.onCardAction?.(action.id)}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : (
        <div>{data.label}</div>
      )}
      {data.warnings.length > 0 ? (
        <div>
          ⚠ {data.warnings.length} warning
          {data.warnings.length === 1 ? "" : "s"}
        </div>
      ) : null}
      {data.attention ? (
        // One derivation, many surfaces (§7): the same badge shape
        // `warningsByNodeId` renders above, for the attention feed instead
        // of graph warnings — a node can carry both at once, independently.
        <div data-testid={`node-attention-${id}`}>
          ● {data.attention.count} attention ({data.attention.topFeed})
        </div>
      ) : null}
      {data.acceptsDefinitionDrop ? (
        <div>(drop a command definition here)</div>
      ) : null}
      {data.role === "command" && data.onRun ? (
        <button type="button" onClick={data.onRun} disabled={data.runInFlight}>
          {data.runInFlight ? "running…" : "run"}
        </button>
      ) : null}
      {data.zoomLevel !== "workstream" ? <div>id: {id}</div> : null}
      {data.zoomLevel === "detail" ? (
        <div>
          role: {data.role}
          {data.role === "session" ? `, running: ${String(data.running)}` : ""}
        </div>
      ) : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function ContainerNodeView({ data }: NodeProps<ContainerNode>) {
  // Collapsed: one card (identity only). Expanded: a frame around its
  // children, drawn behind them via xyflow's parent/child z-ordering.
  return (
    <div
      style={{
        border: "2px dashed black",
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        padding: "4px 8px",
      }}
    >
      <button type="button" onClick={data.onToggle}>
        {data.collapsed ? "expand" : "collapse"}
      </button>{" "}
      {data.label}
    </div>
  );
}

const nodeTypes: NodeTypes = {
  box: BoxNodeView,
  container: ContainerNodeView,
};

function toGraphNode(input: CanvasNodeInput): GraphNode {
  return {
    // Fixture ids become branded NodeIds here, at the single boundary where
    // the canvas hands nodes to the core legality predicate.
    id: input.id as NodeId,
    role: input.role,
    ...(input.running !== undefined ? { running: input.running } : {}),
  };
}

/** Legend + live counts (spec §5): unstyled, mechanics only. */
function CanvasLegend({ nodes }: { nodes: readonly CanvasNodeInput[] }) {
  const counts = useMemo(() => {
    const byRole = new Map<NodeRole, number>();
    for (const node of nodes) {
      byRole.set(node.role, (byRole.get(node.role) ?? 0) + 1);
    }
    return byRole;
  }, [nodes]);

  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        left: 8,
        zIndex: 5,
        background: "white",
      }}
    >
      <ul aria-label="nodes on the canvas, by role">
        {[...counts.entries()].map(([role, count]) => (
          <li key={role}>
            {role}: {count}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Contextual action bar over a multi-selection (spec §5). */
function ActionBar({
  selectedIds,
  actions,
  onAction,
}: {
  selectedIds: readonly string[];
  actions: readonly SelectionActionId[];
  onAction: (action: SelectionActionId) => void;
}) {
  if (selectedIds.length < 2 || actions.length === 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        zIndex: 5,
        background: "white",
      }}
    >
      <span>{selectedIds.length} selected</span>
      {actions.map((action) => (
        <button key={action} type="button" onClick={() => onAction(action)}>
          {action}
        </button>
      ))}
    </div>
  );
}

const SECTOR_STYLE: Record<OffScreenMarker["sector"], React.CSSProperties> = {
  n: { top: 4, left: "50%" },
  s: { bottom: 4, left: "50%" },
  e: { top: "50%", right: 4 },
  w: { top: "50%", left: 4 },
  ne: { top: 4, right: 4 },
  nw: { top: 4, left: 4 },
  se: { bottom: 4, right: 4 },
  sw: { bottom: 4, left: 4 },
};

/** Off-screen attention markers, clustered by sector (spec §5, §7). */
function AttentionMarkers({
  markers,
}: {
  markers: readonly OffScreenMarker[];
}) {
  return (
    <>
      {markers.map((marker) => (
        <div
          key={marker.sector}
          style={{
            position: "absolute",
            zIndex: 5,
            background: "white",
            border: "1px solid black",
            ...SECTOR_STYLE[marker.sector],
          }}
        >
          {marker.count}
        </div>
      ))}
    </>
  );
}

/**
 * Drag-to-empty-canvas create menu, filtered to legal targets (spec §5).
 *
 * A dialog like any other (§11, Epic 8.1): focus moves into it on open,
 * cycles inside it, and returns to whatever had it when it closes
 * (`useFocusTrap`); `data-key-scope="dialog:create-menu"` keeps the canvas's
 * own keys from firing behind it, and its Escape is a registered binding so
 * the shortcuts overlay lists it.
 */
function CreateMenu({
  position,
  options,
  onPick,
  onDismiss,
}: {
  position: Point;
  options: readonly CreateMenuOption[];
  onPick: (option: CreateMenuOption) => void;
  onDismiss: () => void;
}) {
  const containerRef = useFocusTrap<HTMLDivElement>(true);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const bindings = useMemo<readonly KeyBinding[]>(
    () => [
      {
        kind: "dispatched",
        id: "create-menu-dismiss",
        chords: [{ key: "Escape" }],
        label: "dismiss the create menu",
        description:
          "closes the menu a drag to empty canvas opened, creating nothing",
        scope: "dialog",
        surface: "create-menu",
        run: () => dismissRef.current(),
      },
    ],
    [],
  );
  useKeyBindings(bindings);

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label="create from this connection"
      data-key-scope="dialog:create-menu"
      data-testid="create-menu"
      tabIndex={-1}
      style={{
        position: "absolute",
        zIndex: 10,
        top: position.y,
        left: position.x,
        background: "white",
        border: "1px solid black",
      }}
    >
      {options.length === 0 ? (
        <div role="status">nothing here can legally receive that</div>
      ) : (
        <ul role="listbox" aria-label="what this connection can legally create">
          {options.map((option) => (
            <li key={option.kind} role="option" aria-selected={false}>
              <button type="button" onClick={() => onPick(option)}>
                {option.kind}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={onDismiss}>
        cancel
      </button>
    </div>
  );
}

function toBoxNode(
  input: CanvasNodeInput,
  ctx: {
    readonly zoomLevel: ZoomLevel;
    readonly selectedNodeId: string | null;
    readonly placements: Placements;
    readonly collapsedContainerIds: ReadonlySet<string>;
    readonly onDropDefinitionOnTicket?: (
      ticketNodeId: string,
      definitionId: string,
    ) => void;
    readonly warningsByNodeId?: ReadonlyMap<string, readonly string[]>;
    readonly attentionByNodeId?: ReadonlyMap<
      string,
      { readonly count: number; readonly topFeed: string }
    >;
    readonly onRunCommand?: (commandNodeId: string) => void;
    readonly runningCommandNodeIds?: ReadonlySet<string>;
    readonly onCardAction?: (nodeId: string, actionId: string) => void;
  },
): BoxNode {
  return {
    id: input.id,
    type: "box" as const,
    // Tab traversal must announce what it landed on (§11): xyflow already
    // makes every node wrapper tabbable, and this is what it reads out.
    ariaLabel: `${input.role}: ${input.label}`,
    position: ctx.placements[input.id] ?? input.defaultPosition,
    ...(input.containerId
      ? { parentId: input.containerId, extent: "parent" as const }
      : {}),
    hidden: input.containerId
      ? ctx.collapsedContainerIds.has(input.containerId)
      : false,
    data: {
      label: input.label,
      role: input.role,
      running: input.running ?? false,
      zoomLevel: ctx.zoomLevel,
      routeSelected: input.id === ctx.selectedNodeId,
      acceptsDefinitionDrop: input.acceptsDefinitionDrop ?? false,
      warnings: ctx.warningsByNodeId?.get(input.id) ?? [],
      attention: ctx.attentionByNodeId?.get(input.id) ?? null,
      runInFlight: ctx.runningCommandNodeIds?.has(input.id) ?? false,
      cardView: input.cardView ?? null,
      ...(ctx.onDropDefinitionOnTicket
        ? {
            onDropDefinition: (definitionId: string) =>
              ctx.onDropDefinitionOnTicket?.(input.id, definitionId),
          }
        : {}),
      ...(input.role === "command" && ctx.onRunCommand
        ? { onRun: () => ctx.onRunCommand?.(input.id) }
        : {}),
      ...(ctx.onCardAction
        ? {
            onCardAction: (actionId: string) =>
              ctx.onCardAction?.(input.id, actionId),
          }
        : {}),
    },
  };
}

function CanvasInner({
  nodes: nodeInputs,
  edges: edgeInputs,
  containers = [],
  collapsedContainerIds = new Set<string>(),
  onToggleContainer,
  placements,
  onPlacementsChange,
  arrangementEpoch = 0,
  selectedNodeId,
  onSelectNode,
  attentionNodeIds = [],
  zoomThresholds,
  onBatchAction,
  onCreateFromDrag,
  createMenuOptions = CREATE_MENU_OPTIONS,
  onWireContext,
  onDropDefinitionOnTicket,
  onDropPaletteEntry,
  warningsByNodeId,
  attentionByNodeId,
  onRunCommand,
  runningCommandNodeIds,
  onCardAction,
  bubbleSources = [],
  onAnswerQuestion,
  bubbleCap,
}: PlotCanvasProps) {
  const { zoom } = useViewport();
  const zoomLevel = zoomLevelForScale(zoom, zoomThresholds);

  // "Zoomed out: one card per workstream" (§5) is a second, independent
  // force collapsing containers alongside the human's manual toggle (§3.3):
  // at the workstream zoom level every container collapses to its frame
  // regardless of what the human chose, and un-collapses back to exactly
  // what they chose once zoomed back in.
  const effectiveCollapsedContainerIds = useMemo(
    () =>
      effectiveCollapsedContainers(
        containers.map((container) => container.id),
        collapsedContainerIds,
        zoomLevel === "workstream",
      ),
    [containers, collapsedContainerIds, zoomLevel],
  );

  const parentOf: ParentOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of nodeInputs) {
      if (node.containerId) map.set(node.id, node.containerId);
    }
    return map;
  }, [nodeInputs]);

  // Derived initial arrangement (spec §5, Epic 3.1's remaining leftover): a
  // node with no *stored* placement still lands somewhere sensible, derived
  // from the graph's own structure, rather than whatever literal
  // `defaultPosition` its host happened to hand-write. A stored placement
  // always wins (arranging by hand never costs an earlier placement); this
  // is strictly the fallback for a node nobody has ever moved.
  const derivedPlacements = useMemo(
    () =>
      deriveInitialArrangement(
        nodeInputs.map((input) => ({
          id: input.id,
          ...(input.containerId ? { containerId: input.containerId } : {}),
        })),
        edgeInputs.map((input) => ({
          source: input.source,
          target: input.target,
        })),
        containers.map((container) => ({ id: container.id })),
      ),
    [nodeInputs, edgeInputs, containers],
  );
  const effectivePlacements: Placements = useMemo(
    () => ({ ...derivedPlacements, ...placements }),
    [derivedPlacements, placements],
  );

  const buildNodes = useCallback((): CanvasNode[] => {
    const containerNodes: ContainerNode[] = containers.map((container) => ({
      id: container.id,
      type: "container" as const,
      ariaLabel: `workstream: ${container.label}`,
      position: effectivePlacements[container.id] ?? container.defaultPosition,
      style: { width: CONTAINER_WIDTH, height: CONTAINER_HEIGHT },
      data: {
        label: container.label,
        collapsed: effectiveCollapsedContainerIds.has(container.id),
        onToggle: () => onToggleContainer?.(container.id),
      },
    }));

    const boxNodes: BoxNode[] = nodeInputs.map((input) =>
      toBoxNode(input, {
        zoomLevel,
        selectedNodeId,
        placements: effectivePlacements,
        collapsedContainerIds: effectiveCollapsedContainerIds,
        ...(onDropDefinitionOnTicket ? { onDropDefinitionOnTicket } : {}),
        ...(warningsByNodeId ? { warningsByNodeId } : {}),
        ...(attentionByNodeId ? { attentionByNodeId } : {}),
        ...(onRunCommand ? { onRunCommand } : {}),
        ...(runningCommandNodeIds ? { runningCommandNodeIds } : {}),
        ...(onCardAction ? { onCardAction } : {}),
      }),
    );

    // Parents must precede children in xyflow's node array.
    return [...containerNodes, ...boxNodes];
  }, [
    containers,
    nodeInputs,
    effectivePlacements,
    effectiveCollapsedContainerIds,
    onToggleContainer,
    onDropDefinitionOnTicket,
    warningsByNodeId,
    attentionByNodeId,
    onRunCommand,
    runningCommandNodeIds,
    onCardAction,
    zoomLevel,
    selectedNodeId,
  ]);

  const initialNodes = useMemo(buildNodes, [buildNodes]);

  const initialEdges = useMemo<Edge[]>(
    () =>
      edgeInputs.map((input) => ({
        id: input.id,
        source: input.source,
        target: input.target,
      })),
    [edgeInputs],
  );

  const [nodes, setNodes, onNodesChange] =
    useNodesState<CanvasNode>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const { getNodes, screenToFlowPosition } = useReactFlow<CanvasNode>();

  // "Reset arrangement" (Batch 2 Stage 1 review finding B1 — distinct from
  // the tombstone "B1" below, an earlier Batch 1 finding): a plain ref,
  // updated every render, so the one-shot effect below always reads the
  // *latest* `effectivePlacements`
  // without depending on it — depending on it would fire the reset on every
  // placements change, exactly the react-to-placements-changed effect this
  // must not be. `arrangementEpoch`'s own change is the only thing allowed
  // to trigger a reset.
  const latestPlacementsRef = useRef(effectivePlacements);
  latestPlacementsRef.current = effectivePlacements;

  // The last `arrangementEpoch` this canvas has already applied, so the
  // effect below only fires on a genuine bump — never on mount (the ref's
  // initial value matches the first render's prop) and never twice for the
  // same bump (StrictMode's double-invoke included, since the ref is
  // updated synchronously inside the effect body, before anything async).
  const appliedArrangementEpoch = useRef(arrangementEpoch);
  useEffect(() => {
    if (arrangementEpoch === appliedArrangementEpoch.current) return;
    appliedArrangementEpoch.current = arrangementEpoch;
    setNodes((current) =>
      applyArrangementReset(current, latestPlacementsRef.current),
    );
  }, [arrangementEpoch, setNodes]);

  // Tombstones (principle 10, B1 fix): a Backspace/Delete gesture only
  // mutates this internal xyflow state — the host is never told, so the
  // deleted id stays in `nodeInputs`/`edgeInputs` forever. Without this,
  // the additive sync effect below would find that id "missing" on the
  // very next unrelated render (a zoom change, a click) and resurrect it;
  // worse, if the delete were still on the undo stack, Cmd/Ctrl+Z would
  // append it a *second* time, producing a duplicate id. Refs, not state:
  // tombstones must be current inside the same synchronous handler that
  // both records the undo op and re-runs the sync effect on the next
  // render, and they are never rendered themselves.
  const tombstonedNodeIds = useRef<Set<string>>(new Set());
  const tombstonedEdgeIds = useRef<Set<string>>(new Set());

  // Live deletion reconciliation (Phase 3 polish, the Batch 1 finding): a
  // node/edge deleted by *another* client must disappear from an already-
  // open canvas too, not just fail to be resurrected. `confirmed*Ids` tracks
  // every id this canvas has ever seen named by the host's own arrays, so
  // the sync effects below can tell "the host deleted this" (confirmed, now
  // missing) apart from "this is only a local, not-yet-confirmed gesture"
  // (never confirmed at all) — see reconcile.ts.
  const confirmedNodeIds = useRef<Set<string>>(new Set());
  const confirmedEdgeIds = useRef<Set<string>>(new Set());

  // `nodes`/`edges` seed the canvas once; drag positions and undo live only
  // in this internal state afterward. A one-gesture flow (creating a
  // workstream by drop, for example) still needs its result to show up on
  // the running canvas, so new ids in `nodeInputs`/`containers`/`edgeInputs`
  // are appended here — additively only, never touching an id already
  // present, so an in-progress arrangement is never disturbed. Deleted ids
  // are excluded via the tombstone set above so a deletion is never undone
  // by this effect re-running for an unrelated reason.
  useEffect(() => {
    setNodes((current) => {
      const incomingIds = [
        ...containers.map((container) => container.id),
        ...nodeInputs.map((input) => input.id),
      ];
      confirmedNodeIds.current = withConfirmed(
        confirmedNodeIds.current,
        incomingIds,
      );
      const removeIds = new Set(
        remotelyDeletedIds(
          current.map((node) => node.id),
          incomingIds,
          confirmedNodeIds.current,
        ),
      );

      const present = new Set(current.map((node) => node.id));
      const newContainers: ContainerNode[] = withoutTombstoned(
        containers.filter((container) => !present.has(container.id)),
        tombstonedNodeIds.current,
      ).map((container) => ({
        id: container.id,
        type: "container" as const,
        ariaLabel: `workstream: ${container.label}`,
        position:
          effectivePlacements[container.id] ?? container.defaultPosition,
        style: { width: CONTAINER_WIDTH, height: CONTAINER_HEIGHT },
        data: {
          label: container.label,
          collapsed: effectiveCollapsedContainerIds.has(container.id),
          onToggle: () => onToggleContainer?.(container.id),
        },
      }));
      const newBoxNodes: BoxNode[] = withoutTombstoned(
        nodeInputs.filter((input) => !present.has(input.id)),
        tombstonedNodeIds.current,
      ).map((input) =>
        toBoxNode(input, {
          zoomLevel,
          selectedNodeId,
          placements: effectivePlacements,
          collapsedContainerIds: effectiveCollapsedContainerIds,
          ...(onDropDefinitionOnTicket ? { onDropDefinitionOnTicket } : {}),
          ...(warningsByNodeId ? { warningsByNodeId } : {}),
          ...(attentionByNodeId ? { attentionByNodeId } : {}),
          ...(onRunCommand ? { onRunCommand } : {}),
          ...(runningCommandNodeIds ? { runningCommandNodeIds } : {}),
          ...(onCardAction ? { onCardAction } : {}),
        }),
      );
      if (
        removeIds.size === 0 &&
        newContainers.length === 0 &&
        newBoxNodes.length === 0
      ) {
        return current;
      }
      // Parents must precede children in xyflow's node array.
      const survivors = current.filter((node) => !removeIds.has(node.id));
      return [...survivors, ...newContainers, ...newBoxNodes];
    });
  }, [
    containers,
    nodeInputs,
    effectivePlacements,
    effectiveCollapsedContainerIds,
    onToggleContainer,
    onDropDefinitionOnTicket,
    warningsByNodeId,
    attentionByNodeId,
    onRunCommand,
    runningCommandNodeIds,
    onCardAction,
    zoomLevel,
    selectedNodeId,
    setNodes,
  ]);

  // Warnings (§5) can change for an *already-placed* node (a new edge made
  // a command's context legal, a run bound a placeholder) — unlike the
  // additive effect above, this updates every existing node in place.
  useEffect(() => {
    setNodes((current) =>
      current.map((node) => {
        if (node.type !== "box") return node;
        const warnings = warningsByNodeId?.get(node.id) ?? [];
        const attention = attentionByNodeId?.get(node.id) ?? null;
        const warningsChanged =
          node.data.warnings.length !== warnings.length ||
          !node.data.warnings.every((w, i) => w === warnings[i]);
        const attentionChanged =
          node.data.attention?.count !== attention?.count ||
          node.data.attention?.topFeed !== attention?.topFeed;
        if (!warningsChanged && !attentionChanged) return node;
        return { ...node, data: { ...node.data, warnings, attention } };
      }),
    );
  }, [warningsByNodeId, attentionByNodeId, setNodes]);

  // A node's label/running/run-in-flight/card-view state can change after it
  // is already placed — a command node's latest run status arriving well
  // after the drop that created it, a session's derived phase moving on
  // (§3.6), a run gesture's guard flipping while the request is outstanding
  // (§4.1), a plugin card view resolving after the initial placement since
  // resolving one is async (§10.1) — unlike the additive effect above (which
  // only ever seeds these once, on first add), this keeps every
  // already-placed node's label/running/run-in-flight/cardView in sync with
  // its current `CanvasNodeInput`/guard state.
  useEffect(() => {
    const byId = new Map(nodeInputs.map((input) => [input.id, input]));
    setNodes((current) =>
      current.map((node) => {
        if (node.type !== "box") return node;
        const input = byId.get(node.id);
        if (!input) return node;
        const running = input.running ?? false;
        const runInFlight = runningCommandNodeIds?.has(node.id) ?? false;
        const cardView = input.cardView ?? null;
        if (
          node.data.label === input.label &&
          node.data.running === running &&
          node.data.runInFlight === runInFlight &&
          node.data.cardView === cardView
        ) {
          return node;
        }
        return {
          ...node,
          data: {
            ...node.data,
            label: input.label,
            running,
            runInFlight,
            cardView,
          },
        };
      }),
    );
  }, [nodeInputs, runningCommandNodeIds, setNodes]);

  useEffect(() => {
    setEdges((current) => {
      const incomingIds = edgeInputs.map((input) => input.id);
      confirmedEdgeIds.current = withConfirmed(
        confirmedEdgeIds.current,
        incomingIds,
      );
      const removeIds = new Set(
        remotelyDeletedIds(
          current.map((edge) => edge.id),
          incomingIds,
          confirmedEdgeIds.current,
        ),
      );

      const present = new Set(current.map((edge) => edge.id));
      const additions = withoutTombstoned(
        edgeInputs.filter((input) => !present.has(input.id)),
        tombstonedEdgeIds.current,
      ).map((input) => ({
        id: input.id,
        source: input.source,
        target: input.target,
      }));
      if (removeIds.size === 0 && additions.length === 0) return current;
      const survivors = current.filter((edge) => !removeIds.has(edge.id));
      return [...survivors, ...additions];
    });
  }, [edgeInputs, setEdges]);

  // Collapsing containers (§3.3, §5): hide inner nodes and remap their
  // zoom-level data/hidden flag, and edges crossing into a collapsed
  // container draw to its frame rather than to a hidden node. Driven by
  // `effectiveCollapsedContainerIds` — the manual toggle OR the workstream
  // zoom level forcing every container to one card (§5).
  useEffect(() => {
    setNodes((current) =>
      current.map((node) => {
        if (node.type !== "box") {
          if (node.type === "container") {
            const collapsed = effectiveCollapsedContainerIds.has(node.id);
            if (node.data.collapsed === collapsed) return node;
            return { ...node, data: { ...node.data, collapsed } };
          }
          return node;
        }
        const parent = parentOf.get(node.id);
        const hidden =
          parent !== undefined && effectiveCollapsedContainerIds.has(parent);
        if (node.hidden === hidden && node.data.zoomLevel === zoomLevel)
          return node;
        return { ...node, hidden, data: { ...node.data, zoomLevel } };
      }),
    );
  }, [effectiveCollapsedContainerIds, parentOf, zoomLevel, setNodes]);

  // Node visibility inside a collapsed container is carried on `hidden`
  // (set in buildNodes/the collapse effect above); edges are remapped to
  // the container's frame here so they never point at a hidden node.
  const visibleEdges = useMemo(
    () =>
      remapEdgesForCollapse(edges, effectiveCollapsedContainerIds, parentOf),
    [edges, effectiveCollapsedContainerIds, parentOf],
  );

  // Selection is the route (§5): the address decides which node renders as
  // route-selected. This is deliberately separate from xyflow's own
  // `node.selected`, which the multi-select mechanics below own — a marquee
  // or shift-click multi-selection must not overwrite which node the URL
  // points at, and navigating must not clear a multi-selection mid-batch.
  useEffect(() => {
    setNodes((current) =>
      current.map((node) => {
        if (node.type !== "box") return node;
        const routeSelected = node.id === selectedNodeId;
        if (node.data.routeSelected === routeSelected) return node;
        return { ...node, data: { ...node.data, routeSelected } };
      }),
    );
  }, [selectedNodeId, setNodes]);

  const graphNodes = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const input of nodeInputs) {
      map.set(input.id, toGraphNode(input));
    }
    return map;
  }, [nodeInputs]);

  // Mid-drag refusal (spec §5): the same core predicate the API and agent
  // tools call decides legality while the connection is being dragged.
  const isValidConnection: IsValidConnection = useCallback(
    (connection) => {
      const from = graphNodes.get(connection.source ?? "");
      const to = graphNodes.get(connection.target ?? "");
      if (!from || !to) return false;
      return checkConnection(from, to).legal;
    },
    [graphNodes],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const from = graphNodes.get(connection.source);
      const to = graphNodes.get(connection.target);
      if (!from || !to || !checkConnection(from, to).legal) return;
      setEdges((current) => addEdge(connection, current));
      onWireContext?.(connection.source, connection.target);
    },
    [graphNodes, setEdges, onWireContext],
  );

  // Drag-to-empty-canvas create menu (§5): filtered to what the dragged
  // edge's source could legally connect to, via the same core predicate.
  const [createMenu, setCreateMenu] = useState<{
    sourceId: string;
    position: Point;
    options: CreateMenuOption[];
  } | null>(null);

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      if (connectionState.isValid || connectionState.toNode) return;
      const sourceId = connectionState.fromNode?.id;
      if (!sourceId) return;
      const source = graphNodes.get(sourceId);
      if (!source) return;

      const clientPoint =
        "changedTouches" in event
          ? event.changedTouches[0]
          : (event as MouseEvent);
      if (!clientPoint) return;

      setCreateMenu({
        sourceId,
        position: { x: clientPoint.clientX, y: clientPoint.clientY },
        options: legalCreateMenuOptions(source, createMenuOptions),
      });
    },
    [graphNodes, createMenuOptions],
  );

  // Rigid-body push: on every drag frame, displace exactly the nodes the
  // chain reaches; the dragged node itself stays under the cursor. Push
  // operates at the top level (containers and un-contained box nodes) —
  // pushing a node inside an expanded container against its siblings is a
  // follow-on refinement (containers are new in this epic; xyflow already
  // clamps a child's position to its parent's extent).
  const onNodeDrag: OnNodeDrag<CanvasNode> = useCallback(
    (_event, dragged) => {
      if (dragged.parentId) return;
      setNodes((current) => {
        const topLevel = current.filter((node) => !node.parentId);
        const extents: NodeExtent[] = topLevel.map((node) => ({
          id: node.id,
          x: node.id === dragged.id ? dragged.position.x : node.position.x,
          y: node.id === dragged.id ? dragged.position.y : node.position.y,
          width:
            node.measured?.width ??
            (node.type === "container" ? CONTAINER_WIDTH : FALLBACK_WIDTH),
          height:
            node.measured?.height ??
            (node.type === "container" ? CONTAINER_HEIGHT : FALLBACK_HEIGHT),
        }));
        const displaced = solvePush(extents, dragged.id);
        if (displaced.size === 0) return current;
        return current.map((node) => {
          const moved = displaced.get(node.id);
          return moved ? { ...node, position: moved } : node;
        });
      });
    },
    [setNodes],
  );

  // Durable placement: the settled arrangement — dragged node and everything
  // it pushed — is persisted when the drag ends.
  const onNodeDragStop: OnNodeDrag<CanvasNode> = useCallback(() => {
    const settled: Record<string, Point> = {};
    for (const node of getNodes()) {
      settled[node.id] = { x: node.position.x, y: node.position.y };
    }
    onPlacementsChange(settled);
  }, [getNodes, onPlacementsChange]);

  // Multi-select (§5): xyflow's own marquee/modified-click drives node
  // selection; this only tracks which ids and roles are selected for the
  // contextual action bar.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const onSelectionChange = useCallback<OnSelectionChangeFunc>(
    ({ nodes: selected }) => {
      setSelectedIds(selected.map((n) => n.id));
    },
    [],
  );

  const selectedRoles = useMemo(
    () =>
      selectedIds
        .map((id) => graphNodes.get(id)?.role)
        .filter((role): role is NodeRole => role !== undefined),
    [selectedIds, graphNodes],
  );
  const batchActions = useMemo(
    () => actionsForSelection(selectedRoles),
    [selectedRoles],
  );

  // Off-screen attention markers (§5, §7): clustered against the current
  // viewport in flow coordinates; a node withdraws the instant it scrolls
  // into view because it simply stops appearing in the cluster result.
  const viewport = useViewport();
  const containerRef = useRef<HTMLDivElement>(null);
  const attentionMarkers = useMemo(() => {
    const box = containerRef.current?.getBoundingClientRect();
    const width = box?.width ?? 0;
    const height = box?.height ?? 0;
    if (width === 0 || height === 0) return [];
    const viewportRect = {
      x: -viewport.x / viewport.zoom,
      y: -viewport.y / viewport.zoom,
      width: width / viewport.zoom,
      height: height / viewport.zoom,
    };
    const attending = attentionNodeIds
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is CanvasNode => n !== undefined)
      .map((n) => ({ id: n.id, x: n.position.x, y: n.position.y }));
    return clusterOffScreenAttention(attending, viewportRect);
  }, [attentionNodeIds, nodes, viewport]);

  // Speech bubbles (§5): focus is selection or hover — documented here as
  // the one place that decision is made, so "unfocused" collapses to a
  // count everywhere consistently. Hover is tracked only for this; it never
  // feeds route selection.
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const focusedNodeIds = useMemo(() => {
    const ids = new Set<string>();
    if (selectedNodeId) ids.add(selectedNodeId);
    if (hoveredNodeId) ids.add(hoveredNodeId);
    return ids;
  }, [selectedNodeId, hoveredNodeId]);

  // The canvas container's own size, kept live via ResizeObserver rather
  // than read once off `getBoundingClientRect()` inside a memo keyed on
  // `viewport` — a window resize with the viewport otherwise unchanged
  // (no pan, no zoom) never re-ran that memo, so the reserved region below
  // went stale exactly when the container actually changed size.
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Reserved regions (§5, "never obscure the minimap or controls"): the
  // unstyled `<MiniMap>` renders bottom-right at xyflow's own default
  // footprint (200x150, 15px panel margin) — revisit alongside `<Controls>`
  // once the design package lands and either gets its own chrome.
  const bubbleReservedRegions = useMemo<ReservedRegion[]>(() => {
    const { width, height } = containerSize;
    if (width === 0 || height === 0) return [];
    return [
      {
        id: "minimap",
        x: width - MINIMAP_MARGIN - MINIMAP_WIDTH,
        y: height - MINIMAP_MARGIN - MINIMAP_HEIGHT,
        width: MINIMAP_WIDTH,
        height: MINIMAP_HEIGHT,
      },
    ];
  }, [containerSize]);

  // Screen-space extents for every *visible* node currently on screen
  // (reserved regions above are screen-anchored, so bubbles must place in
  // the same space) — contained (workstream-child) nodes included, resolved
  // to their absolute position by `computeAbsoluteScreenExtents`.
  // `toExtentAwareNodes` (`node-extents.ts`) is handed the *entire* `nodes`
  // array, container nodes included, deliberately: `computeAbsoluteScreenExtents`
  // looks up a contained node's parent by id inside the very array it is
  // given, so filtering to box nodes here (as this once did) silently
  // dropped every container from that lookup — the parent id still
  // resolved, found nothing, and every contained node's "absolute" position
  // fell back to its bare parent-relative one. Containers carry no bubble
  // sources, so they produce no placements of their own; passing them
  // through costs nothing.
  const bubbleNodeExtents = useMemo<NodeExtent[]>(
    () =>
      computeAbsoluteScreenExtents(
        toExtentAwareNodes(nodes, {
          containerType: "container",
          boxSize: { width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT },
          containerSize: { width: CONTAINER_WIDTH, height: CONTAINER_HEIGHT },
        }),
        viewport,
      ),
    [nodes, viewport],
  );

  const bubblePlacements = useMemo(
    () =>
      computeBubblePlacements(
        bubbleNodeExtents,
        bubbleSources,
        focusedNodeIds,
        bubbleReservedRegions,
        { globalCap: bubbleCap ?? DEFAULT_GLOBAL_BUBBLE_CAP },
      ),
    [
      bubbleNodeExtents,
      bubbleSources,
      focusedNodeIds,
      bubbleReservedRegions,
      bubbleCap,
    ],
  );

  // Undo for destructive canvas operations (§5, principle 10): delete
  // node/edge (a workstream container is deleted the same way; a marquee
  // delete of many nodes is "clear region"). xyflow fires one combined
  // `onDelete` per gesture — deleting a wired node includes its connected
  // edges — so this pushes exactly one undo op per gesture (N3): a single
  // Cmd/Ctrl+Z restores the node together with its edges, never leaving an
  // intermediate state where an edge points at a still-missing node.
  const undoStack = useRef(createUndoStack<null>(50));

  const onDelete = useCallback<OnDelete<CanvasNode, Edge>>(
    ({ nodes: deletedNodes, edges: deletedEdges }) => {
      if (deletedNodes.length === 0 && deletedEdges.length === 0) return;

      const nodeIds = deletedNodes.map((node) => node.id);
      const edgeIds = deletedEdges.map((edge) => edge.id);
      // B1: tombstone immediately so the additive sync effects above never
      // resurrect these ids on the next unrelated render (a zoom change, a
      // click) while this delete is still on the undo stack.
      tombstonedNodeIds.current = addTombstones(
        tombstonedNodeIds.current,
        nodeIds,
      );
      tombstonedEdgeIds.current = addTombstones(
        tombstonedEdgeIds.current,
        edgeIds,
      );

      undoStack.current.do(null, {
        label: `delete ${deletedNodes.length} node(s), ${deletedEdges.length} edge(s)`,
        apply: (s) => s,
        invert: (s) => {
          // The node/edges are coming back, so the tombstone must lift for
          // exactly these ids — otherwise a legitimate future re-add of the
          // same id would be silently blocked forever.
          tombstonedNodeIds.current = clearTombstones(
            tombstonedNodeIds.current,
            nodeIds,
          );
          tombstonedEdgeIds.current = clearTombstones(
            tombstonedEdgeIds.current,
            edgeIds,
          );
          setNodes((current) => [...current, ...deletedNodes]);
          setEdges((current) => [...current, ...deletedEdges]);
          return s;
        },
      });
    },
    [setNodes, setEdges],
  );

  /**
   * Keyboard wiring (§11's "every interactive surface is keyboard-reachable",
   * Epic 8.1): the drag gesture's equivalent, in two presses. `W` on a
   * focused node marks it as the source; `W` on another node completes the
   * wire. It is the **same** act as the drag, not a parallel one — the same
   * `checkConnection` predicate refuses it (§3.7, principle 8), the same
   * `onWireContext` authors it, and the same local edge is drawn — so a
   * keyboard user cannot create something a mouse user could not, or vice
   * versa. A refusal is announced with the predicate's own reason rather
   * than silently doing nothing, which is the keyboard's version of "an
   * illegal connection never looks legal".
   */
  const [pendingWireSourceId, setPendingWireSourceId] = useState<string | null>(
    null,
  );
  const [keyboardAnnouncement, setKeyboardAnnouncement] = useState<
    string | null
  >(null);

  const wireByKeyboard = useCallback(
    (targetId: string) => {
      const sourceId = pendingWireSourceId;
      if (sourceId === null) {
        setPendingWireSourceId(targetId);
        setKeyboardAnnouncement(
          `wiring from ${targetId}: press W on the node to wire it into`,
        );
        return;
      }
      setPendingWireSourceId(null);
      if (sourceId === targetId) {
        setKeyboardAnnouncement("wiring cancelled: same node");
        return;
      }
      const from = graphNodes.get(sourceId);
      const to = graphNodes.get(targetId);
      if (!from || !to) {
        setKeyboardAnnouncement("wiring cancelled: node is no longer here");
        return;
      }
      const check = checkConnection(from, to);
      if (!check.legal) {
        // The predicate's own reason, never a rephrasing of it (principle 8).
        setKeyboardAnnouncement(`refused: ${check.refusal.message}`);
        return;
      }
      setEdges((current) =>
        addEdge(
          {
            source: sourceId,
            target: targetId,
            sourceHandle: null,
            targetHandle: null,
          },
          current,
        ),
      );
      onWireContext?.(sourceId, targetId);
      setKeyboardAnnouncement(`wired ${sourceId} into ${targetId}`);
    },
    [graphNodes, onWireContext, pendingWireSourceId, setEdges],
  );

  /**
   * The canvas's bindings, registered rather than listened for (Epic 8.1):
   * undo, route selection on the focused node, keyboard wiring — plus the
   * keys xyflow itself implements, declared as `documented` so "every binding
   * appears in the shortcuts overlay" (§11) stays true for them too, without
   * pretending this file handles them.
   */
  const canvasBindings = useMemo<readonly KeyBinding[]>(
    () => [
      {
        kind: "dispatched",
        id: "canvas-undo",
        chords: [{ key: "z", mod: true }],
        label: "undo the last destructive canvas gesture",
        description:
          "restores what a delete removed, including when an agent deleted it (principle 10)",
        scope: "global",
        run: () => undoStack.current.undo(null),
      },
      {
        kind: "dispatched",
        id: "canvas-select-focused-node",
        chords: [{ key: "Enter" }],
        label: "select the focused node",
        description:
          "makes the focused node the selected one — selection is the route (§5)",
        scope: "canvas",
        // xyflow's own Enter toggles its multi-selection; this sets the
        // route, exactly as a mouse click does both.
        preventDefault: false,
        run: () => {
          const nodeId = focusedCanvasNodeId(
            document.activeElement as HTMLElement | null,
          );
          if (nodeId) onSelectNode(nodeId);
        },
      },
      {
        kind: "dispatched",
        id: "canvas-wire-context",
        chords: [{ key: "w" }],
        label: "wire context between two nodes",
        description:
          "press once on the source node and again on the target; refused by the same predicate a drag is",
        scope: "canvas",
        run: () => {
          const nodeId = focusedCanvasNodeId(
            document.activeElement as HTMLElement | null,
          );
          if (nodeId) wireByKeyboard(nodeId);
        },
      },
      {
        kind: "dispatched",
        id: "canvas-cancel-wire",
        chords: [{ key: "Escape" }],
        label: "cancel a keyboard wiring in progress",
        description: "forgets the marked source node, wiring nothing",
        scope: "canvas",
        preventDefault: false,
        run: () => {
          setPendingWireSourceId(null);
          setKeyboardAnnouncement(null);
        },
      },
      {
        kind: "documented",
        id: "canvas-delete-selection",
        chords: [{ key: "Backspace" }, { key: "Delete" }],
        label: "delete the selected nodes and edges",
        description: "undoable with the undo binding above (principle 10)",
        scope: "canvas",
        implementedBy: "xyflow",
      },
      {
        kind: "documented",
        id: "canvas-nudge-selection",
        chords: [
          { key: "ArrowUp" },
          { key: "ArrowDown" },
          { key: "ArrowLeft" },
          { key: "ArrowRight" },
        ],
        keysLabel: "↑ ↓ ← →",
        label: "move the selected node",
        description:
          "nudges the selected node; Shift moves further. Pushes what it touches, like a drag",
        scope: "canvas",
        implementedBy: "xyflow",
      },
    ],
    [onSelectNode, wireByKeyboard],
  );
  useKeyBindings(canvasBindings);

  // Palette drop onto empty canvas (§5): a palette row is a plain HTML5
  // drag source (`PaletteRail`), so the drop target only needs the standard
  // DOM handlers — no xyflow-specific wiring beyond translating the drop
  // point into flow coordinates.
  const onCanvasDragOver = useCallback((event: React.DragEvent) => {
    if (event.dataTransfer.types.includes(PALETTE_ENTRY_DRAG_TYPE)) {
      event.preventDefault();
    }
  }, []);

  const onCanvasDrop = useCallback(
    (event: React.DragEvent) => {
      const entryId = event.dataTransfer.getData(PALETTE_ENTRY_DRAG_TYPE);
      if (!entryId) return;
      event.preventDefault();
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      onDropPaletteEntry?.(entryId, position);
    },
    [onDropPaletteEntry, screenToFlowPosition],
  );

  return (
    <div
      ref={containerRef}
      // The canvas's own key scope (§11, Epic 8.1): the bindings above are
      // live exactly while focus is inside the canvas — a node, the pane —
      // and never while a panel or a dialog has it.
      data-key-scope="canvas"
      style={{ width: "100%", height: "100%", position: "relative" }}
      onDragOver={onCanvasDragOver}
      onDrop={onCanvasDrop}
    >
      <ReactFlow
        nodes={nodes}
        edges={visibleEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={(_event, node) => onSelectNode(node.id)}
        onPaneClick={() => onSelectNode(null)}
        onSelectionChange={onSelectionChange}
        onDelete={onDelete}
        onNodeMouseEnter={(_event, node) => setHoveredNodeId(node.id)}
        onNodeMouseLeave={() =>
          setHoveredNodeId((current) => (current ? null : current))
        }
        selectionOnDrag
        multiSelectionKeyCode="Shift"
        fitView
      >
        <MiniMap />
      </ReactFlow>
      <CanvasLegend nodes={nodeInputs} />
      {/* A stable hook for e2e tests to wait on a deterministic zoom level
          before depending on container-collapse behavior (`fitView`'s
          computed zoom is otherwise not something a test can predict). */}
      <div data-testid="zoom-level" style={{ display: "none" }}>
        {zoomLevel}
      </div>
      <ActionBar
        selectedIds={selectedIds}
        actions={batchActions}
        onAction={(action) => onBatchAction?.(action, selectedIds)}
      />
      <AttentionMarkers markers={attentionMarkers} />
      {/* Keyboard gestures answer where a screen reader can hear them (§11):
          a wiring in progress, and a refusal carrying the predicate's own
          reason — the keyboard's equivalent of "an illegal connection never
          looks legal" (§5). */}
      <LiveRegion
        message={keyboardAnnouncement}
        label="canvas keyboard gestures"
        testId="canvas-announcement"
      />
      <BubbleLayer
        placements={bubblePlacements}
        onAnswerQuestion={onAnswerQuestion}
      />
      {createMenu ? (
        <CreateMenu
          position={createMenu.position}
          options={createMenu.options}
          onPick={(option) => {
            onCreateFromDrag?.(
              createMenu.sourceId,
              option,
              createMenu.position,
            );
            setCreateMenu(null);
          }}
          onDismiss={() => setCreateMenu(null)}
        />
      ) : null}
    </div>
  );
}

export function PlotCanvas(props: PlotCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
