import { useEffect, useMemo, useRef, useState } from "react";

import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import noverlap from "graphology-layout-noverlap";
import Sigma from "sigma";

import { providerLabels } from "../../shared/explorer";
import type { BackendCategoryGraph, BackendExplorerGraphEdge, BackendExplorerGraphNode, ProviderName, SessionCategoryName } from "../../shared/types";
import {
  buildCategoryGraphClusters,
  clusterAccentForNode,
  type CategoryGraphCluster,
  type GraphGroupingMode
} from "../lib/category-graph-insights";
import { cn } from "../lib/utils";

export type CategoryGraphDensity = "curated" | "complete";
export type CategoryGraphFocusMode = "context" | "dim";

export type CategoryGraphSelection =
  | {
      kind: "node";
      id: string;
      label: string;
      sessionIds: string[];
    }
  | {
      kind: "edge";
      id: string;
      label: string;
      sessionIds: string[];
    };

type SigmaNodeAttributes = {
  label: string;
  x: number;
  y: number;
  size: number;
  color: string;
  baseColor: string;
  kind: string;
  variant: "entity" | "cluster";
  sessionIds: string[];
  provider?: ProviderName | null;
  noteCount: number;
  degree: number;
  communityId?: string | null;
  communityLabel?: string | null;
  muted: boolean;
  hiddenCount?: number;
};

type SigmaEdgeAttributes = {
  label: string;
  size: number;
  color: string;
  weight: number;
  sessionIds: string[];
  muted: boolean;
};

type MutableCluster = {
  id: string;
  label: string;
  accent: string;
  provider?: ProviderName | null;
  nodes: BackendExplorerGraphNode[];
  sessionIds: Set<string>;
  edgeCount: number;
};

type GraphBuildResult = {
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>;
  summary: {
    visibleNodes: number;
    totalNodes: number;
    hiddenNodes: number;
    visibleEdges: number;
    totalEdges: number;
    clusterCount: number;
    contextOnly: boolean;
  };
};

function hasActiveSession(sessionIds: string[], activeSessions: Set<string> | null): boolean {
  return Boolean(activeSessions && sessionIds.some((sessionId) => activeSessions.has(sessionId)));
}

function nodeScore(node: BackendExplorerGraphNode, degree: number, activeSessions: Set<string> | null): number {
  const focusBoost = hasActiveSession(node.session_ids, activeSessions) ? 1000 : 0;
  return focusBoost + degree * 8 + node.session_ids.length * 6 + Math.log(node.size + 1) * 8 + (node.centrality ?? 0) * 12;
}

function fallbackClusterFor(
  node: BackendExplorerGraphNode,
  category: SessionCategoryName,
  groupingMode: GraphGroupingMode
): CategoryGraphCluster {
  return {
    id: `fallback:${node.id}`,
    label: node.label,
    accent: clusterAccentForNode(node, category, groupingMode),
    mode: groupingMode,
    provider: groupingMode === "provider" ? node.provider ?? null : null,
    nodeIds: [node.id],
    nodeCount: 1,
    edgeCount: 0,
    sessionIds: node.session_ids,
    noteCount: node.session_ids.length
  };
}

function readableGroupDetail(groupingMode: GraphGroupingMode): string {
  if (groupingMode === "community") {
    return "Topic community";
  }
  if (groupingMode === "provider") {
    return "Provider group";
  }
  return "Node type group";
}

function addSafeEdge(
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  key: string,
  source: string,
  target: string,
  attributes: SigmaEdgeAttributes
): void {
  if (!graph.hasNode(source) || !graph.hasNode(target) || source === target) {
    return;
  }
  if (graph.hasEdge(key)) {
    const current = graph.getEdgeAttributes(key);
    graph.mergeEdgeAttributes(key, {
      label: current.label || attributes.label,
      size: Math.max(current.size, attributes.size),
      weight: current.weight + attributes.weight,
      sessionIds: Array.from(new Set([...current.sessionIds, ...attributes.sessionIds])),
      muted: current.muted && attributes.muted
    });
    return;
  }
  graph.addDirectedEdgeWithKey(key, source, target, attributes);
}

