/**
 * The canvas (spec §5), mechanics only — no visual design until the design
 * package lands (fleet rule 5). xyflow is the base; rigid-body push, durable
 * placement, and mid-drag connection refusal are built on top of it. Nodes
 * are DOM-based so plugin card renderers and keyboard access work later.
 */

import { useCallback, useEffect, useMemo } from "react";
import type {
  Connection,
  Edge,
  IsValidConnection,
  Node,
  NodeProps,
  NodeTypes,
  OnNodeDrag,
} from "@xyflow/react";
import {
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
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

export interface CanvasNodeInput {
  readonly id: string;
  readonly label: string;
  readonly role: NodeRole;
  /** Sessions only: whether the session is still running (accepts context). */
  readonly running?: boolean;
  /** Position used when no durable placement exists for this node yet. */
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
  /** Durable placements, loaded by the host through a PlacementStore. */
  readonly placements: Placements;
  /** Called with every node's position whenever an arrangement settles. */
  readonly onPlacementsChange: (placements: Placements) => void;
  readonly selectedNodeId: string | null;
  /** The one navigation primitive; null clears the selection. */
  readonly onSelectNode: (nodeId: string | null) => void;
}

type BoxNodeData = {
  label: string;
  role: NodeRole;
  running: boolean;
};

type BoxNode = Node<BoxNodeData, "box">;

/** Fallbacks for the first frame, before xyflow has measured the DOM. */
const FALLBACK_WIDTH = 140;
const FALLBACK_HEIGHT = 40;

function BoxNodeView({ data, selected }: NodeProps<BoxNode>) {
  // Unstyled by design (fleet rule 5): a visible rectangle with a label is
  // the bare minimum for the mechanics to be exercised.
  return (
    <div
      style={{
        border: selected ? "2px solid black" : "1px solid black",
        background: "white",
        padding: "6px 10px",
      }}
    >
      <Handle type="target" position={Position.Left} />
      {data.label}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes: NodeTypes = { box: BoxNodeView };

function toGraphNode(input: CanvasNodeInput): GraphNode {
  return {
    // Fixture ids become branded NodeIds here, at the single boundary where
    // the canvas hands nodes to the core legality predicate.
    id: input.id as NodeId,
    role: input.role,
    ...(input.running !== undefined ? { running: input.running } : {}),
  };
}

function CanvasInner({
  nodes: nodeInputs,
  edges: edgeInputs,
  placements,
  onPlacementsChange,
  selectedNodeId,
  onSelectNode,
}: PlotCanvasProps) {
  const initialNodes = useMemo<BoxNode[]>(
    () =>
      nodeInputs.map((input) => ({
        id: input.id,
        type: "box" as const,
        position: placements[input.id] ?? input.defaultPosition,
        data: {
          label: input.label,
          role: input.role,
          running: input.running ?? false,
        },
      })),
    // Placements seed the initial arrangement only; later changes flow
    // through drag, not through re-seeding — hence not a dependency.
    [nodeInputs],
  );

  const initialEdges = useMemo<Edge[]>(
    () =>
      edgeInputs.map((input) => ({
        id: input.id,
        source: input.source,
        target: input.target,
      })),
    [edgeInputs],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const { getNodes } = useReactFlow<BoxNode>();

  // Selection is the route: the address decides which node renders selected.
  useEffect(() => {
    setNodes((current) =>
      current.map((node) =>
        node.selected === (node.id === selectedNodeId)
          ? node
          : { ...node, selected: node.id === selectedNodeId },
      ),
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
    },
    [graphNodes, setEdges],
  );

  // Rigid-body push: on every drag frame, displace exactly the nodes the
  // chain reaches; the dragged node itself stays under the cursor.
  const onNodeDrag: OnNodeDrag<BoxNode> = useCallback(
    (_event, dragged) => {
      setNodes((current) => {
        const extents: NodeExtent[] = current.map((node) => ({
          id: node.id,
          x: node.id === dragged.id ? dragged.position.x : node.position.x,
          y: node.id === dragged.id ? dragged.position.y : node.position.y,
          width: node.measured?.width ?? FALLBACK_WIDTH,
          height: node.measured?.height ?? FALLBACK_HEIGHT,
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
  const onNodeDragStop: OnNodeDrag<BoxNode> = useCallback(() => {
    const settled: Record<string, Point> = {};
    for (const node of getNodes()) {
      settled[node.id] = { x: node.position.x, y: node.position.y };
    }
    onPlacementsChange(settled);
  }, [getNodes, onPlacementsChange]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onNodeDrag={onNodeDrag}
      onNodeDragStop={onNodeDragStop}
      onNodeClick={(_event, node) => onSelectNode(node.id)}
      onPaneClick={() => onSelectNode(null)}
      fitView
    />
  );
}

export function PlotCanvas(props: PlotCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
