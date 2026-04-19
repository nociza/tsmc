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
  | "thread"
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
  connective?: string;
};

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item): item is string => item.length > 0);
}

function cardClass(kind: IdeaNodeKind): string {
  switch (kind) {
    case "thread":
      return "border-[#818cf8] bg-gradient-to-r from-[#eef2ff] to-[#f5f3ff] text-[#3730a3]";
    case "origin":
      return "border-[var(--color-line)] bg-[var(--color-paper-sunken)] text-[var(--color-ink-soft)]";
    case "core":
      return "border-[#4338ca] bg-gradient-to-br from-[#eef2ff] via-[#e0e7ff] to-[#ede9fe] text-[#1e1b4b] shadow-md";
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
    case "thread":
      return "Thread";
    case "origin":
      return "Origin";
    case "core":
      return "The idea";
    case "reasoning":
      return "Reasoning";
    case "support":
      return "In favor";
    case "conflict":
      return "Counterpoint";
    case "fact":
      return "Grounded in";
    case "nextStep":
      return "What's next";
    case "share":
      return "Ready to share";
  }
}

function IdeaNode({ data }: NodeProps<Node<IdeaNodeData, IdeaNodeKind>>) {
  const { kind, title, subtitle, bullets, index, connective } = data;
  const isCore = kind === "core";
  const isArgument = kind === "support" || kind === "conflict";
  const isThread = kind === "thread";
  return (
    <div
      className={cn(
        "relative rounded-[10px] border px-3 py-2 text-xs leading-5 shadow-sm",
        isCore ? "max-w-[340px] min-w-[260px] px-4 py-3" : "max-w-[240px] min-w-[180px]",
        isThread ? "max-w-[520px]" : undefined,
        cardClass(kind)
      )}
    >
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-none !bg-current opacity-40" />
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-[0.08em] opacity-70">
        <span>
          {kindLabel(kind)}
          {typeof index === "number" ? ` · #${index}` : ""}
        </span>
        {connective ? <span className="font-medium normal-case tracking-normal">{connective}</span> : null}
      </div>
      <div
        className={cn(
          "whitespace-pre-wrap break-words",
          isCore ? "text-sm font-semibold leading-6" : undefined,
          isArgument ? "before:mr-1 before:content-['“'] after:ml-1 after:content-['”'] italic" : undefined
        )}
      >
        {title}
      </div>
      {subtitle ? <div className="mt-1 text-[10px] leading-4 opacity-75">{subtitle}</div> : null}
      {bullets && bullets.length ? (
        <ul className="mt-1 list-disc pl-4 text-[10px] leading-4 opacity-85">
          {bullets.map((line, idx) => (
            <li key={idx}>{line}</li>
          ))}
        </ul>
      ) : null}
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-none !bg-current opacity-40" />
    </div>
  );
}

const NODE_TYPES = { idea: IdeaNode } as const;

const CENTER_X = 0;
const SUPPORT_X = -360;
const CONFLICT_X = 360;
const ROW = 140;

function reasoningConnective(index: number, total: number): string {
  if (total === 1) return "because";
  if (index === 0) return "because";
  if (index === total - 1) return "so";
  return "which means";
}

