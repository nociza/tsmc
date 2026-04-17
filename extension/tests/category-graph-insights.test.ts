import { describe, expect, it } from "vitest";

import type { BackendCategoryGraph, BackendSessionListItem } from "../src/shared/types";
import { buildCategoryGraphInsights, clusterKeyForNode } from "../src/ui/lib/category-graph-insights";

const sessions: BackendSessionListItem[] = [
  {
    id: "s1",
    provider: "chatgpt",
    external_session_id: "ext-1",
    title: "Neural nets",
    category: "factual",
    custom_tags: [],
    user_categories: [],
    updated_at: "2026-04-14T11:00:00Z"
  },
  {
    id: "s2",
    provider: "gemini",
    external_session_id: "ext-2",
    title: "Optimizers",
    category: "factual",
    custom_tags: [],
    user_categories: [],
    updated_at: "2026-04-15T11:00:00Z"
  },
  {
    id: "s3",
    provider: "grok",
    external_session_id: "ext-3",
    title: "Detached note",
    category: "factual",
    custom_tags: [],
    user_categories: [],
    updated_at: "2026-04-16T11:00:00Z"
  }
];

const graph: BackendCategoryGraph = {
  category: "factual",
  scope_kind: "default",
  scope_label: "Factual",
  dominant_category: "factual",
  node_count: 3,
  edge_count: 1,
  nodes: [
    {
      id: "n1",
      label: "Transformer",
      kind: "entity",
      size: 4,
      session_ids: ["s1", "s2"],
      provider: "chatgpt",
      updated_at: "2026-04-15T10:00:00Z"
    },
    {
      id: "n2",
      label: "Attention",
      kind: "concept",
      size: 2,
      session_ids: ["s2"],
      provider: "gemini",
      updated_at: "2026-04-15T09:00:00Z"
    },
    {
      id: "n3",
      label: "Lonely node",
      kind: "concept",
      size: 1,
      session_ids: ["s1"],
      provider: "chatgpt",
      updated_at: "2026-04-14T08:00:00Z"
    }
  ],
  edges: [
    {
      id: "e1",
      source: "n1",
      target: "n2",
      label: "relates_to",
      weight: 3,
      session_ids: ["s2"]
    }
  ]
};

describe("category graph insights", () => {
  it("groups nodes by provider and surfaces coverage warnings", () => {
    const insights = buildCategoryGraphInsights(graph, sessions, "factual", "provider");

    expect(insights.clusters.map((cluster) => cluster.id)).toEqual(["provider:chatgpt", "provider:gemini"]);
    expect(insights.corroboratedNodes).toBe(1);
    expect(insights.orphanNodes).toBe(1);
    expect(insights.uncoveredSessions).toBe(1);
    expect(insights.sessionCoverage).toBeCloseTo(2 / 3, 5);
    expect(insights.warnings.map((warning) => warning.id)).toContain("coverage");
    expect(insights.storylines[0]?.label).toBe("Transformer");
  });

  it("can cluster by semantic kind", () => {
    const insights = buildCategoryGraphInsights(graph, sessions, "factual", "kind");

    expect(insights.clusters.map((cluster) => cluster.id)).toEqual(["kind:concept", "kind:entity"]);
    expect(clusterKeyForNode(graph.nodes[1], "kind")).toBe("kind:concept");
    expect(insights.denseNodes[0]?.neighbors).toContain("Attention");
  });
});
