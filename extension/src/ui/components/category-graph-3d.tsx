import { useEffect, useMemo, useRef, useState } from "react";

import ForceGraph3D, { type ForceGraph3DInstance } from "3d-force-graph";

import type {
  BackendCategoryGraph,
  BackendExplorerGraphEdge,
  BackendExplorerGraphNode,
  SessionCategoryName
} from "../../shared/types";
import {
  buildCategoryGraphClusters,
  clusterAccentForNode,
  type CategoryGraphCluster,
  type GraphGroupingMode
} from "../lib/category-graph-insights";
import { cn } from "../lib/utils";
import type { CategoryGraphSelection } from "./category-graph";

type Graph3DNode = {
  id: string;
  label: string;
  color: string;
  noteCount: number;
  degree: number;
  sessionIds: string[];
  communityId: string;
  communityLabel: string;
  val: number;
  // three-forcegraph hydrates these during the simulation.
  x?: number;
  y?: number;
  z?: number;
};

type Graph3DLink = {
  id: string;
  source: string | Graph3DNode;
  target: string | Graph3DNode;
  label: string;
  weight: number;
  sessionIds: string[];
};

type TypedForceGraph = ForceGraph3DInstance<Graph3DNode, Graph3DLink>;

function hasActiveSession(sessionIds: string[], activeSessions: Set<string> | null): boolean {
  return Boolean(activeSessions && sessionIds.some((sessionId) => activeSessions.has(sessionId)));
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

function buildGraphData(
  backendGraph: BackendCategoryGraph,
  category: SessionCategoryName,
  groupingMode: GraphGroupingMode,
  focusSessionIds?: string[]
): { nodes: Graph3DNode[]; links: Graph3DLink[] } {
  const activeSessions = focusSessionIds?.length ? new Set(focusSessionIds) : null;
  const clusterLookup = buildCategoryGraphClusters(backendGraph, category, groupingMode);

  const degreeByNodeId = new Map<string, number>(
    backendGraph.nodes.map((node) => [node.id, node.degree ?? 0])
  );
  for (const edge of backendGraph.edges) {
    degreeByNodeId.set(edge.source, (degreeByNodeId.get(edge.source) ?? 0) + 1);
    degreeByNodeId.set(edge.target, (degreeByNodeId.get(edge.target) ?? 0) + 1);
  }

  const nodes: Graph3DNode[] = backendGraph.nodes.map((node) => {
    const cluster = clusterLookup.byNodeId.get(node.id) ?? fallbackClusterFor(node, category, groupingMode);
    const degree = degreeByNodeId.get(node.id) ?? 0;
    const muted = Boolean(activeSessions && !hasActiveSession(node.session_ids, activeSessions));
    return {
      id: node.id,
      label: node.label,
      color: muted ? "#c7cbd1" : cluster.accent,
      noteCount: node.session_ids.length,
      degree,
      sessionIds: node.session_ids,
      communityId: cluster.id,
      communityLabel: cluster.label,
      // `val` drives 3d-force-graph node radius.
      val: 1 + Math.sqrt(Math.max(node.size, 1)) * 0.8 + Math.min(degree, 10) * 0.12
    };
  });

  const links: Graph3DLink[] = [];
  const validNodeIds = new Set(nodes.map((node) => node.id));
  const seen = new Set<string>();
  for (const edge of backendGraph.edges as BackendExplorerGraphEdge[]) {
    if (!validNodeIds.has(edge.source) || !validNodeIds.has(edge.target) || edge.source === edge.target) {
      continue;
    }
    const key = `${edge.source}>${edge.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label ?? "",
      weight: edge.weight,
      sessionIds: edge.session_ids
    });
  }

  return { nodes, links };
}

export function CategoryGraph3D({
  graph,
  category,
  groupingMode,
  focusSessionIds,
  onFocus,
  onInspect,
  className
}: {
  graph: BackendCategoryGraph;
  category: SessionCategoryName;
  groupingMode: GraphGroupingMode;
  focusSessionIds?: string[];
  onFocus: (label: string, sessionIds: string[]) => void;
  onInspect?: (selection: CategoryGraphSelection | null) => void;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<TypedForceGraph | null>(null);
  const onFocusRef = useRef(onFocus);
  const onInspectRef = useRef(onInspect);
  const [hovered, setHovered] = useState<Graph3DNode | null>(null);
  const [selected, setSelected] = useState<Graph3DNode | null>(null);

  const data = useMemo(
    () => buildGraphData(graph, category, groupingMode, focusSessionIds),
    [category, focusSessionIds, graph, groupingMode]
  );

  const clusterCount = useMemo(() => {
    const seen = new Set<string>();
    for (const node of data.nodes) seen.add(node.communityId);
    return seen.size;
  }, [data.nodes]);

  useEffect(() => {
    onFocusRef.current = onFocus;
    onInspectRef.current = onInspect;
  }, [onFocus, onInspect]);

  // Mount a single ForceGraph3D instance on the container; tear down on unmount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // The default export is a non-generic constructor; cast to the typed
    // instance once so downstream calls are type-checked against our node/link.
    const instance = new ForceGraph3D(container) as unknown as TypedForceGraph;
    graphRef.current = instance;

    instance
      .backgroundColor("#0b1120")
      .showNavInfo(false)
      .enableNodeDrag(true)
      .nodeRelSize(4)
      .nodeVal((node) => node.val)
      .nodeColor((node) => node.color)
      .nodeOpacity(0.92)
      .nodeLabel((node) => {
        const badge = `${node.label} · ${node.noteCount} note${node.noteCount === 1 ? "" : "s"} · ${node.degree} link${node.degree === 1 ? "" : "s"}`;
        const cluster = node.communityLabel ? `<div style="opacity:0.8">${escapeHtml(node.communityLabel)}</div>` : "";
        return `<div style="background:rgba(15,23,42,0.92);color:#f8fafc;padding:6px 10px;border-radius:6px;font-size:11px;line-height:1.35;box-shadow:0 4px 12px rgba(0,0,0,0.4)">${escapeHtml(badge)}${cluster}</div>`;
      })
      .linkColor(() => "rgba(203,213,225,0.45)")
      .linkOpacity(0.35)
      .linkWidth((link) => 0.5 + Math.min(Math.log(link.weight + 1), 2.4) * 0.4)
      .linkCurvature(0.1)
      .linkDirectionalArrowLength(2.4)
      .linkDirectionalArrowRelPos(0.92)
      .linkDirectionalArrowColor(() => "#cbd5e1")
      .linkDirectionalParticles((link) => (link.weight > 1 ? 1 : 0))
      .linkDirectionalParticleSpeed(0.004)
      .linkDirectionalParticleWidth(1.4)
      .onNodeHover((node) => setHovered(node ?? null))
      .onNodeClick((node) => {
        setSelected(node);
        onFocusRef.current(node.label, node.sessionIds);
        onInspectRef.current?.({ kind: "node", id: node.id, label: node.label, sessionIds: node.sessionIds });
        // Center camera on the clicked node; pull in by 1.6x for a closer look.
        const distance = 80;
        const distanceRatio = 1 + distance / Math.hypot(node.x ?? 1, node.y ?? 1, node.z ?? 1);
        instance.cameraPosition(
          { x: (node.x ?? 0) * distanceRatio, y: (node.y ?? 0) * distanceRatio, z: (node.z ?? 0) * distanceRatio },
          { x: node.x ?? 0, y: node.y ?? 0, z: node.z ?? 0 },
          700
        );
      })
      .onBackgroundClick(() => {
        setSelected(null);
        onInspectRef.current?.(null);
      });

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width > 0 && height > 0) {
        instance.width(width).height(height);
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    return () => {
      observer.disconnect();
      try {
        instance._destructor?.();
      } catch {
        // ignore
      }
      graphRef.current = null;
    };
  }, []);

  // Feed data whenever inputs change.
  useEffect(() => {
    const instance = graphRef.current;
    if (!instance) return;
    instance.graphData({ nodes: data.nodes, links: data.links });
    // Stronger repulsion and longer edges so clusters spread in 3D space.
    const chargeForce = instance.d3Force("charge") as { strength?: (value: number) => unknown } | null;
    chargeForce?.strength?.(-120);
    const linkForce = instance.d3Force("link") as { distance?: (value: number) => unknown } | null;
    linkForce?.distance?.(55);
    instance.d3ReheatSimulation();
    const frameId = window.setTimeout(() => instance.zoomToFit(700, 60), 450);
    return () => window.clearTimeout(frameId);
  }, [data]);

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
    <div
      className={cn(
        "relative min-h-[420px] h-[min(62vh,700px)] overflow-hidden rounded-[8px] border border-[var(--color-line)] bg-[#0b1120]",
        className
      )}
    >
      <div ref={containerRef} className="h-full w-full" />
      <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-[8px] border border-white/10 bg-slate-950/80 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-200 shadow-sm">
        3D map · {clusterCount} clusters · {data.nodes.length} nodes · {data.links.length} links
      </div>
      <div className="pointer-events-none absolute right-3 top-3 z-10 max-w-[280px] rounded-[8px] border border-white/10 bg-slate-950/80 px-3 py-2 text-xs leading-5 text-slate-200 shadow-sm">
        {selected
          ? `${selected.label} · ${selected.noteCount} notes · ${selected.degree} links`
          : hovered
            ? `${hovered.label} · ${hovered.noteCount} notes · ${hovered.communityLabel}`
            : "Drag to rotate · scroll to zoom · click a node to inspect"}
      </div>
    </div>
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