function buildGraph(idea: IdeaFlowData, origin?: IdeaFlowOrigin): { nodes: Node<IdeaNodeData>[]; edges: Edge[] } {
  const nodes: Node<IdeaNodeData>[] = [];
  const edges: Edge[] = [];
  let row = 0;

  // Optional thread banner. Spans the full width to signal that this idea is a
  // chapter in a larger evolving thread.
  const threadHint = idea.thread_hint?.trim();
  let threadNodeId: string | null = null;
  if (threadHint) {
    threadNodeId = "thread";
    nodes.push({
      id: threadNodeId,
      type: "idea",
      position: { x: CENTER_X, y: row * ROW },
      data: {
        kind: "thread",
        title: threadHint,
        subtitle: "Part of an evolving thread — earlier sessions contribute to this idea"
      }
    });
    row += 1;
  }

  // Origin context.
  const originSubtitleParts = [origin?.provider, origin?.occurredAt].filter(Boolean) as string[];
  const originId = "origin";
  nodes.push({
    id: originId,
    type: "idea",
    position: { x: CENTER_X, y: row * ROW },
    data: {
      kind: "origin",
      title: origin?.title?.trim() || "This session",
      subtitle: originSubtitleParts.join(" · ") || undefined,
      bullets: origin?.participants?.length ? [`Discussed with: ${origin.participants.slice(0, 4).join(", ")}`] : undefined
    }
  });
  if (threadNodeId) {
    edges.push({
      id: `${threadNodeId}->${originId}`,
      source: threadNodeId,
      target: originId,
      type: "smoothstep",
      style: { stroke: "#a5b4fc", strokeDasharray: "2 4" },
      markerEnd: { type: MarkerType.Arrow, color: "#a5b4fc" }
    });
  }
  row += 1;

  // Hero: the core idea.
  const coreIdea = (idea.core_idea || idea.summary || "").trim();
  let previousCenter = originId;
  if (coreIdea) {
    const coreId = "core";
    nodes.push({
      id: coreId,
      type: "idea",
      position: { x: CENTER_X, y: row * ROW },
      data: { kind: "core", title: coreIdea }
    });
    edges.push({
      id: `${originId}->${coreId}`,
      source: originId,
      target: coreId,
      type: "smoothstep",
      label: "surfaced",
      style: { stroke: "#6366f1", strokeWidth: 2 },
      labelStyle: { fontSize: 10, fill: "#4338ca", fontWeight: 600 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#6366f1" }
    });
    previousCenter = coreId;
    row += 1;
  }

  // Reasoning chain with narrative connectives.
  const reasoning = textList(idea.reasoning_steps);
  reasoning.forEach((step, index) => {
    const id = `step-${index}`;
    nodes.push({
      id,
      type: "idea",
      position: { x: CENTER_X, y: row * ROW },
      data: {
        kind: "reasoning",
        title: step,
        index: index + 1,
        connective: reasoningConnective(index, reasoning.length)
      }
    });
    edges.push({
      id: `${previousCenter}->${id}`,
      source: previousCenter,
      target: id,
      type: "smoothstep",
      label: reasoningConnective(index, reasoning.length),
      style: { stroke: "#475569" },
      labelStyle: { fontSize: 10, fill: "#334155" },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#475569" }
    });
    previousCenter = id;
    row += 1;
  });

  // Arguments: supports and conflicts flank the spine. Distribute them along
  // the rows adjacent to the reasoning chain so the spine reads as "these
  // voices weigh in on each step of the thinking."
  const supports = textList(idea.supports);
  const conflicts = textList(idea.conflicts_with);
  const spineSpan = Math.max(reasoning.length + (coreIdea ? 1 : 0), 1);
  const spineStart = row - spineSpan;
  const anchorForArgs = coreIdea ? "core" : originId;

  const placeArg = (
    items: string[],
    kind: "support" | "conflict",
    x: number,
    edgeColor: string,
    edgeLabel: string
  ) => {
    items.forEach((item, index) => {
      const id = `${kind}-${index}`;
      const localRow = spineStart + Math.max(0, Math.floor(((index + 0.5) * spineSpan) / Math.max(items.length, 1)));
      nodes.push({
        id,
        type: "idea",
        position: { x, y: localRow * ROW },
        data: { kind, title: item }
      });
      edges.push({
        id: `${id}->spine`,
        source: id,
        target: anchorForArgs,
        type: "smoothstep",
        label: edgeLabel,
        animated: true,
        style: { stroke: edgeColor, strokeDasharray: "4 4" },
        labelStyle: { fontSize: 10, fill: edgeColor, fontWeight: 600 },
        markerEnd: { type: MarkerType.Arrow, color: edgeColor }
      });
    });
  };
  placeArg(supports, "support", SUPPORT_X, "#16a34a", "reinforces");
  placeArg(conflicts, "conflict", CONFLICT_X, "#dc2626", "pushes back");

  // Grounded-in facts: horizontal substrate at the bottom, each anchoring
  // upward into the last spine node. Facts are the stable ground, not the
  // structure — drawn thin and dashed.
  const facts = textList(idea.related_facts);
  if (facts.length) {
    const factRow = row;
    facts.forEach((fact, index) => {
      const id = `fact-${index}`;
      const x = CENTER_X + (index - (facts.length - 1) / 2) * 240;
      nodes.push({
        id,
        type: "idea",
        position: { x, y: factRow * ROW },
        data: { kind: "fact", title: fact }
      });
      edges.push({
        id: `${previousCenter}->${id}`,
        source: previousCenter,
        target: id,
        type: "smoothstep",
        label: index === 0 ? "grounded in" : undefined,
        style: { stroke: "#2563eb", strokeDasharray: "2 4" },
        labelStyle: { fontSize: 10, fill: "#1d4ed8" },
        markerEnd: { type: MarkerType.Arrow, color: "#2563eb" }
      });
    });
    row = factRow + 1;
  }

  // Next steps: forward-looking, single node at tail.
  const nextSteps = textList(idea.next_steps);
  if (nextSteps.length) {
    const id = "next-steps";
    nodes.push({
      id,
      type: "idea",
      position: { x: CENTER_X, y: row * ROW },
      data: {
        kind: "nextStep",
        title: "Where this heads next",
        bullets: nextSteps.slice(0, 5)
      }
    });
    edges.push({
      id: `${previousCenter}->${id}`,
      source: previousCenter,
      target: id,
      type: "smoothstep",
      label: "leads to",
      style: { stroke: "#b45309" },
      labelStyle: { fontSize: 10, fill: "#92400e" },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#b45309" }
    });
    previousCenter = id;
    row += 1;
  }

  // Share post sits at the tail as a quieter footer — not part of the logic,
  // just a distilled public-facing distillation.
  const share = idea.share_post?.trim();
  if (share) {
    const id = "share";
    nodes.push({
      id,
      type: "idea",
      position: { x: CENTER_X, y: row * ROW },
      data: { kind: "share", title: share }
    });
    edges.push({
      id: `${previousCenter}->${id}`,
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
        <LegendDot color="#4338ca" label="Core idea" />
        <LegendDot color="#16a34a" label="In favor" />
        <LegendDot color="#dc2626" label="Counterpoints" />
        <LegendDot color="#2563eb" label="Grounded in" />
        <LegendDot color="#b45309" label="What's next" />
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