function buildSigmaGraph(
  backendGraph: BackendCategoryGraph,
  category: SessionCategoryName,
  groupingMode: GraphGroupingMode,
  collapsedGroups: string[],
  density: CategoryGraphDensity,
  focusMode: CategoryGraphFocusMode,
  focusSessionIds?: string[]
): GraphBuildResult {
  const activeSessions = focusSessionIds?.length ? new Set(focusSessionIds) : null;
  const contextOnly = Boolean(activeSessions && focusMode === "context");
  const collapsedSet = new Set(collapsedGroups);
  const clusterLookup = buildCategoryGraphClusters(backendGraph, category, groupingMode);
  const nodeById = new Map(backendGraph.nodes.map((node) => [node.id, node] as const));
  const degreeByNodeId = new Map<string, number>(backendGraph.nodes.map((node) => [node.id, node.degree ?? 0]));

  for (const edge of backendGraph.edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target) || edge.source === edge.target) {
      continue;
    }
    degreeByNodeId.set(edge.source, Math.max(degreeByNodeId.get(edge.source) ?? 0, 1));
    degreeByNodeId.set(edge.target, Math.max(degreeByNodeId.get(edge.target) ?? 0, 1));
  }

  const scopedEdges = contextOnly
    ? backendGraph.edges.filter((edge) => hasActiveSession(edge.session_ids, activeSessions))
    : backendGraph.edges;
  const scopedNodeIds = new Set<string>();

  for (const node of backendGraph.nodes) {
    if (!contextOnly || hasActiveSession(node.session_ids, activeSessions)) {
      scopedNodeIds.add(node.id);
    }
  }
  for (const edge of scopedEdges) {
    scopedNodeIds.add(edge.source);
    scopedNodeIds.add(edge.target);
  }

  const clusterMap = new Map<string, MutableCluster>();
  for (const node of backendGraph.nodes) {
    if (!scopedNodeIds.has(node.id)) {
      continue;
    }
    const cluster = clusterLookup.byNodeId.get(node.id) ?? fallbackClusterFor(node, category, groupingMode);
    const entry =
      clusterMap.get(cluster.id) ??
      (() => {
        const created: MutableCluster = {
          id: cluster.id,
          label: cluster.label,
          accent: cluster.accent,
          provider: cluster.provider,
          nodes: [],
          sessionIds: new Set<string>(),
          edgeCount: cluster.edgeCount
        };
        clusterMap.set(cluster.id, created);
        return created;
      })();

    entry.nodes.push(node);
    for (const sessionId of node.session_ids) {
      entry.sessionIds.add(sessionId);
    }
  }

  const clusters = Array.from(clusterMap.values()).sort(
    (left, right) => right.sessionIds.size - left.sessionIds.size || right.edgeCount - left.edgeCount || left.label.localeCompare(right.label)
  );

  const graph = new Graph<SigmaNodeAttributes, SigmaEdgeAttributes>({ type: "directed", multi: true });
  const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(clusters.length || 1))));
  const clusterCenterById = new Map<string, { x: number; y: number }>();
  const visibleEntityIds = new Set<string>();

  // Space clusters far enough apart that their inner rings don't collide.
  const clusterSpacingX = 60;
  const clusterSpacingY = 52;
  clusters.forEach((cluster, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    // Stagger every other row horizontally so the lattice is not axis-aligned.
    const staggerOffset = row % 2 === 0 ? 0 : clusterSpacingX / 2;
    clusterCenterById.set(cluster.id, {
      x: column * clusterSpacingX + staggerOffset,
      y: row * clusterSpacingY
    });
  });

  for (const cluster of clusters) {
    const center = clusterCenterById.get(cluster.id) ?? { x: 0, y: 0 };
    const clusterSessionIds = Array.from(cluster.sessionIds);
    const clusterMuted = Boolean(activeSessions && !hasActiveSession(clusterSessionIds, activeSessions));
    const sortedClusterNodes = [...cluster.nodes].sort((left, right) => {
      const leftDegree = degreeByNodeId.get(left.id) ?? 0;
      const rightDegree = degreeByNodeId.get(right.id) ?? 0;
      return nodeScore(right, rightDegree, activeSessions) - nodeScore(left, leftDegree, activeSessions) || left.label.localeCompare(right.label);
    });
    const visibleLimit = density === "curated" ? (contextOnly ? 18 : 10) : sortedClusterNodes.length;
    const visibleClusterNodes = sortedClusterNodes.slice(0, visibleLimit);
    const hiddenCount = Math.max(sortedClusterNodes.length - visibleClusterNodes.length, 0);

    if (collapsedSet.has(cluster.id)) {
      graph.addNode(cluster.id, {
        label: cluster.label,
        x: center.x,
        y: center.y,
        size: 11 + Math.sqrt(cluster.nodes.length) * 1.6,
        color: cluster.accent,
        baseColor: cluster.accent,
        kind: groupingMode,
        variant: "cluster",
        sessionIds: clusterSessionIds,
        provider: cluster.provider,
        noteCount: clusterSessionIds.length,
        degree: cluster.edgeCount,
        communityId: cluster.id,
        communityLabel: cluster.label,
        muted: clusterMuted,
        hiddenCount
      });
      continue;
    }

    // Ring radius grows with cluster size so large clusters don't squeeze into
    // a single tight orbit. The small golden-angle rotation makes each ring's
    // start angle differ from its neighbors, which breaks the visible grid.
    const baseRing = 6 + Math.sqrt(visibleClusterNodes.length) * 1.6;
    const ringGoldenOffset = (Math.PI * (Math.sqrt(5) - 1)) * (clusterCenterById.get(cluster.id)?.x ?? 0);
    visibleClusterNodes.forEach((node, index) => {
      const angle = ringGoldenOffset + (Math.PI * 2 * index) / Math.max(visibleClusterNodes.length, 1);
      const ring = baseRing + Math.floor(index / 10) * 3.2;
      const degree = degreeByNodeId.get(node.id) ?? 0;
      const muted = Boolean(activeSessions && !hasActiveSession(node.session_ids, activeSessions));
      visibleEntityIds.add(node.id);
      graph.addNode(node.id, {
        label: node.label,
        x: center.x + Math.cos(angle) * ring,
        y: center.y + Math.sin(angle) * ring,
        size: 4.8 + Math.sqrt(Math.max(node.size, 1)) * 1.3 + Math.min(degree, 10) * 0.18,
        color: cluster.accent,
        baseColor: cluster.accent,
        kind: node.kind,
        variant: "entity",
        sessionIds: node.session_ids,
        provider: node.provider,
        noteCount: node.session_ids.length,
        degree,
        communityId: node.community_id ?? cluster.id,
        communityLabel: node.community_label ?? cluster.label,
        muted
      });
    });
  }

  const visibleNodeIdFor = (nodeId: string): string | null => {
    const node = nodeById.get(nodeId);
    if (!node || !scopedNodeIds.has(nodeId)) {
      return null;
    }
    const cluster = clusterLookup.byNodeId.get(node.id) ?? fallbackClusterFor(node, category, groupingMode);
    if (collapsedSet.has(cluster.id)) {
      return cluster.id;
    }
    return visibleEntityIds.has(node.id) ? node.id : null;
  };

  const visibleEdges = new Map<
    string,
    {
      source: string;
      target: string;
      sessionIds: Set<string>;
      labels: Set<string>;
      weight: number;
      muted: boolean;
    }
  >();

  for (const edge of scopedEdges) {
    const visibleSource = visibleNodeIdFor(edge.source);
    const visibleTarget = visibleNodeIdFor(edge.target);
    if (!visibleSource || !visibleTarget || visibleSource === visibleTarget) {
      continue;
    }
    const key = `${visibleSource}:${visibleTarget}`;
    const aggregate =
      visibleEdges.get(key) ??
      (() => {
        const created = {
          source: visibleSource,
          target: visibleTarget,
          sessionIds: new Set<string>(),
          labels: new Set<string>(),
          weight: 0,
          muted: true
        };
        visibleEdges.set(key, created);
        return created;
      })();

    aggregate.weight += edge.weight;
    aggregate.muted = aggregate.muted && Boolean(activeSessions && !hasActiveSession(edge.session_ids, activeSessions));
    for (const sessionId of edge.session_ids) {
      aggregate.sessionIds.add(sessionId);
    }
    if (edge.label?.trim()) {
      aggregate.labels.add(edge.label.trim());
    }
  }

  for (const [id, edge] of visibleEdges.entries()) {
    addSafeEdge(graph, id, edge.source, edge.target, {
      label: Array.from(edge.labels).slice(0, 3).join(", "),
      size: 0.7 + Math.min(Math.log(edge.weight + 1), 2.6),
      color: "#9ca3af",
      weight: edge.weight,
      sessionIds: Array.from(edge.sessionIds),
      muted: edge.muted
    });
  }

  if (graph.order > 1) {
    try {
      forceAtlas2.assign(graph, {
        iterations: graph.order > 80 ? 100 : 160,
        settings: {
          ...forceAtlas2.inferSettings(graph),
          gravity: 0.5,
          // Stronger repulsion so clusters stay visually distinct.
          scalingRatio: groupingMode === "community" ? 14 : 10,
          edgeWeightInfluence: 0.35,
          barnesHutOptimize: graph.order > 80,
          // Linear mode gives more breathing room between high-degree nodes.
          linLogMode: false,
          outboundAttractionDistribution: true
        },
        getEdgeWeight: "weight"
      });
      // Two noverlap passes: first with a bigger margin to force separation,
      // then with tight margin to tidy up without overshooting.
      noverlap.assign(graph, {
        maxIterations: 120,
        settings: {
          margin: 6,
          ratio: 1.35,
          expansion: 1.2,
          gridSize: 24,
          speed: 3
        }
      });
      noverlap.assign(graph, {
        maxIterations: 60,
        settings: {
          margin: 3.5,
          ratio: 1.15,
          expansion: 1.04
        }
      });
    } catch {
      // Keep deterministic seeded positions if layout cannot run for an unusual graph.
    }
  }

  return {
    graph,
    summary: {
      visibleNodes: visibleEntityIds.size || graph.order,
      totalNodes: scopedNodeIds.size,
      hiddenNodes: Math.max(scopedNodeIds.size - (visibleEntityIds.size || graph.order), 0),
      visibleEdges: graph.size,
      totalEdges: scopedEdges.length,
      clusterCount: clusters.length,
      contextOnly
    }
  };
}

