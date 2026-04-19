import { useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";

import { cn } from "../lib/utils";

export type IdeaFlowData = {
  core_idea?: string;
  summary?: string;
  thread_hint?: string | null;
  reasoning_steps?: string[];
  related_facts?: string[];
  supports?: string[];
  conflicts_with?: string[];
  next_steps?: string[];
  share_post?: string;
};

export type IdeaFlowOrigin = {
  title?: string | null;
  provider?: string | null;
  occurredAt?: string | null;
  participants?: string[];
};

type IdeaNodeKind =
  | "origin"
  | "core"
  | "reasoning"
  | "support"
  | "conflict"
  | "fact"
  | "nextStep"
  | "share";

type IdeaNodeData = {
  kind: IdeaNodeKind;
  title: string;
  subtitle?: string;
  bullets?: string[];
  index?: number;
};

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item): item is string => item.length > 0);
}

function cardClass(kind: IdeaNodeKind): string {
  switch (kind) {
    case "origin":
      return "border-[var(--color-line-strong)] bg-[var(--color-paper-sunken)] text-[var(--color-ink)]";
    case "core":
      return "border-[#4f46e5] bg-[#eef2ff] text-[#312e81] font-semibold";
    case "reasoning":
      return "border-[var(--color-line-strong)] bg-white text-[var(--color-ink)]";
    case "support":
      return "border-[#16a34a] bg-[#f0fdf4] text-[#14532d]";
    case "conflict":
      return "border-[#dc2626] bg-[#fef2f2] text-[#7f1d1d]";
    case "fact":
      return "border-[#2563eb] bg-[#eff6ff] text-[#1e3a8a]";
    case "nextStep":
      return "border-[#d97706] bg-[#fffbeb] text-[#7c2d12]";
    case "share":
      return "border-[var(--color-line)] bg-[var(--color-paper-raised)] text-[var(--color-ink-soft)] italic";
  }
}

function kindLabel(kind: IdeaNodeKind): string {
  switch (kind) {
    case "origin":
      return "Origin";
    case "core":
      return "Core idea";
    case "reasoning":
      return "Reasoning";
    case "support":
      return "Support";
    case "conflict":
      return "Conflict";
    case "fact":
      return "Fact anchor";
    case "nextStep":
      return "Next step";
    case "share":
      return "Share";
  }
}

