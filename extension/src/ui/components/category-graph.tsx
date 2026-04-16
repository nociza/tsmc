import { useMemo } from "react";

import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  MarkerType,
  BaseEdge,
  getBezierPath
} from "@xyflow/react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from "d3-force";

import { categoryPalette, providerColors, providerLabels } from "../../shared/explorer";
import type { BackendCategoryGraph, ProviderName, SessionCategoryName } from "../../shared/types";
import { cn } from "../lib/utils";

type GraphNodeData = {
  label: string;
  kind: string;
  accent: string;
  sessionIds: string[];
  provider?: ProviderName | null;
  muted: boolean;
};

type GraphEdgeData = {
  label?: string | null;
  sessionIds: string[];
  muted: boolean;
};

type SimNode = SimulationNodeDatum & {
  id: string;
  label: string;
  kind: string;
  sessionIds: string[];
  provider?: ProviderName | null;
  accent: string;
  radius: number;
};

type SimEdge = SimulationLinkDatum<SimNode> & {
  id: string;
  source: string | SimNode;
  target: string | SimNode;
  label?: string | null;
  sessionIds: string[];
  weight: number;
  muted: boolean;
};

function GraphNodeCard({ data, selected }: NodeProps<Node<GraphNodeData>>) {
  return (
    <div
      className={cn(
        "w-[184px] rounded-[8px] border bg-white px-3 py-2 text-left shadow-sm transition",
        data.muted ? "border-zinc-200/70 opacity-45" : "border-zinc-200",
        selected ? "ring-2 ring-emerald-500/30" : ""
      )}
      style={{
        borderColor: selected ? `${data.accent}55` : undefined
      }}
    >
      <div className="mb-1 flex items-center gap-2">
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{
            backgroundColor: data.accent
          }}
        />
        <span className="truncate text-sm font-semibold text-zinc-900">{data.label}</span>
      </div>
      <div className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.08em] text-zinc-500">
        <span>{data.provider ? providerLabels[data.provider] : data.kind}</span>
        <span>{data.sessionIds.length} notes</span>
      </div>
    </div>
  );
}

function GraphEdgePath({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  data,
  selected
}: EdgeProps<Edge<GraphEdgeData>>) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY
  });

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      style={{
        stroke: selected ? "#059669" : "#94a3b8",
        strokeOpacity: data?.muted ? 0.18 : selected ? 0.85 : 0.42,
        strokeWidth: selected ? 2.4 : 1.5
      }}
    />
  );
}

const nodeTypes = {
  entity: GraphNodeCard
};

const edgeTypes = {
  relationship: GraphEdgePath
};

function buildFlow(
  graph: BackendCategoryGraph,
  category: SessionCategoryName,
  focusSessionIds?: string[]
): {
  nodes: Array<Node<GraphNodeData>>;
  edges: Array<Edge<GraphEdgeData>>;
} {
  const activeSessions = focusSessionIds?.length ? new Set(focusSessionIds) : null;
  const fallbackAccent = categoryPalette[category].accent;

  const simNodes: SimNode[] = graph.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    kind: node.kind,
    sessionIds: node.session_ids,
    provider: node.provider,
    accent: node.provider ? providerColors[node.provider] : fallbackAccent,
    radius: 40 + Math.sqrt(Math.max(node.size, 1)) * 8,
    x: 0,
    y: 0
  }));

  const simEdges: SimEdge[] = graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    sessionIds: edge.session_ids,
    weight: edge.weight,
    muted: Boolean(activeSessions && !edge.session_ids.some((sessionId) => activeSessions.has(sessionId)))
  }));

  const simulation = forceSimulation(simNodes)
    .force(
      "link",
      forceLink<SimNode, SimEdge>(simEdges)
        .id((node: SimNode) => node.id)
        .distance((edge: SimEdge) => 160 - Math.min(edge.weight, 10) * 6)
        .strength((edge: SimEdge) => 0.18 + Math.min(edge.weight, 8) * 0.025)
    )
    .force("charge", forceManyBody().strength(-460))
    .force("collision", forceCollide<SimNode>().radius((node: SimNode) => node.radius))
    .force("center", forceCenter(0, 0))
    .stop();

  for (let index = 0; index < 220; index += 1) {
    simulation.tick();
  }

  const xs = simNodes.map((node) => node.x ?? 0);
  const ys = simNodes.map((node) => node.y ?? 0);
  const minX = Math.min(...xs, 0);
  const maxX = Math.max(...xs, 0);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys, 0);
  const spreadX = maxX - minX || 1;
  const spreadY = maxY - minY || 1;
  const width = 1200;
  const height = 760;
  const padding = 120;
  const scale = Math.min((width - padding * 2) / spreadX, (height - padding * 2) / spreadY, 1.8);

  const nodes: Array<Node<GraphNodeData>> = simNodes.map((node) => ({
    id: node.id,
    type: "entity",
    data: {
      label: node.label,
      kind: node.kind,
      accent: node.accent,
      sessionIds: node.sessionIds,
      provider: node.provider,
      muted: Boolean(activeSessions && !node.sessionIds.some((sessionId: string) => activeSessions.has(sessionId)))
    },
    position: {
      x: ((node.x ?? 0) - minX) * scale + padding,
      y: ((node.y ?? 0) - minY) * scale + padding
    }
  }));

  const edges: Array<Edge<GraphEdgeData>> = simEdges.map((edge) => ({
    id: edge.id,
    source: typeof edge.source === "string" ? edge.source : edge.source.id,
    target: typeof edge.target === "string" ? edge.target : edge.target.id,
    type: "relationship",
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 14,
      height: 14,
      color: "#94a3b8"
    },
    data: {
      label: edge.label,
      sessionIds: edge.sessionIds,
      muted: edge.muted
    }
  }));

  return { nodes, edges };
}

export function CategoryGraph({
  graph,
  category,
  focusSessionIds,
  onFocus,
  className
}: {
  graph: BackendCategoryGraph;
  category: SessionCategoryName;
  focusSessionIds?: string[];
  onFocus: (label: string, sessionIds: string[]) => void;
  className?: string;
}) {
  const { nodes, edges } = useMemo(() => buildFlow(graph, category, focusSessionIds), [category, focusSessionIds, graph]);

  if (!graph.nodes.length) {
    return (
      <div
        className={cn(
          "flex h-[560px] items-center justify-center rounded-[8px] border border-dashed border-zinc-200 bg-zinc-50 text-sm text-zinc-500",
          className
        )}
      >
        No graph data is available for this view yet.
      </div>
    );
  }

  return (
    <div className={cn("h-[560px] overflow-hidden rounded-[8px] border border-zinc-200 bg-zinc-50", className)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.5}
        maxZoom={1.5}
        onNodeClick={(_, node) => {
          onFocus(node.data.label, node.data.sessionIds);
        }}
        onEdgeClick={(_, edge) => {
          onFocus(edge.data?.label ?? "Relationship", edge.data?.sessionIds ?? []);
        }}
      >
        <Background gap={24} size={1} color="#d4d4d8" />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