function selectedNeighborSet(graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>, selectedNode: string | null, hoveredNode: string | null): Set<string> | null {
  const activeNode = hoveredNode ?? selectedNode;
  if (!activeNode || !graph.hasNode(activeNode)) {
    return null;
  }
  const neighbors = new Set<string>([activeNode]);
  for (const neighbor of graph.neighbors(activeNode)) {
    neighbors.add(String(neighbor));
  }
  return neighbors;
}

export function CategoryGraph({
  graph,
  category,
  groupingMode,
  collapsedGroups,
  density,
  focusMode,
  focusSessionIds,
  onFocus,
  onInspect,
  className
}: {
  graph: BackendCategoryGraph;
  category: SessionCategoryName;
  groupingMode: GraphGroupingMode;
  collapsedGroups: string[];
  density: CategoryGraphDensity;
  focusMode: CategoryGraphFocusMode;
  focusSessionIds?: string[];
  onFocus: (label: string, sessionIds: string[]) => void;
  onInspect?: (selection: CategoryGraphSelection | null) => void;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<Sigma<SigmaNodeAttributes, SigmaEdgeAttributes> | null>(null);
  const selectedNodeRef = useRef<string | null>(null);
  const hoveredNodeRef = useRef<string | null>(null);
  const onFocusRef = useRef(onFocus);
  const onInspectRef = useRef(onInspect);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  const build = useMemo(
    () => buildSigmaGraph(graph, category, groupingMode, collapsedGroups, density, focusMode, focusSessionIds),
    [category, collapsedGroups, density, focusMode, focusSessionIds, graph, groupingMode]
  );

  useEffect(() => {
    selectedNodeRef.current = selectedNode;
    hoveredNodeRef.current = hoveredNode;
    rendererRef.current?.refresh({ schedule: true });
  }, [hoveredNode, selectedNode]);

  useEffect(() => {
    onFocusRef.current = onFocus;
    onInspectRef.current = onInspect;
  }, [onFocus, onInspect]);

  useEffect(() => {
    selectedNodeRef.current = null;
    hoveredNodeRef.current = null;
    setSelectedNode(null);
    setHoveredNode(null);
  }, [build.graph]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !build.graph.order) {
      return;
    }

    const renderer = new Sigma<SigmaNodeAttributes, SigmaEdgeAttributes>(build.graph, container, {
      allowInvalidContainer: true,
      autoCenter: true,
      autoRescale: true,
      enableEdgeEvents: true,
      hideEdgesOnMove: true,
      hideLabelsOnMove: true,
      // Keep labels sparse so they don't overlap each other. Sigma uses a grid
      // occlusion strategy — larger cells + a higher rendered-size threshold
      // means a label is only drawn when its node is big and isolated enough.
      labelDensity: 0.06,
      labelGridCellSize: 160,
      labelRenderedSizeThreshold: density === "curated" ? 10 : 13,
      renderEdgeLabels: false,
      zIndex: true,
      nodeReducer: (node, data) => {
        const neighbors = selectedNeighborSet(build.graph, selectedNodeRef.current, hoveredNodeRef.current);
        const isActive = node === selectedNodeRef.current || node === hoveredNodeRef.current;
        const inNeighborhood = !neighbors || neighbors.has(node);
        // When nothing is focused, only cluster-labels and the tallest nodes
        // carry a label so we don't get a wall of overlapping text.
        const labelAllowed =
          isActive ||
          inNeighborhood ||
          data.variant === "cluster" ||
          data.degree >= 5 ||
          data.noteCount >= 6;
        return {
          ...data,
          color: data.muted || !inNeighborhood ? "#c7cbd1" : data.baseColor,
          label: labelAllowed ? data.label : "",
          size: isActive ? data.size * 1.45 : data.size,
          zIndex: isActive ? 2 : data.variant === "cluster" ? 1 : 0
        };
      },
      edgeReducer: (edge, data) => {
        const neighbors = selectedNeighborSet(build.graph, selectedNodeRef.current, hoveredNodeRef.current);
        const extremities = build.graph.extremities(edge);
        const inNeighborhood = !neighbors || (neighbors.has(String(extremities[0])) && neighbors.has(String(extremities[1])));
        return {
          ...data,
          // Faded, near-white default keeps idle edges from crosshatching the
          // visible labels. Focused neighborhoods get a darker tone for contrast.
          color: data.muted || !inNeighborhood ? "#e4e6ea" : "#6b7380",
          size: inNeighborhood ? data.size : Math.max(data.size * 0.35, 0.3),
          zIndex: inNeighborhood ? 1 : 0
        };
      }
    });

    renderer.on("enterNode", ({ node }) => {
      hoveredNodeRef.current = node;
      setHoveredNode(node);
    });
    renderer.on("leaveNode", () => {
      hoveredNodeRef.current = null;
      setHoveredNode(null);
    });
    renderer.on("clickNode", ({ node }) => {
      const attributes = build.graph.getNodeAttributes(node);
      selectedNodeRef.current = node;
      setSelectedNode(node);
      onFocusRef.current(attributes.label, attributes.sessionIds);
      onInspectRef.current?.({ kind: "node", id: node, label: attributes.label, sessionIds: attributes.sessionIds });
      renderer.refresh({ schedule: true });
    });
    renderer.on("clickEdge", ({ edge }) => {
      const attributes = build.graph.getEdgeAttributes(edge);
      onFocusRef.current(attributes.label || "Relationship", attributes.sessionIds);
      onInspectRef.current?.({ kind: "edge", id: edge, label: attributes.label || "Relationship", sessionIds: attributes.sessionIds });
    });
    renderer.on("clickStage", () => {
      selectedNodeRef.current = null;
      setSelectedNode(null);
      onInspectRef.current?.(null);
      renderer.refresh({ schedule: true });
    });

    rendererRef.current = renderer;
    return () => {
      renderer.kill();
      if (rendererRef.current === renderer) {
        rendererRef.current = null;
      }
    };
  }, [build.graph, density]);

  if (!graph.nodes.length) {
    return (
      <div
        className={cn(
          "flex min-h-[420px] h-[min(62vh,700px)] items-center justify-center rounded-[8px] border border-dashed border-[var(--color-line)] bg-[var(--color-paper-raised)] text-sm text-[var(--color-ink-soft)]",
          className
        )}
      >
        No graph data is available for this view yet.
      </div>
    );
  }

  return (
    <div className={cn("relative min-h-[420px] h-[min(62vh,700px)] overflow-hidden rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)]", className)}>
      <div className="absolute left-3 top-3 z-10 rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)] shadow-sm">
        {build.summary.clusterCount} groups · {build.summary.visibleNodes}/{build.summary.totalNodes} nodes · {build.summary.visibleEdges}/{build.summary.totalEdges} links
        {build.summary.hiddenNodes ? ` · ${build.summary.hiddenNodes} hidden` : ""}
        {build.summary.contextOnly ? " · context" : ""}
      </div>
      <div className="absolute right-3 top-3 z-10 max-w-[260px] rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 py-2 text-xs leading-5 text-[var(--color-ink-soft)] shadow-sm">
        {selectedNode && build.graph.hasNode(selectedNode)
          ? `${build.graph.getNodeAttribute(selectedNode, "label")} · ${build.graph.getNodeAttribute(selectedNode, "noteCount")} notes · ${build.graph.getNodeAttribute(selectedNode, "degree")} links`
          : hoveredNode && build.graph.hasNode(hoveredNode)
            ? `${build.graph.getNodeAttribute(hoveredNode, "label")} · ${build.graph.getNodeAttribute(hoveredNode, "noteCount")} notes`
            : `${readableGroupDetail(groupingMode)} map. Click a node or link for evidence.`}
      </div>
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