function IdeaNode({ data }: NodeProps<Node<IdeaNodeData, IdeaNodeKind>>) {
  const { kind, title, subtitle, bullets, index } = data;
  return (
    <div
      className={cn(
        "relative rounded-[10px] border px-3 py-2 text-xs leading-5 shadow-sm",
        "max-w-[240px] min-w-[180px]",
        cardClass(kind)
      )}
    >
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-none !bg-current opacity-50" />
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-[0.08em] opacity-70">
        <span>{kindLabel(kind)}</span>
        {typeof index === "number" ? <span>#{index}</span> : null}
      </div>
      <div className="whitespace-pre-wrap break-words">{title}</div>
      {subtitle ? (
        <div className="mt-1 text-[10px] leading-4 opacity-75">{subtitle}</div>
      ) : null}
      {bullets && bullets.length ? (
        <ul className="mt-1 list-disc pl-4 text-[10px] leading-4 opacity-85">
          {bullets.map((line, idx) => (
            <li key={idx}>{line}</li>
          ))}
        </ul>
      ) : null}
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-none !bg-current opacity-50" />
    </div>
  );
}

const NODE_TYPES = { idea: IdeaNode } as const;

type LayoutColumn = {
  x: number;
  align: "center" | "left" | "right";
};

const COLUMN_SUPPORT: LayoutColumn = { x: -340, align: "right" };
const COLUMN_CENTER: LayoutColumn = { x: 0, align: "center" };
const COLUMN_CONFLICT: LayoutColumn = { x: 340, align: "left" };

function buildGraph(idea: IdeaFlowData, origin?: IdeaFlowOrigin): { nodes: Node<IdeaNodeData>[]; edges: Edge[] } {
  const nodes: Node<IdeaNodeData>[] = [];
  const edges: Edge[] = [];
  const rowHeight = 120;
  let centerRow = 0;

  const push = (id: string, data: IdeaNodeData, column: LayoutColumn, row: number) => {
    nodes.push({
      id,
      type: "idea",
      position: { x: column.x, y: row * rowHeight },
      data,
      draggable: true
    });
  };

  // Origin + Core idea at the top.
  const coreIdea = (idea.core_idea || idea.summary || "").trim();
  const originSubtitleParts = [origin?.provider, origin?.occurredAt].filter(Boolean) as string[];
  push(
    "origin",
    {
      kind: "origin",
      title: origin?.title?.trim() || "This session",
      subtitle: originSubtitleParts.join(" · ") || undefined,
      bullets: origin?.participants?.length ? origin.participants.slice(0, 4) : undefined
    },
    { x: COLUMN_CENTER.x - 280, align: "right" },
    centerRow
  );
  if (coreIdea) {
    push(
      "core",
      {
        kind: "core",
        title: coreIdea,
        subtitle: idea.thread_hint?.trim() ? `Thread: ${idea.thread_hint.trim()}` : undefined
      },
      COLUMN_CENTER,
      centerRow
    );
    edges.push({
      id: "origin->core",
      source: "origin",
      target: "core",
      type: "smoothstep",
      label: "started",
      style: { stroke: "#64748b" },
      labelStyle: { fontSize: 10, fill: "#475569" },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#64748b" }
    });
    centerRow += 1;
  }

  // Reasoning chain: each step a node, linked to the previous.
  const reasoning = textList(idea.reasoning_steps);
  let previousCenter = coreIdea ? "core" : "origin";
  reasoning.forEach((step, index) => {
    const id = `step-${index}`;
    push(
      id,
      { kind: "reasoning", title: step, index: index + 1 },
      COLUMN_CENTER,
      centerRow + index
    );
    edges.push({
      id: `${previousCenter}->${id}`,
      source: previousCenter,
      target: id,
      type: "smoothstep",
      label: index === 0 ? "because" : "then",
      style: { stroke: "#475569" },
      labelStyle: { fontSize: 10, fill: "#334155" },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#475569" }
    });
    previousCenter = id;
  });
  centerRow += reasoning.length;

  // Supports — branch off from the core idea (or origin if no core), rendered on the left.
  const supports = textList(idea.supports);
  supports.forEach((item, index) => {
    const id = `support-${index}`;
    push(
      id,
      { kind: "support", title: item },
      COLUMN_SUPPORT,
      Math.max(1, Math.floor(((index + 0.5) * (reasoning.length + 1)) / Math.max(supports.length, 1)))
    );
    edges.push({
      id: `${id}->spine`,
      source: id,
      target: coreIdea ? "core" : "origin",
      type: "smoothstep",
      label: "supports",
      animated: true,
      style: { stroke: "#16a34a", strokeDasharray: "4 4" },
      labelStyle: { fontSize: 10, fill: "#15803d" },
      markerEnd: { type: MarkerType.Arrow, color: "#16a34a" }
    });
  });

  // Conflicts — right column mirror of supports.
  const conflicts = textList(idea.conflicts_with);
  conflicts.forEach((item, index) => {
    const id = `conflict-${index}`;
    push(
      id,
      { kind: "conflict", title: item },
      COLUMN_CONFLICT,
      Math.max(1, Math.floor(((index + 0.5) * (reasoning.length + 1)) / Math.max(conflicts.length, 1)))
    );
    edges.push({
      id: `${id}->spine`,
      source: id,
      target: coreIdea ? "core" : "origin",
      type: "smoothstep",
      label: "tension",
      animated: true,
      style: { stroke: "#dc2626", strokeDasharray: "4 4" },
      labelStyle: { fontSize: 10, fill: "#b91c1c" },
      markerEnd: { type: MarkerType.Arrow, color: "#dc2626" }
    });
  });

  // Related facts anchor at the bottom.
  const facts = textList(idea.related_facts);
  if (facts.length) {
    const factsRow = centerRow + 0.5;
    facts.forEach((fact, index) => {
      const id = `fact-${index}`;
      const x = -320 + (index - (facts.length - 1) / 2) * 220;
      nodes.push({
        id,
        type: "idea",
        position: { x, y: factsRow * rowHeight },
        data: { kind: "fact", title: fact }
      });
      edges.push({
        id: `${id}->anchor`,
        source: id,
        target: previousCenter,
        type: "smoothstep",
        label: "anchors",
        style: { stroke: "#2563eb", strokeDasharray: "2 4" },
        labelStyle: { fontSize: 10, fill: "#1d4ed8" },
        markerEnd: { type: MarkerType.Arrow, color: "#2563eb" }
      });
    });
    centerRow = factsRow + 1;
  }

  // Next steps follow at the bottom of the center spine.
  const nextSteps = textList(idea.next_steps);
  if (nextSteps.length) {
    const id = "next-steps";
    push(
      id,
      {
        kind: "nextStep",
        title: "Next steps",
        bullets: nextSteps.slice(0, 5)
      },
      COLUMN_CENTER,
      centerRow
    );
    edges.push({
      id: `${previousCenter}->next`,
      source: previousCenter,
      target: id,
      type: "smoothstep",
      label: "leads to",
      style: { stroke: "#b45309" },
      labelStyle: { fontSize: 10, fill: "#92400e" },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#b45309" }
    });
    previousCenter = id;
    centerRow += 1;
  }

  // Share post as a footer card.
  const share = idea.share_post?.trim();
  if (share) {
    const id = "share";
    push(id, { kind: "share", title: share }, COLUMN_CENTER, centerRow);
    edges.push({
      id: `${previousCenter}->share`,
      source: previousCenter,
      target: id,
      type: "smoothstep",
      style: { stroke: "#94a3b8" }
    });
  }

  return { nodes, edges };
}

export function IdeaFlow({
  idea,
  origin,
  className,
  height = 460
}: {
  idea: IdeaFlowData;
  origin?: IdeaFlowOrigin;
  className?: string;
  height?: number;
}) {
  const { nodes, edges } = useMemo(() => buildGraph(idea, origin), [idea, origin]);

  if (!nodes.length) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-[8px] border border-dashed border-[var(--color-line)] bg-[var(--color-paper-raised)] p-6 text-sm text-[var(--color-ink-soft)]",
          className
        )}
        style={{ height }}
      >
        No idea structure has been extracted for this note yet.
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)]",
        className
      )}
      style={{ height }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.2}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#d4d8dd" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
      <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">
        <LegendDot color="#4f46e5" label="Core" />
        <LegendDot color="#16a34a" label="Supports" />
        <LegendDot color="#dc2626" label="Conflicts" />
        <LegendDot color="#2563eb" label="Fact anchors" />
        <LegendDot color="#b45309" label="Next steps" />
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1 rounded-full bg-[var(--color-paper-raised)]/90 px-2 py-[2px]">
      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
