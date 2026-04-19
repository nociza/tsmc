import { useEffect, useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import * as Tabs from "@radix-ui/react-tabs";
import { Activity, ArrowLeft, BrainCircuit, Database, ExternalLink, Search, Sparkles, Workflow } from "lucide-react";

import {
  fetchCategoryGraph,
  fetchCategoryGraphPath,
  fetchCategoryStats,
  fetchCustomCategoryGraph,
  fetchCustomCategoryGraphPath,
  fetchCustomCategoryStats,
  fetchExplorerSearch,
  fetchSessionNote,
  fetchSessions,
  fetchTodoList,
  fetchUserCategories,
  updateSessionUserCategories,
  updateTodoList
} from "../background/backend";
import {
  categoryGlyphs,
  categoryLabels,
  categoryOrder,
  categoryPalette,
  formatCompactDate,
  formatLongDate,
  notePageUrl,
  parseCategory,
  parseCategoryWorkspaceView,
  parseProvider,
  parseSortMode,
  providerColors,
  providerLabels,
  titleFromSession,
  type CategorySortMode,
  type CategoryWorkspaceView
} from "../shared/explorer";
import type {
  BackendCategoryGraph,
  BackendCategoryGraphPath,
  BackendCategoryStats,
  BackendExplorerGraphEvidence,
  BackendExplorerGraphNode,
  BackendExplorerGraphPath,
  BackendSearchResponse,
  BackendSessionListItem,
  BackendSessionNoteRead,
  BackendTodoItem,
  BackendUserCategorySummary,
  ExtensionSettings,
  ProviderName,
  SessionCategoryName
} from "../shared/types";
import { mountApp } from "../ui/boot";
import { Badge } from "../ui/components/badge";
import { Button } from "../ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/components/card";
import { CategoryGraph, type CategoryGraphDensity, type CategoryGraphFocusMode, type CategoryGraphSelection } from "../ui/components/category-graph";
import { ScrollArea } from "../ui/components/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/components/select";
import { TodoWorkspace } from "../ui/components/todo-workspace";
import { formatNumber, formatPercent } from "../ui/lib/format";
import { MarkdownView, NoteOverview, TranscriptView } from "../ui/lib/notes";
import { buildCategoryGraphInsights, type GraphGroupingMode } from "../ui/lib/category-graph-insights";
import { useDebouncedValue, useExtensionBootstrap } from "../ui/lib/runtime";

type RouteState = {
  category: SessionCategoryName;
  q: string;
  provider: ProviderName | null;
  sort: CategorySortMode;
  view: CategoryWorkspaceView;
  bucket: string | null;
  note: string | null;
  userCategory: string | null;
};

type GraphFocus = {
  label: string;
  sessionIds: string[];
};

function readRouteState(): RouteState {
  const params = new URLSearchParams(window.location.search);
  return {
    category: parseCategory(params.get("category")),
    q: params.get("q")?.trim() ?? "",
    provider: parseProvider(params.get("provider")),
    sort: parseSortMode(params.get("sort")),
    view: parseCategoryWorkspaceView(params.get("view")),
    bucket: params.get("bucket")?.trim() ?? null,
    note: params.get("note"),
    userCategory: params.get("userCategory")?.trim() ?? null
  };
}

function writeRouteState(state: RouteState, push = true): void {
  const url = new URL(window.location.href);
  url.searchParams.set("category", state.category);
  if (state.q.trim()) {
    url.searchParams.set("q", state.q.trim());
  } else {
    url.searchParams.delete("q");
  }
  if (state.provider) {
    url.searchParams.set("provider", state.provider);
  } else {
    url.searchParams.delete("provider");
  }
  if (state.sort !== "recent") {
    url.searchParams.set("sort", state.sort);
  } else {
    url.searchParams.delete("sort");
  }
  if (state.view !== "atlas") {
    url.searchParams.set("view", state.view);
  } else {
    url.searchParams.delete("view");
  }
  if (state.bucket) {
    url.searchParams.set("bucket", state.bucket);
  } else {
    url.searchParams.delete("bucket");
  }
  if (state.note) {
    url.searchParams.set("note", state.note);
  } else {
    url.searchParams.delete("note");
  }
  if (state.userCategory?.trim()) {
    url.searchParams.set("userCategory", state.userCategory.trim());
  } else {
    url.searchParams.delete("userCategory");
  }

  if (push) {
    window.history.pushState(null, "", url);
  } else {
    window.history.replaceState(null, "", url);
  }
}

function createEmptyStats(category: SessionCategoryName): BackendCategoryStats {
  return {
    category,
    scope_kind: "default",
    scope_label: categoryLabels[category],
    dominant_category: category,
    total_sessions: 0,
    total_messages: 0,
    total_triplets: 0,
    latest_updated_at: null,
    avg_messages_per_session: 0,
    avg_triplets_per_session: 0,
    notes_with_share_post: 0,
    notes_with_idea_summary: 0,
    notes_with_journal_entry: 0,
    notes_with_todo_summary: 0,
    system_category_counts: [{ category, count: 0 }],
    provider_counts: [],
    activity: [],
    top_tags: [],
    top_entities: [],
    top_predicates: []
  };
}

function createEmptyGraph(category: SessionCategoryName): BackendCategoryGraph {
  return {
    category,
    scope_kind: "default",
    scope_label: categoryLabels[category],
    dominant_category: category,
    node_count: 0,
    edge_count: 0,
    nodes: [],
    edges: []
  };
}

function sortSessions(items: BackendSessionListItem[], sortMode: CategorySortMode): BackendSessionListItem[] {
  const sorted = [...items];
  if (sortMode === "title") {
    sorted.sort((left, right) => titleFromSession(left).localeCompare(titleFromSession(right)));
    return sorted;
  }

  sorted.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  return sorted;
}

function searchMatchMap(search: BackendSearchResponse | undefined): Map<string, { snippet: string; kind: string }> {
  const matches = new Map<string, { snippet: string; kind: string }>();
  for (const result of search?.results ?? []) {
    if (!result.session_id || matches.has(result.session_id)) {
      continue;
    }
    matches.set(result.session_id, {
      snippet: result.snippet,
      kind: result.kind
    });
  }
  return matches;
}

function signalGroups(stats: BackendCategoryStats): {
  primary: Array<{ label: string; count: number }>;
  secondary: Array<{ label: string; count: number }>;
} {
  if (stats.category === "factual") {
    return {
      primary: stats.top_entities,
      secondary: stats.top_predicates
    };
  }

  return {
    primary: stats.top_tags,
    secondary: [
      {
        label: stats.category === "ideas" ? "Summaries" : stats.category === "journal" ? "Entries" : "Task updates",
        count:
          stats.category === "ideas"
            ? stats.notes_with_idea_summary
            : stats.category === "journal"
              ? stats.notes_with_journal_entry
              : stats.notes_with_todo_summary
      },
      { label: "Share posts", count: stats.notes_with_share_post }
    ]
  };
}

function sessionPreviewText(
  session: BackendSessionListItem,
  match: { snippet: string; kind: string } | undefined,
  category: SessionCategoryName
): string {
  if (match?.snippet) {
    return match.snippet;
  }
  if (session.share_post) {
    return session.share_post;
  }
  if (category === "todo") {
    return "Open this saved update to see how the shared checklist changed.";
  }
  return "Open to inspect this note.";
}

function formatBucketLabel(bucket: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(bucket)) {
    const parsed = new Date(`${bucket}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }
  }

  if (/^\d{4}-\d{2}$/.test(bucket)) {
    const parsed = new Date(`${bucket}-01T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleDateString(undefined, { month: "short", year: "numeric" });
    }
  }

  return bucket;
}

function buildActivityBuckets(sessions: BackendSessionListItem[]): Array<{ bucket: string; count: number; label: string }> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const bucket = session.updated_at.slice(0, 10);
    if (!bucket) {
      continue;
    }
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-12)
    .map(([bucket, count]) => ({
      bucket,
      count,
      label: formatBucketLabel(bucket)
    }));
}

function noteListMeta(
  route: RouteState,
  total: number,
  visible: number,
  focus: GraphFocus | null,
  displayCategory: SessionCategoryName
): string {
  const providerText = route.provider ? ` in ${providerLabels[route.provider]}` : "";
  const bucketText = route.bucket ? ` · ${formatBucketLabel(route.bucket)}` : "";
  const userCategoryText = route.userCategory ? ` · custom category ${route.userCategory}` : "";
  const collectionLabel = displayCategory === "todo" ? "update notes" : "notes";
  if (focus) {
    return `${formatNumber(visible)} ${collectionLabel} linked to ${focus.label}${bucketText}${userCategoryText}`;
  }
  if (route.q) {
    return `${formatNumber(visible)} matches for "${route.q}" from ${formatNumber(total)} ${collectionLabel}${providerText}${bucketText}${userCategoryText}`;
  }
  return `${formatNumber(total)} ${collectionLabel} in view${providerText}${bucketText}${userCategoryText}`;
}

function graphNodeOptionScore(node: BackendExplorerGraphNode): number {
  return (node.degree ?? 0) * 8 + node.session_ids.length * 5 + (node.centrality ?? 0) * 10 + Math.log(node.size + 1) * 3;
}

function evidenceKey(evidence: BackendExplorerGraphEvidence): string {
  return [evidence.triplet_id, evidence.session_id, evidence.predicate, evidence.snippet].filter(Boolean).join(":");
}

function evidenceForSelection(graph: BackendCategoryGraph, selection: CategoryGraphSelection | null): BackendExplorerGraphEvidence[] {
  if (!selection) {
    return [];
  }

  const sessionSet = new Set(selection.sessionIds);
  const evidence =
    selection.kind === "node"
      ? (graph.nodes.find((node) => node.id === selection.id)?.evidence ?? [])
      : graph.edges
          .filter((edge) => edge.session_ids.some((sessionId) => sessionSet.has(sessionId)))
          .filter((edge) => !selection.label || selection.label === "Relationship" || selection.label.includes(edge.label ?? ""))
          .flatMap((edge) => edge.evidence ?? []);

  const seen = new Set<string>();
  const unique: BackendExplorerGraphEvidence[] = [];
  for (const item of evidence) {
    const key = evidenceKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function GraphEvidencePanel({
  graph,
  selection,
  onClear
}: {
  graph: BackendCategoryGraph;
  selection: CategoryGraphSelection | null;
  onClear: () => void;
}) {
  const selectedNode = selection?.kind === "node" ? graph.nodes.find((node) => node.id === selection.id) ?? null : null;
  const evidence = evidenceForSelection(graph, selection);

  return (
    <div className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-2.5">
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-soft)]">Evidence</div>
          <div className="mt-0.5 truncate text-sm font-semibold text-[var(--color-ink)]">
            {selection ? selection.label : "Select a node or link"}
          </div>
        </div>
        {selection ? (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={onClear}>
            Clear
          </Button>
        ) : null}
      </div>

      {selectedNode ? (
        <div className="mb-1.5 grid grid-cols-3 gap-1">
          {[
            { label: "Links", value: formatNumber(selectedNode.degree ?? 0) },
            { label: "Notes", value: formatNumber(selectedNode.session_ids.length) },
            { label: "Score", value: `${Math.round((selectedNode.centrality ?? 0) * 100)}%` }
          ].map((metric) => (
            <div key={metric.label} className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-2 py-1">
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">{metric.label}</div>
              <div className="mt-1 text-sm font-semibold text-[var(--color-ink)]">{metric.value}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="space-y-1.5">
        {evidence.slice(0, 2).map((item, index) => (
          <div key={`${evidenceKey(item)}:${index}`} className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold text-[var(--color-ink)]">{item.title || "Untitled note"}</div>
                <div className="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">
                  {item.provider ? providerLabels[item.provider] : "source"} · {formatCompactDate(item.updated_at, "No date")}
                </div>
              </div>
              {typeof item.confidence === "number" ? <Badge tone="info">{Math.round(item.confidence * 100)}%</Badge> : null}
            </div>
            {item.snippet ? <p className="mt-1 line-clamp-1 text-xs leading-5 text-[var(--color-ink-soft)]">{item.snippet}</p> : null}
          </div>
        ))}
        {!selection ? <p className="text-xs leading-5 text-[var(--color-ink-soft)]">Click a node or link for source notes and extracted facts.</p> : null}
        {selection && !evidence.length ? <p className="text-xs leading-5 text-[var(--color-ink-soft)]">No snippets are available for this selection yet.</p> : null}
      </div>
    </div>
  );
}

function GraphPathPanel({
  nodes,
  sourceId,
  targetId,
  path,
  loading,
  error,
  onSourceChange,
  onTargetChange,
  onFocusPath
}: {
  nodes: BackendExplorerGraphNode[];
  sourceId: string | null;
  targetId: string | null;
  path: BackendCategoryGraphPath | null;
  loading: boolean;
  error: Error | null;
  onSourceChange: (nodeId: string) => void;
  onTargetChange: (nodeId: string) => void;
  onFocusPath: (path: BackendExplorerGraphPath) => void;
}) {
  const canSearch = nodes.length >= 2 && sourceId && targetId && sourceId !== targetId;

  return (
    <div className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-soft)]">Path finder</div>
      <div className="mt-0.5 text-sm font-semibold text-[var(--color-ink)]">Connect two concepts</div>

      <div className="mt-2 grid gap-1.5">
        <Select value={sourceId ?? ""} onValueChange={onSourceChange} disabled={!nodes.length}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            {nodes.map((node) => (
              <SelectItem key={node.id} value={node.id} className="py-1.5 text-xs">
                {node.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={targetId ?? ""} onValueChange={onTargetChange} disabled={!nodes.length}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Target" />
          </SelectTrigger>
          <SelectContent>
            {nodes.map((node) => (
              <SelectItem key={node.id} value={node.id} className="py-1.5 text-xs">
                {node.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-2 space-y-1.5">
        {nodes.length < 2 ? <p className="text-xs leading-5 text-[var(--color-ink-soft)]">At least two visible concepts are needed.</p> : null}
        {loading ? <p className="text-xs text-[var(--color-ink-soft)]">Finding paths...</p> : null}
        {error && canSearch ? <p className="text-xs text-[#963c24]">{error.message}</p> : null}
        {path?.paths.slice(0, 2).map((item, index) => (
          <button
            key={`${item.node_ids.join(":")}:${index}`}
            type="button"
            onClick={() => onFocusPath(item)}
            className="w-full rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-1.5 text-left transition hover:bg-[var(--color-paper-sunken)]"
          >
            <div className="line-clamp-1 text-xs font-semibold leading-5 text-[var(--color-ink)]">
              {item.nodes.map((node) => node.label).join(" -> ")}
            </div>
            <div className="mt-1 text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">
              {formatNumber(item.hop_count)} hops · strength {item.score.toFixed(1)} · {formatNumber(item.evidence_session_ids.length)} notes
            </div>
          </button>
        ))}
        {path && !path.paths.length && canSearch ? (
          <p className="text-xs leading-5 text-[var(--color-ink-soft)]">No visible path connects those concepts.</p>
        ) : null}
      </div>
    </div>
  );
}

function App() {
  const { settings, status, loading, error } = useExtensionBootstrap();
  const [route, setRoute] = useState<RouteState>(readRouteState);
  const [graphFocus, setGraphFocus] = useState<GraphFocus | null>(null);
  const [graphInspect, setGraphInspect] = useState<CategoryGraphSelection | null>(null);
  const [readerTab, setReaderTab] = useState<"overview" | "transcript" | "markdown">("overview");
  const [groupingMode, setGroupingMode] = useState<GraphGroupingMode>("community");
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const [graphDensity, setGraphDensity] = useState<CategoryGraphDensity>("curated");
  const [graphFocusMode, setGraphFocusMode] = useState<CategoryGraphFocusMode>("context");
  const [graphProviderFilter, setGraphProviderFilter] = useState<ReadonlySet<ProviderName>>(() => new Set());
  const [graphKindFilter, setGraphKindFilter] = useState<ReadonlySet<string>>(() => new Set());
  const [pathSourceId, setPathSourceId] = useState<string | null>(null);
  const [pathTargetId, setPathTargetId] = useState<string | null>(null);
  const [todoDraft, setTodoDraft] = useState("");
  const [todoActionError, setTodoActionError] = useState<string | null>(null);
  const [todoSavingSummary, setTodoSavingSummary] = useState<string | null>(null);
  const [userCategoryDraft, setUserCategoryDraft] = useState("");
  const [userCategoryError, setUserCategoryError] = useState<string | null>(null);
  const debouncedQuery = useDebouncedValue(route.q);
  const isCustomScope = Boolean(route.userCategory);

  useEffect(() => {
    const handlePopState = (): void => {
      setRoute(readRouteState());
      setGraphFocus(null);
      setGraphInspect(null);
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  function updateRoute(next: Partial<RouteState>, push = true): void {
    setRoute((current) => {
      const updated = { ...current, ...next };
      writeRouteState(updated, push);
      return updated;
    });
  }

  const sessionsQuery = useQuery({
    queryKey: ["category-sessions", settings?.backendUrl, settings?.backendToken, route.category, route.provider, route.userCategory],
    queryFn: () =>
      fetchSessions(
        settings as ExtensionSettings,
        route.provider || route.userCategory
          ? {
              category: isCustomScope ? undefined : route.category,
              provider: route.provider ?? undefined,
              userCategory: route.userCategory ?? undefined
            }
          : { category: route.category }
      ),
    enabled: Boolean(settings && !status?.backendValidationError)
  });

  const userCategoriesQuery = useQuery({
    queryKey: ["session-user-categories", settings?.backendUrl, settings?.backendToken, route.provider, isCustomScope ? null : route.category],
    queryFn: () =>
      fetchUserCategories(settings as ExtensionSettings, {
        provider: route.provider ?? undefined,
        category: isCustomScope ? undefined : route.category
      }),
    enabled: Boolean(settings && !status?.backendValidationError)
  });

  const searchQuery = useQuery({
    queryKey: [
      "category-search",
      settings?.backendUrl,
      settings?.backendToken,
      route.category,
      route.provider,
      route.userCategory,
      debouncedQuery
    ],
    queryFn: () =>
      fetchExplorerSearch(settings as ExtensionSettings, debouncedQuery, {
        category: isCustomScope ? undefined : route.category,
        provider: route.provider ?? undefined,
        userCategory: route.userCategory ?? undefined,
        limit: 80
      }),
    enabled: Boolean(settings && !status?.backendValidationError && debouncedQuery.trim())
  });

  const matches = useMemo(() => searchMatchMap(searchQuery.data), [searchQuery.data]);
  const allSessions = sessionsQuery.data ?? [];
  const preBucketSessions = useMemo(() => {
    const base = sortSessions(allSessions, route.sort);
    if (!debouncedQuery.trim()) {
      return base;
    }
    const visibleIds = new Set(matches.keys());
    return base.filter((session) => visibleIds.has(session.id));
  }, [allSessions, debouncedQuery, matches, route.sort]);
  const activityBuckets = useMemo(() => buildActivityBuckets(preBucketSessions), [preBucketSessions]);

  useEffect(() => {
    if (route.bucket && !activityBuckets.some((bucket) => bucket.bucket === route.bucket)) {
      updateRoute({ bucket: null }, false);
    }
  }, [activityBuckets, route.bucket]);

  const visibleSessions = useMemo(() => {
    if (!route.bucket) {
      return preBucketSessions;
    }
    return preBucketSessions.filter((session) => session.updated_at.startsWith(route.bucket as string));
  }, [preBucketSessions, route.bucket]);

  const scopedSessionIds = debouncedQuery.trim() || route.bucket ? visibleSessions.map((session) => session.id) : undefined;

  const statsQuery = useQuery({
    queryKey: [
      "category-stats",
      settings?.backendUrl,
      settings?.backendToken,
      route.category,
      route.provider,
      route.userCategory,
      scopedSessionIds?.join("|") ?? "*"
    ],
    queryFn: () =>
      isCustomScope
        ? fetchCustomCategoryStats(
            settings as ExtensionSettings,
            route.userCategory as string,
            route.provider || scopedSessionIds
              ? {
                  provider: route.provider ?? undefined,
                  sessionIds: scopedSessionIds
                }
              : undefined
          )
        : fetchCategoryStats(
            settings as ExtensionSettings,
            route.category,
            route.provider || scopedSessionIds
              ? {
                  provider: route.provider ?? undefined,
                  sessionIds: scopedSessionIds
                }
              : undefined
          ),
    enabled: Boolean(settings && !status?.backendValidationError && (!scopedSessionIds || scopedSessionIds.length > 0))
  });

  const graphQuery = useQuery({
    queryKey: [
      "category-graph",
      settings?.backendUrl,
      settings?.backendToken,
      route.category,
      route.provider,
      route.userCategory,
      scopedSessionIds?.join("|") ?? "*"
    ],
    queryFn: () =>
      isCustomScope
        ? fetchCustomCategoryGraph(
            settings as ExtensionSettings,
            route.userCategory as string,
            route.provider || scopedSessionIds
              ? {
                  provider: route.provider ?? undefined,
                  sessionIds: scopedSessionIds
                }
              : undefined
          )
        : fetchCategoryGraph(
            settings as ExtensionSettings,
            route.category,
            route.provider || scopedSessionIds
              ? {
                  provider: route.provider ?? undefined,
                  sessionIds: scopedSessionIds
                }
              : undefined
          ),
    enabled: Boolean(settings && !status?.backendValidationError && (!scopedSessionIds || scopedSessionIds.length > 0))
  });

  const noteListItems = useMemo(() => {
    if (!graphFocus) {
      return visibleSessions;
    }
    const focusSet = new Set(graphFocus.sessionIds);
    return visibleSessions.filter((session) => focusSet.has(session.id));
  }, [graphFocus, visibleSessions]);

  useEffect(() => {
    if (route.note && noteListItems.some((session) => session.id === route.note)) {
      return;
    }

    const nextNoteId = noteListItems[0]?.id ?? null;
    if (nextNoteId !== route.note) {
      updateRoute({ note: nextNoteId }, false);
    }
  }, [noteListItems, route.note]);

  const selectedSessionId = route.note;
  const selectedSession = noteListItems.find((session) => session.id === selectedSessionId) ?? null;

  const noteQuery = useQuery({
    queryKey: ["category-note", settings?.backendUrl, settings?.backendToken, selectedSessionId],
    queryFn: () => fetchSessionNote(settings as ExtensionSettings, selectedSessionId as string),
    enabled: Boolean(settings && !status?.backendValidationError && selectedSessionId)
  });

  const todoQuery = useQuery({
    queryKey: ["category-todo", settings?.backendUrl, settings?.backendToken],
    queryFn: () => fetchTodoList(settings as ExtensionSettings),
    enabled: Boolean(settings && !status?.backendValidationError && !isCustomScope && route.category === "todo")
  });

  const stats =
    (scopedSessionIds && !visibleSessions.length) || (debouncedQuery.trim() && !visibleSessions.length)
      ? createEmptyStats(route.category)
      : statsQuery.data ?? createEmptyStats(route.category);
  const graph =
    (scopedSessionIds && !visibleSessions.length) || (debouncedQuery.trim() && !visibleSessions.length)
      ? createEmptyGraph(route.category)
      : graphQuery.data ?? createEmptyGraph(route.category);
  const todo = !isCustomScope && route.category === "todo" ? todoQuery.data ?? null : null;
  const activeDisplayCategory = graph.dominant_category ?? stats.dominant_category ?? route.category;
  const userCategories = userCategoriesQuery.data ?? [];

  const signals = signalGroups(stats);
  const providerPie = stats.provider_counts.map((item) => ({
    provider: item.provider,
    label: providerLabels[item.provider],
    count: item.count,
    color: providerColors[item.provider]
  }));
  const availableGraphProviders = useMemo(() => {
    const providers = new Set<ProviderName>();
    for (const node of graph.nodes) {
      if (node.provider) {
        providers.add(node.provider);
      }
    }
    return Array.from(providers).sort();
  }, [graph.nodes]);
  const availableGraphKinds = useMemo(() => {
    const kinds = new Set<string>();
    for (const node of graph.nodes) {
      if (node.kind) {
        kinds.add(node.kind);
      }
    }
    return Array.from(kinds).sort();
  }, [graph.nodes]);
  const filteredGraph = useMemo(() => {
    if (graphProviderFilter.size === 0 && graphKindFilter.size === 0) {
      return graph;
    }
    const nodes = graph.nodes.filter((node) => {
      const providerOk = graphProviderFilter.size === 0 || (node.provider ? graphProviderFilter.has(node.provider) : false);
      const kindOk = graphKindFilter.size === 0 || graphKindFilter.has(node.kind);
      return providerOk && kindOk;
    });
    const visibleIds = new Set(nodes.map((node) => node.id));
    const edges = graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
    return { ...graph, nodes, edges, node_count: nodes.length, edge_count: edges.length };
  }, [graph, graphProviderFilter, graphKindFilter]);
  const graphInsights = useMemo(
    () => buildCategoryGraphInsights(filteredGraph, visibleSessions, activeDisplayCategory, groupingMode),
    [activeDisplayCategory, filteredGraph, groupingMode, visibleSessions]
  );
  const graphNodeOptions = useMemo(
    () =>
      [...filteredGraph.nodes]
        .filter((node) => node.session_ids.length > 0)
        .sort((left, right) => graphNodeOptionScore(right) - graphNodeOptionScore(left) || left.label.localeCompare(right.label))
        .slice(0, 120),
    [filteredGraph.nodes]
  );
  const pathFilterOptions = route.provider || scopedSessionIds
    ? {
        provider: route.provider ?? undefined,
        sessionIds: scopedSessionIds
      }
    : undefined;
  const pathQuery = useQuery({
    queryKey: [
      "category-graph-path",
      settings?.backendUrl,
      settings?.backendToken,
      route.category,
      route.provider,
      route.userCategory,
      scopedSessionIds?.join("|") ?? "*",
      pathSourceId,
      pathTargetId
    ],
    queryFn: () =>
      isCustomScope
        ? fetchCustomCategoryGraphPath(
            settings as ExtensionSettings,
            route.userCategory as string,
            pathSourceId as string,
            pathTargetId as string,
            pathFilterOptions
          )
        : fetchCategoryGraphPath(
            settings as ExtensionSettings,
            route.category,
            pathSourceId as string,
            pathTargetId as string,
            pathFilterOptions
          ),
    enabled: Boolean(
      settings &&
        !status?.backendValidationError &&
        pathSourceId &&
        pathTargetId &&
        pathSourceId !== pathTargetId &&
        (!scopedSessionIds || scopedSessionIds.length > 0)
    )
  });
  const scopePills = [
    { key: "category", label: isCustomScope ? "Default base" : "Category", value: categoryLabels[activeDisplayCategory] },
    route.userCategory ? { key: "user-category", label: "Custom", value: route.userCategory } : null,
    route.provider ? { key: "provider", label: "Provider", value: providerLabels[route.provider] } : null,
    route.q ? { key: "query", label: "Query", value: route.q } : null,
    route.bucket ? { key: "bucket", label: "Time", value: formatBucketLabel(route.bucket) } : null,
    graphFocus ? { key: "focus", label: "Focus", value: graphFocus.label } : null
  ].filter((item): item is { key: string; label: string; value: string } => Boolean(item));
  const scopeSummary = scopePills.length
    ? scopePills.map((pill) => `${pill.label}: ${pill.value}`).join(" · ")
    : "Whole shelf";
  const providerFilterValue =
    graphProviderFilter.size === 0
      ? "__all__"
      : graphProviderFilter.size === 1
        ? Array.from(graphProviderFilter)[0]
        : "__mixed__";
  const kindFilterValue =
    graphKindFilter.size === 0
      ? "__all__"
      : graphKindFilter.size === 1
        ? Array.from(graphKindFilter)[0]
        : "__mixed__";

  function handleProviderFilterSelect(value: string): void {
    if (value === "__all__" || value === "__mixed__") {
      setGraphProviderFilter(new Set());
      return;
    }
    setGraphProviderFilter(new Set([value as ProviderName]));
  }

  function handleKindFilterSelect(value: string): void {
    if (value === "__all__" || value === "__mixed__") {
      setGraphKindFilter(new Set());
      return;
    }
    setGraphKindFilter(new Set([value]));
  }

  useEffect(() => {
    const allowedClusters = new Set(graphInsights.clusters.map((cluster) => cluster.id));
    setCollapsedGroups((current) => {
      const next = current.filter((clusterId) => allowedClusters.has(clusterId));
      return next.length === current.length && next.every((clusterId, index) => clusterId === current[index]) ? current : next;
    });
  }, [graphInsights.clusters]);

  useEffect(() => {
    setGraphInspect(null);
  }, [graph]);

  useEffect(() => {
    if (!graphNodeOptions.length) {
      if (pathSourceId) {
        setPathSourceId(null);
      }
      if (pathTargetId) {
        setPathTargetId(null);
      }
      return;
    }

    const allowedIds = new Set(graphNodeOptions.map((node) => node.id));
    const nextSourceId = pathSourceId && allowedIds.has(pathSourceId) ? pathSourceId : graphNodeOptions[0]?.id ?? null;
    const nextTargetId =
      pathTargetId && allowedIds.has(pathTargetId) && pathTargetId !== nextSourceId
        ? pathTargetId
        : graphNodeOptions.find((node) => node.id !== nextSourceId)?.id ?? null;

    if (nextSourceId !== pathSourceId) {
      setPathSourceId(nextSourceId);
    }
    if (nextTargetId !== pathTargetId) {
      setPathTargetId(nextTargetId);
    }
  }, [graphNodeOptions, pathSourceId, pathTargetId]);

  function handleCategorySwitch(category: SessionCategoryName): void {
    setGraphFocus(null);
    setGraphInspect(null);
    setCollapsedGroups([]);
    updateRoute({ category, note: null, bucket: null, view: "atlas", userCategory: null }, true);
  }

  function handleUserCategorySwitch(name: string): void {
    setGraphFocus(null);
    setGraphInspect(null);
    setCollapsedGroups([]);
    updateRoute({ userCategory: name, note: null, bucket: null, view: "atlas" }, true);
  }

  function activateFocus(label: string, sessionIds: string[], nextView?: CategoryWorkspaceView): void {
    setGraphInspect(null);
    setGraphFocus({ label, sessionIds });
    const nextId = visibleSessions.find((item) => sessionIds.includes(item.id))?.id ?? sessionIds[0] ?? null;
    updateRoute({ note: nextId, view: nextView ?? route.view }, false);
  }

  function handleFocus(label: string, sessionIds: string[]): void {
    activateFocus(label, sessionIds);
  }

  function handleBucketToggle(bucket: string): void {
    setGraphFocus(null);
    setGraphInspect(null);
    updateRoute({ bucket: route.bucket === bucket ? null : bucket, note: null }, true);
  }

  function clearScope(): void {
    setGraphFocus(null);
    setGraphInspect(null);
    setCollapsedGroups([]);
    updateRoute({ q: "", provider: null, sort: "recent", bucket: null, note: null, view: "atlas", userCategory: null }, true);
  }

  function handlePathFocus(path: BackendExplorerGraphPath): void {
    const labels = path.nodes.map((node) => node.label).filter(Boolean);
    const sessionIds = Array.from(
      new Set([
        ...path.evidence_session_ids,
        ...path.nodes.flatMap((node) => node.session_ids),
        ...path.edges.flatMap((edge) => edge.session_ids)
      ])
    );
    activateFocus(`Path: ${labels.join(" -> ")}`, sessionIds, "atlas");
  }

  const workspaceCards = [
    {
      value: "atlas" as const,
      label: "Atlas",
      accent: categoryPalette[activeDisplayCategory].accent,
      icon: BrainCircuit,
      metric: `${formatNumber(filteredGraph.node_count)} nodes`,
      detail: `${formatNumber(filteredGraph.edge_count)} links`
    },
    {
      value: "story" as const,
      label: "Storylines",
      accent: "#c77724",
      icon: Sparkles,
      metric: `${formatNumber(graphInsights.storylines.length)} trails`,
      detail: `${formatNumber(graphInsights.corroboratedNodes)} corroborated nodes`
    },
    {
      value: "ops" as const,
      label: "Graph Ops",
      accent: "#2477c7",
      icon: Workflow,
      metric: `${formatPercent(graphInsights.sessionCoverage * 100)}% coverage`,
      detail: graphInsights.warnings.length ? `${graphInsights.warnings.length} lint signals` : "Scope is connected"
    }
  ];

  async function persistTodoItems(nextItems: BackendTodoItem[], summary: string): Promise<void> {
    if (!settings || route.category !== "todo") {
      return;
    }

    setTodoActionError(null);
    setTodoSavingSummary(summary);
    try {
      await updateTodoList(settings as ExtensionSettings, {
        items: nextItems,
        summary
      });
      setTodoDraft("");
      await todoQuery.refetch();
    } catch (todoError) {
      setTodoActionError(todoError instanceof Error ? todoError.message : "Could not update the shared checklist.");
    } finally {
      setTodoSavingSummary(null);
    }
  }

  async function handleTodoAdd(): Promise<void> {
    const text = todoDraft.trim();
    if (!text || !todo) {
      return;
    }

    const nextItems = [...todo.items.filter((item) => item.text.toLowerCase() !== text.toLowerCase()), { text, done: false }];
    await persistTodoItems(nextItems, `Add task: ${text}`);
  }

  async function handleTodoToggle(item: BackendTodoItem, done: boolean): Promise<void> {
    if (!todo) {
      return;
    }

    const nextItems = todo.items.map((current) => (current.text === item.text ? { ...current, done } : current));
    await persistTodoItems(nextItems, done ? `Check off: ${item.text}` : `Reopen: ${item.text}`);
  }

  async function updateSelectedSessionUserCategories(nextCategories: string[]): Promise<void> {
    if (!settings || !selectedSession) {
      return;
    }

    setUserCategoryError(null);
    try {
      await updateSessionUserCategories(settings as ExtensionSettings, selectedSession.id, nextCategories);
      setUserCategoryDraft("");
      await Promise.all([sessionsQuery.refetch(), noteQuery.refetch(), userCategoriesQuery.refetch()]);
    } catch (categoryError) {
      setUserCategoryError(categoryError instanceof Error ? categoryError.message : "Could not update custom categories.");
    }
  }

  async function handleAddUserCategory(name: string): Promise<void> {
    const cleaned = name.trim();
    if (!cleaned || !selectedSession) {
      return;
    }
    const nextCategories = Array.from(new Set([...(selectedSession.user_categories ?? []), cleaned]));
    await updateSelectedSessionUserCategories(nextCategories);
    handleUserCategorySwitch(cleaned);
  }

  async function handleRemoveUserCategory(name: string): Promise<void> {
    if (!selectedSession) {
      return;
    }
    const nextCategories = (selectedSession.user_categories ?? []).filter((value) => value !== name);
    await updateSelectedSessionUserCategories(nextCategories);
    if (route.userCategory === name) {
      updateRoute({ userCategory: null }, true);
    }
  }

  const isTodoWorkspace = !isCustomScope && route.category === "todo";
  const workspaceTitle = isTodoWorkspace
    ? "Shared list workspace"
    : activeDisplayCategory === "factual"
      ? "Knowledge graph workspace"
      : "Context workspace";
  const workspaceDescription = isTodoWorkspace
    ? "Check tasks off, review git-backed list history, and keep note evidence close to the shared checklist."
    : isCustomScope
      ? "This view follows one user-defined category while preserving the underlying note and graph structure."
      : "Start with the atlas. Storylines and graph ops are supporting views.";

  const headerMetrics =
    isTodoWorkspace
      ? [
          { label: "Shared tasks", value: formatNumber(todo?.total_count), icon: Database },
          { label: "Active", value: formatNumber(todo?.active_count), icon: Workflow },
          { label: "Completed", value: formatNumber(todo?.completed_count), icon: Activity },
          { label: "Last updated", value: formatCompactDate(stats.latest_updated_at, "No data"), icon: Activity }
        ]
      : [
          { label: "Notes in scope", value: formatNumber(visibleSessions.length), icon: Database },
          {
            label: activeDisplayCategory === "factual" ? "Facts" : "Messages",
            value: activeDisplayCategory === "factual" ? formatNumber(stats.total_triplets) : formatNumber(stats.total_messages),
            icon: activeDisplayCategory === "factual" ? BrainCircuit : Activity
          },
          {
            label: "Graph coverage",
            value: `${formatPercent(graphInsights.sessionCoverage * 100)}%`,
            icon: Workflow
          },
          {
            label: "Last updated",
            value: formatCompactDate(stats.latest_updated_at, "No data"),
            icon: Activity
          }
        ];
  const maxActivityBucketCount = Math.max(...activityBuckets.map((bucket) => bucket.count), 1);

  return (
    <div className="app-page app-page--wide flex min-h-screen w-full flex-col gap-3">
      <Card className="px-4 py-2.5">
        <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-5 gap-y-2">
          <div className="flex items-center gap-3">
            <span
              className="display-serif flex h-8 w-8 items-center justify-center rounded-[8px] text-[15px]"
              style={{
                backgroundColor: `${categoryPalette[activeDisplayCategory].accent}1a`,
                color: categoryPalette[activeDisplayCategory].accent
              }}
            >
              {isCustomScope ? "⌘" : (categoryGlyphs as Record<string, string>)[activeDisplayCategory] ?? "§"}
            </span>
            <div className="min-w-0">
              <div className="eyebrow text-[10px]">{isCustomScope ? "Custom shelf" : "Shelf"}</div>
              <CardTitle className="display-serif truncate text-[19px] font-semibold leading-tight">
                {isCustomScope ? route.userCategory : categoryLabels[route.category]}
              </CardTitle>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {headerMetrics.map((metric) => (
              <div key={metric.label} className="flex items-center gap-2">
                <metric.icon className="h-3.5 w-3.5 text-[var(--color-ink-subtle)]" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-soft)]">{metric.label}</span>
                <span className="text-sm font-semibold text-[var(--color-ink)]">{metric.value}</span>
              </div>
            ))}
          </div>

          <Button variant="ghost" size="sm" onClick={() => (window.location.href = chrome.runtime.getURL("dashboard.html"))}>
            <ArrowLeft className="h-3.5 w-3.5" />
            Overview
          </Button>
        </div>
      </Card>

      <div className="grid min-h-0 gap-3 xl:min-h-[calc(100vh-6.25rem)] xl:grid-cols-[208px_minmax(0,1fr)]">
        <aside className="min-w-0 self-start">
          <Card className="p-2.5">
            <CardHeader className="gap-2">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-soft)]">Explorer</div>
                <CardTitle className="mt-0.5 text-base">Collections</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="mt-2 space-y-2.5">
              <div className="grid gap-0.5">
                {categoryOrder.map((category) => {
                  const active = !isCustomScope && route.category === category;
                  const accent = categoryPalette[category].accent;
                  return (
                    <button
                      key={category}
                      type="button"
                      onClick={() => handleCategorySwitch(category)}
                      className={`group flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-left transition ${
                        active
                          ? "bg-[var(--color-ink)] text-white"
                          : "hover:bg-[var(--color-paper-sunken)]"
                      }`}
                    >
                      <span
                        className="display-serif flex h-6 w-6 shrink-0 items-center justify-center rounded-[8px] text-[12px] leading-none"
                        style={{
                          backgroundColor: active ? "rgba(255,255,255,0.14)" : `${accent}1a`,
                          color: active ? "#ffffff" : accent
                        }}
                      >
                        {categoryGlyphs[category]}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">{categoryLabels[category]}</span>
                    </button>
                  );
                })}
              </div>

              <div className="space-y-1.5 border-t border-[var(--color-line)] pt-2.5">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">Custom categories</div>
                </div>

                <Select
                  value={route.userCategory ?? "__default__"}
                  onValueChange={(value) => {
                    setGraphFocus(null);
                    setGraphInspect(null);
                    setCollapsedGroups([]);
                    if (value === "__default__") {
                      updateRoute({ userCategory: null, note: null, bucket: null, view: "atlas" }, true);
                    } else {
                      handleUserCategorySwitch(value);
                    }
                  }}
                  disabled={!userCategories.length}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Custom category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__" className="py-1.5 text-xs">Default category</SelectItem>
                    {userCategories.map((item) => (
                      <SelectItem key={item.name} value={item.name} className="py-1.5 text-xs">
                        {item.name} · {formatNumber(item.count)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!userCategories.length ? <p className="text-xs leading-5 text-[var(--color-ink-soft)]">Assign a note to create one.</p> : null}

                <form
                  className="flex gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleAddUserCategory(userCategoryDraft);
                  }}
                >
                  <input
                    type="text"
                    value={userCategoryDraft}
                    onChange={(event) => setUserCategoryDraft(event.target.value)}
                    placeholder={selectedSession ? "New category" : "Select a note first"}
                    className="h-8 min-w-0 flex-1 rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-2 text-xs outline-none transition focus:border-[var(--color-line-strong)]"
                  />
                  <Button type="submit" size="sm" variant="secondary" className="h-8 shrink-0 px-2 text-xs" disabled={!selectedSession || !userCategoryDraft.trim()}>
                    Add
                  </Button>
                </form>
              </div>

              <div className="space-y-1.5 border-t border-[var(--color-line)] pt-2.5">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">Scope</div>

                <label className="block">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-subtle)]" />
                    <input
                      type="search"
                      value={route.q}
                      onChange={(event) => {
                        setGraphFocus(null);
                        setGraphInspect(null);
                        updateRoute({ q: event.target.value, note: null }, true);
                      }}
                      placeholder="Search notes"
                      className="h-8 w-full rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] pl-8 pr-2 text-xs outline-none transition focus:border-[var(--color-line-strong)]"
                    />
                  </div>
                </label>

                {signals.primary.length ? (
                  <Select
                    value={signals.primary.some((item) => item.label === route.q) ? route.q : "__suggestion__"}
                    onValueChange={(value) => {
                      if (value === "__suggestion__") {
                        return;
                      }
                      updateRoute({ q: value, note: null, view: "atlas" }, true);
                      setGraphFocus(null);
                      setGraphInspect(null);
                    }}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__suggestion__" className="py-1.5 text-xs">Suggested scope</SelectItem>
                      {signals.primary.slice(0, 6).map((item) => (
                        <SelectItem key={item.label} value={item.label} className="py-1.5 text-xs">
                          {item.label} · {formatNumber(item.count)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}

                <div className="grid gap-1.5">
                  <div>
                    <Select
                      value={route.provider ?? "__all__"}
                      onValueChange={(value) => {
                        setGraphFocus(null);
                        setGraphInspect(null);
                        updateRoute({ provider: value === "__all__" ? null : (value as ProviderName), note: null }, true);
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__all__" className="py-1.5 text-xs">All providers</SelectItem>
                        <SelectItem value="chatgpt" className="py-1.5 text-xs">ChatGPT</SelectItem>
                        <SelectItem value="gemini" className="py-1.5 text-xs">Gemini</SelectItem>
                        <SelectItem value="grok" className="py-1.5 text-xs">Grok</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Select value={route.sort} onValueChange={(value) => updateRoute({ sort: value as CategorySortMode }, true)}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="recent" className="py-1.5 text-xs">Most recent</SelectItem>
                        <SelectItem value="title" className="py-1.5 text-xs">Title</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="secondary" className="h-8 px-2.5 text-xs" onClick={clearScope}>
                    Clear scope
                  </Button>
                  {graphFocus ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setGraphFocus(null);
                        setGraphInspect(null);
                      }}
                      className="h-8 px-2.5 text-xs"
                    >
                      Clear focus
                    </Button>
                  ) : null}
                </div>
              </div>

            </CardContent>
          </Card>
        </aside>

        <div className="min-h-0 xl:h-[calc(100vh-6.25rem)]">
          <Card className="flex min-h-0 flex-col overflow-hidden p-2.5 sm:p-3 xl:h-full">
            <CardHeader className="flex-wrap items-center gap-2">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-soft)]">Workspace</div>
                <CardTitle className="mt-0.5 text-base">{workspaceTitle}</CardTitle>
                <CardDescription className="line-clamp-1 text-xs leading-5 xl:hidden">{workspaceDescription}</CardDescription>
              </div>
              {!isTodoWorkspace ? (
                <div className="inline-grid w-full shrink-0 grid-cols-3 rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-1 sm:w-auto">
                  {workspaceCards.map((card) => {
                    const active = route.view === card.value;
                    return (
                      <button
                        key={card.value}
                        type="button"
                        onClick={() => updateRoute({ view: card.value }, true)}
                        className={`min-w-0 rounded-[6px] px-2 py-1.5 text-left outline-none transition sm:px-2.5 ${
                          active ? "bg-[var(--color-paper-raised)] text-[var(--color-ink)] shadow-sm" : "text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <card.icon className="h-3.5 w-3.5 shrink-0" style={{ color: card.accent }} />
                          <span className="truncate text-xs font-semibold">{card.label}</span>
                          <span className="hidden truncate text-[11px] lg:inline">{card.metric}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </CardHeader>

            <CardContent className="mt-2 flex min-h-0 flex-1 flex-col">
              {isTodoWorkspace ? (
                <TodoWorkspace
                  todo={todo}
                  loading={todoQuery.isLoading}
                  error={todoActionError || (todoQuery.error instanceof Error ? todoQuery.error.message : null)}
                  savingSummary={todoSavingSummary}
                  taskUpdateCount={stats.notes_with_todo_summary}
                  draft={todoDraft}
                  onDraftChange={setTodoDraft}
                  onAddTask={() => void handleTodoAdd()}
                  onToggleTask={(item, done) => void handleTodoToggle(item, done)}
                />
              ) : (
                <Tabs.Root className="flex min-h-0 flex-1 flex-col" value={route.view} onValueChange={(value) => updateRoute({ view: value as CategoryWorkspaceView }, true)}>
                <Tabs.Content value="atlas" className="min-h-0 flex-1 outline-none">
                  <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-2">
                    <div className="workspace-control-bar">
                      <div className="workspace-control-group">
                        <span className="workspace-control-label">Map</span>
                        <span className="workspace-scope-chip">{scopeSummary}</span>
                      </div>

                      <div className="workspace-control-group flex-wrap justify-end xl:flex-nowrap">
                        <span className="workspace-control-label">Group</span>
                        <Button
                          size="sm"
                          variant={groupingMode === "community" ? "primary" : "secondary"}
                          onClick={() => setGroupingMode("community")}
                          className="h-7 px-2 text-[11px]"
                        >
                          Topic
                        </Button>
                        <Button
                          size="sm"
                          variant={groupingMode === "provider" ? "primary" : "secondary"}
                          onClick={() => setGroupingMode("provider")}
                          className="h-7 px-2 text-[11px]"
                        >
                          Provider
                        </Button>
                        <Button
                          size="sm"
                          variant={groupingMode === "kind" ? "primary" : "secondary"}
                          onClick={() => setGroupingMode("kind")}
                          className="h-7 px-2 text-[11px]"
                        >
                          Type
                        </Button>

                        {graphInsights.clusters.length ? (
                          <Select
                            value="__semantic_groups__"
                            onValueChange={(value) => {
                              if (value === "__semantic_groups__") {
                                return;
                              }
                              if (value === "__all_groups__") {
                                setCollapsedGroups([]);
                                setGraphFocus(null);
                                setGraphInspect(null);
                                return;
                              }
                              const cluster = graphInsights.clusters.find((item) => item.id === value);
                              if (cluster) {
                                activateFocus(cluster.label, cluster.sessionIds, "atlas");
                              }
                            }}
                          >
                            <SelectTrigger className="h-7 w-[138px] px-2 text-[11px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__semantic_groups__" className="py-1.5 text-xs">Semantic group</SelectItem>
                              <SelectItem value="__all_groups__" className="py-1.5 text-xs">All groups</SelectItem>
                              {graphInsights.clusters.slice(0, 12).map((cluster) => (
                                <SelectItem key={cluster.id} value={cluster.id} className="py-1.5 text-xs">
                                  {cluster.label} · {formatNumber(cluster.nodeCount)} nodes
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : null}

                        {availableGraphProviders.length ? (
                          <Select value={providerFilterValue} onValueChange={handleProviderFilterSelect}>
                            <SelectTrigger className="h-7 w-[104px] px-2 text-[11px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__all__" className="py-1.5 text-xs">All sources</SelectItem>
                              {providerFilterValue === "__mixed__" ? (
                                <SelectItem value="__mixed__" className="py-1.5 text-xs">Mixed sources</SelectItem>
                              ) : null}
                              {availableGraphProviders.map((provider) => (
                                <SelectItem key={provider} value={provider} className="py-1.5 text-xs">
                                  {providerLabels[provider]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : null}

                        {availableGraphKinds.length ? (
                          <Select value={kindFilterValue} onValueChange={handleKindFilterSelect}>
                            <SelectTrigger className="h-7 w-[112px] px-2 text-[11px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__all__" className="py-1.5 text-xs">
                                All {categoryLabels[activeDisplayCategory].toLowerCase()}
                              </SelectItem>
                              {kindFilterValue === "__mixed__" ? (
                                <SelectItem value="__mixed__" className="py-1.5 text-xs">Mixed types</SelectItem>
                              ) : null}
                              {availableGraphKinds.map((kind) => (
                                <SelectItem key={kind} value={kind} className="py-1.5 text-xs">
                                  {kind}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : null}

                        <span className="workspace-control-label">View</span>
                        <Button
                          size="sm"
                          variant={graphDensity === "curated" ? "primary" : "secondary"}
                          onClick={() => setGraphDensity((current) => (current === "curated" ? "complete" : "curated"))}
                          className="h-7 px-2 text-[11px]"
                        >
                          {graphDensity === "curated" ? "Clean" : "Full"}
                        </Button>
                        {graphFocus ? (
                          <Button
                            size="sm"
                            variant={graphFocusMode === "context" ? "primary" : "secondary"}
                            onClick={() => setGraphFocusMode((current) => (current === "context" ? "dim" : "context"))}
                            className="h-7 px-2 text-[11px]"
                          >
                            {graphFocusMode === "context" ? "Context" : "Dim"}
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setCollapsedGroups(graphInsights.clusters.map((cluster) => cluster.id))}
                          disabled={!graphInsights.clusters.length}
                          className="h-7 px-2 text-[11px]"
                        >
                          Collapse
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setCollapsedGroups([])} disabled={!collapsedGroups.length} className="h-7 px-2 text-[11px]">
                          Expand
                        </Button>
                        {graphFocus ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setGraphFocus(null);
                              setGraphInspect(null);
                            }}
                            className="h-7 px-2 text-[11px]"
                          >
                            Clear focus
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    <div className="grid min-h-0 gap-2 xl:grid-cols-[minmax(0,1fr)_264px]">
                      <div className="flex min-h-0 flex-col">
                        <CategoryGraph
                          graph={filteredGraph}
                          category={activeDisplayCategory}
                          groupingMode={groupingMode}
                          collapsedGroups={collapsedGroups}
                          density={graphDensity}
                          focusMode={graphFocusMode}
                          focusSessionIds={graphFocus?.sessionIds}
                          className="h-full min-h-[340px] flex-1 xl:min-h-0"
                          onFocus={handleFocus}
                          onInspect={setGraphInspect}
                        />
                    </div>

                    <div className="min-h-0 space-y-2">
                      <GraphEvidencePanel graph={graph} selection={graphInspect} onClear={() => setGraphInspect(null)} />

                      <GraphPathPanel
                        nodes={graphNodeOptions}
                        sourceId={pathSourceId}
                        targetId={pathTargetId}
                        path={pathQuery.data ?? null}
                        loading={pathQuery.isFetching}
                        error={pathQuery.error instanceof Error ? pathQuery.error : null}
                        onSourceChange={(nodeId) => {
                          setPathSourceId(nodeId);
                          if (nodeId === pathTargetId) {
                            setPathTargetId(graphNodeOptions.find((node) => node.id !== nodeId)?.id ?? null);
                          }
                        }}
                        onTargetChange={(nodeId) => {
                          setPathTargetId(nodeId);
                          if (nodeId === pathSourceId) {
                            setPathSourceId(graphNodeOptions.find((node) => node.id !== nodeId)?.id ?? null);
                          }
                        }}
                        onFocusPath={handlePathFocus}
                      />
                    </div>
                    </div>
                  </div>
                </Tabs.Content>

                <Tabs.Content value="story" className="min-h-0 flex-1 outline-none">
                  <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-2">
                    <div className="workspace-control-bar">
                      <div className="workspace-control-group">
                        <span className="workspace-control-label">Story</span>
                        <span className="workspace-scope-chip">{scopeSummary}</span>
                      </div>
                      <div className="workspace-control-group flex-wrap justify-end xl:flex-nowrap">
                        <span className="workspace-control-label">Group</span>
                        <Button
                          size="sm"
                          variant={groupingMode === "community" ? "primary" : "secondary"}
                          onClick={() => setGroupingMode("community")}
                          className="h-7 px-2 text-[11px]"
                        >
                          Topic
                        </Button>
                        <Button
                          size="sm"
                          variant={groupingMode === "provider" ? "primary" : "secondary"}
                          onClick={() => setGroupingMode("provider")}
                          className="h-7 px-2 text-[11px]"
                        >
                          Provider
                        </Button>
                        <Button
                          size="sm"
                          variant={groupingMode === "kind" ? "primary" : "secondary"}
                          onClick={() => setGroupingMode("kind")}
                          className="h-7 px-2 text-[11px]"
                        >
                          Type
                        </Button>
                        {graphFocus ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setGraphFocus(null);
                              setGraphInspect(null);
                            }}
                            className="h-7 px-2 text-[11px]"
                          >
                            Clear focus
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    <div className="grid min-h-0 gap-2 xl:grid-cols-[minmax(0,1fr)_300px]">
                    <div className="grid gap-2 md:grid-cols-2">
                      {graphInsights.storylines.slice(0, 6).map((storyline) => (
                        <button
                          key={storyline.id}
                          type="button"
                          onClick={() => activateFocus(storyline.label, storyline.sessionIds, "atlas")}
                          className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-3 text-left transition hover:border-[var(--color-line-strong)] hover:bg-[var(--color-paper-raised)]"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-soft)]">{storyline.clusterLabel}</div>
                              <div className="mt-1 truncate text-base font-semibold text-[var(--color-ink)]">{storyline.label}</div>
                            </div>
                            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: storyline.accent }} />
                          </div>

                          <p className="mt-2 line-clamp-2 text-sm leading-5 text-[var(--color-ink-soft)]">{storyline.summary}</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Badge tone="neutral">{formatNumber(storyline.noteCount)} notes</Badge>
                            <Badge tone="neutral">{formatNumber(storyline.degree)} links</Badge>
                          </div>
                          <div className="mt-2 text-xs uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">
                            Updated {formatCompactDate(storyline.lastUpdated, "No recent change")}
                          </div>
                        </button>
                      ))}
                      {!graphInsights.storylines.length ? (
                        <div className="rounded-[8px] border border-dashed border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-4 text-sm text-[var(--color-ink-soft)] md:col-span-2">
                          No storylines are available in this scope yet.
                        </div>
                      ) : null}
                    </div>

                    <div className="space-y-2">
                      <div className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-3">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-soft)]">Dense nodes</div>
                        <div className="mt-1 text-base font-semibold text-[var(--color-ink)]">High-traffic concepts</div>
                        <div className="mt-2 space-y-1.5">
                          {graphInsights.denseNodes.slice(0, 5).map((node) => (
                            <button
                              key={node.id}
                              type="button"
                              onClick={() => activateFocus(node.label, node.sessionIds, "atlas")}
                              className="flex w-full items-center justify-between gap-3 rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-2 py-2 text-left transition hover:bg-[var(--color-paper-sunken)]"
                            >
                              <div className="min-w-0">
                                <div className="truncate text-sm font-semibold text-[var(--color-ink)]">{node.label}</div>
                                <div className="mt-1 text-xs uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">
                                  {formatNumber(node.degree)} links · {formatNumber(node.noteCount)} notes
                                </div>
                              </div>
                              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: node.accent }} />
                            </button>
                          ))}
                          {!graphInsights.denseNodes.length ? <p className="text-sm text-[var(--color-ink-soft)]">No dense nodes in this scope yet.</p> : null}
                        </div>
                      </div>
                    </div>
                    </div>
                  </div>
                </Tabs.Content>

                <Tabs.Content value="ops" className="min-h-0 flex-1 outline-none">
                  <div className="grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-2">
                    <div className="workspace-control-bar">
                      <div className="workspace-control-group">
                        <span className="workspace-control-label">Ops</span>
                        <span className="workspace-scope-chip">{scopeSummary}</span>
                      </div>
                      <div className="workspace-control-group flex-wrap justify-end xl:flex-nowrap">
                        <span className="workspace-control-label">Group</span>
                        <Button
                          size="sm"
                          variant={groupingMode === "community" ? "primary" : "secondary"}
                          onClick={() => setGroupingMode("community")}
                          className="h-7 px-2 text-[11px]"
                        >
                          Topic
                        </Button>
                        <Button
                          size="sm"
                          variant={groupingMode === "provider" ? "primary" : "secondary"}
                          onClick={() => setGroupingMode("provider")}
                          className="h-7 px-2 text-[11px]"
                        >
                          Provider
                        </Button>
                        <Button
                          size="sm"
                          variant={groupingMode === "kind" ? "primary" : "secondary"}
                          onClick={() => setGroupingMode("kind")}
                          className="h-7 px-2 text-[11px]"
                        >
                          Type
                        </Button>
                        {availableGraphProviders.length ? (
                          <Select value={providerFilterValue} onValueChange={handleProviderFilterSelect}>
                            <SelectTrigger className="h-7 w-[104px] px-2 text-[11px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__all__" className="py-1.5 text-xs">All sources</SelectItem>
                              {providerFilterValue === "__mixed__" ? (
                                <SelectItem value="__mixed__" className="py-1.5 text-xs">Mixed sources</SelectItem>
                              ) : null}
                              {availableGraphProviders.map((provider) => (
                                <SelectItem key={provider} value={provider} className="py-1.5 text-xs">
                                  {providerLabels[provider]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : null}
                        {availableGraphKinds.length ? (
                          <Select value={kindFilterValue} onValueChange={handleKindFilterSelect}>
                            <SelectTrigger className="h-7 w-[112px] px-2 text-[11px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__all__" className="py-1.5 text-xs">
                                All {categoryLabels[activeDisplayCategory].toLowerCase()}
                              </SelectItem>
                              {kindFilterValue === "__mixed__" ? (
                                <SelectItem value="__mixed__" className="py-1.5 text-xs">Mixed types</SelectItem>
                              ) : null}
                              {availableGraphKinds.map((kind) => (
                                <SelectItem key={kind} value={kind} className="py-1.5 text-xs">
                                  {kind}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : null}
                      </div>
                    </div>

                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                      {[
                        { label: "Coverage", value: `${formatPercent(graphInsights.sessionCoverage * 100)}%`, detail: `${formatNumber(graphInsights.graphSessionIds.length)} linked notes` },
                        { label: "Corroborated", value: formatNumber(graphInsights.corroboratedNodes), detail: "Shared nodes" },
                        { label: "Orphans", value: formatNumber(graphInsights.orphanNodes), detail: "Disconnected" },
                        {
                          label: "Clusters",
                          value: formatNumber(graphInsights.clusters.length),
                          detail: `${groupingMode === "community" ? "Topic" : groupingMode === "provider" ? "Provider" : "Type"} groups`
                        }
                      ].map((metric) => (
                        <div key={metric.label} className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-2.5">
                          <div className="flex items-baseline justify-between gap-2">
                            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">{metric.label}</div>
                            <div className="text-xl font-semibold text-[var(--color-ink)]">{metric.value}</div>
                          </div>
                          <div className="mt-1 truncate text-xs text-[var(--color-ink-soft)]">{metric.detail}</div>
                        </div>
                      ))}
                    </div>

                    <div className="grid min-h-0 gap-2 xl:grid-cols-[1.1fr_0.9fr]">
                      <div className="grid min-h-0 gap-2 xl:grid-rows-[minmax(0,1fr)_auto]">
                        <div className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-2.5">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <div>
                              <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-soft)]">Graph hygiene</div>
                              <div className="text-sm font-semibold text-[var(--color-ink)]">Maintenance cues</div>
                            </div>
                            <Badge tone={graphInsights.warnings.length ? "warning" : "success"}>
                              {graphInsights.warnings.length ? `${graphInsights.warnings.length} signals` : "Healthy"}
                            </Badge>
                          </div>

                          <div className="space-y-1.5">
                            {graphInsights.warnings.slice(0, 3).map((warning) => (
                              <div key={warning.id} className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-2">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="truncate text-sm font-semibold text-[var(--color-ink)]">{warning.label}</div>
                                    <div className="mt-0.5 line-clamp-1 text-xs leading-5 text-[var(--color-ink-soft)]">{warning.detail}</div>
                                  </div>
                                  <Badge tone={warning.tone === "warning" ? "warning" : warning.tone === "danger" ? "danger" : "info"}>
                                    {warning.tone}
                                  </Badge>
                                </div>
                                {warning.sessionIds?.length ? (
                                  <div className="mt-1.5">
                                    <Button size="sm" variant="secondary" className="h-7 px-2 text-[11px]" onClick={() => activateFocus(warning.label, warning.sessionIds ?? [], "atlas")}>
                                      Inspect
                                    </Button>
                                  </div>
                                ) : null}
                              </div>
                            ))}

                            {!graphInsights.warnings.length ? (
                              <div className="rounded-[8px] border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-800">
                                The current scope is connected enough to inspect clusters and storylines.
                              </div>
                            ) : null}
                          </div>
                        </div>

                        <div className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-2.5">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-soft)]">Query surface</div>
                            <Badge tone="neutral">{formatNumber(visibleSessions.length)} notes</Badge>
                          </div>
                          <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-4">
                            {[
                              { label: "Avg weight", value: graphInsights.averageEdgeWeight.toFixed(1) },
                              { label: "Nodes/note", value: graphInsights.averageNodesPerSession.toFixed(1) },
                              { label: "Single source", value: formatNumber(graphInsights.singleSourceNodes) },
                              { label: "Uncovered", value: formatNumber(graphInsights.uncoveredSessions) }
                            ].map((metric) => (
                              <div key={metric.label} className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-2 py-1.5">
                                <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">{metric.label}</div>
                                <div className="mt-0.5 text-sm font-semibold text-[var(--color-ink)]">{metric.value}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="grid min-h-0 gap-2 xl:grid-rows-[auto_minmax(0,1fr)]">
                        <div className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-2.5">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <div>
                              <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-soft)]">Provider mix</div>
                              <div className="text-sm font-semibold text-[var(--color-ink)]">Evidence by source</div>
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            {providerPie.map((item) => {
                              const maxCount = Math.max(...providerPie.map((provider) => provider.count), 1);
                              return (
                                <div key={item.provider} className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-2 py-1.5">
                                  <div className="flex items-center justify-between gap-3">
                                    <div className="text-xs font-medium text-[var(--color-ink)]">{item.label}</div>
                                    <div className="text-xs font-semibold text-[var(--color-ink)]">{formatNumber(item.count)}</div>
                                  </div>
                                  <div className="mt-1.5 h-1.5 rounded-full bg-[var(--color-paper-sunken)]">
                                    <div
                                      className="h-full rounded-full"
                                      style={{
                                        width: `${(item.count / maxCount) * 100}%`,
                                        backgroundColor: item.color
                                      }}
                                    />
                                  </div>
                                </div>
                              );
                            })}
                            {!providerPie.length ? <p className="text-sm text-[var(--color-ink-soft)]">No provider evidence in this scope yet.</p> : null}
                          </div>
                        </div>

                        <div className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-2.5">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <div>
                              <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-soft)]">Top signals</div>
                              <div className="text-sm font-semibold text-[var(--color-ink)]">Repeated labels</div>
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            {signals.primary.slice(0, 5).map((item) => (
                              <button
                                key={item.label}
                                type="button"
                                onClick={() => {
                                  setGraphFocus(null);
                                  setGraphInspect(null);
                                  updateRoute({ q: item.label, view: "atlas", note: null }, true);
                                }}
                                className="flex w-full items-center justify-between gap-2 rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-2 py-1.5 text-left transition hover:bg-[var(--color-paper-sunken)]"
                              >
                                <span className="truncate text-xs font-medium text-[var(--color-ink)]">{item.label}</span>
                                <span className="text-xs font-semibold text-[var(--color-ink)]">{formatNumber(item.count)}</span>
                              </button>
                            ))}
                            {!signals.primary.length ? <p className="text-sm text-[var(--color-ink-soft)]">No repeated labels yet.</p> : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </Tabs.Content>
                </Tabs.Root>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[260px_340px_minmax(0,1fr)]">
            <Card className="overflow-hidden p-3">
              <CardHeader className="items-center gap-2">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-soft)]">Activity</div>
                  <CardTitle className="mt-0.5 text-base">Recent activity</CardTitle>
                </div>
                {route.bucket ? <Badge tone="info">{formatBucketLabel(route.bucket)}</Badge> : null}
              </CardHeader>
              <CardContent className="mt-2">
                <div className="space-y-1.5">
                  {activityBuckets.slice(-6).map((bucket) => {
                    const active = route.bucket === bucket.bucket;
                    return (
                      <button
                        key={bucket.bucket}
                        type="button"
                        onClick={() => handleBucketToggle(bucket.bucket)}
                        className={`w-full rounded-[8px] border px-2 py-1.5 text-left transition ${
                          active
                            ? "border-[var(--color-ink)] bg-[var(--color-ink)] text-white"
                            : "border-[var(--color-line)] bg-[var(--color-paper-raised)] hover:bg-[var(--color-paper-sunken)]"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold">{bucket.label}</span>
                          <span className={active ? "text-xs text-white/75" : "text-xs text-[var(--color-ink-soft)]"}>{formatNumber(bucket.count)}</span>
                        </div>
                        <div className={active ? "mt-1.5 h-1.5 rounded-full bg-white/20" : "mt-1.5 h-1.5 rounded-full bg-[var(--color-paper-sunken)]"}>
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${(bucket.count / maxActivityBucketCount) * 100}%`,
                              backgroundColor: active ? "#ffffff" : categoryPalette[activeDisplayCategory].accent
                            }}
                          />
                        </div>
                      </button>
                    );
                  })}
                  {!activityBuckets.length ? <p className="text-xs text-[var(--color-ink-soft)]">No recent activity yet.</p> : null}
                </div>
              </CardContent>
            </Card>

            <Card className="overflow-hidden p-3">
              <CardHeader className="flex-col gap-2 sm:flex-row sm:items-start">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-soft)]">Results</div>
                  <CardTitle className="mt-0.5 text-base">
                    {!isCustomScope && route.category === "todo" ? "Change log notes" : isCustomScope ? "Notes in custom category" : "Notes in scope"}
                  </CardTitle>
                </div>
                <div className="max-w-[30ch] text-left text-xs leading-5 text-[var(--color-ink-soft)] sm:text-right">
                  {noteListMeta(route, allSessions.length, noteListItems.length, graphFocus, activeDisplayCategory)}
                </div>
              </CardHeader>
              <CardContent className="mt-3">
                <ScrollArea className="h-[min(56vh,560px)]">
                  <div className="space-y-2 pr-5 pb-1">
                    {noteListItems.map((session) => {
                      const match = matches.get(session.id);
                      const isActive = session.id === selectedSessionId;
                      return (
                        <button
                          key={session.id}
                          type="button"
                          onClick={() => updateRoute({ note: session.id }, false)}
                          className={`w-full rounded-[8px] border p-2.5 text-left transition ${
                            isActive ? "border-[var(--color-ink)] bg-[var(--color-ink)] text-white" : "border-[var(--color-line)] bg-[var(--color-paper-raised)] hover:bg-[var(--color-paper-sunken)]"
                          }`}
                        >
                          <div className="mb-1.5 flex min-w-0 items-center justify-between gap-2">
                            <span className="min-w-0 truncate text-sm font-semibold">{titleFromSession(session)}</span>
                            <span className="shrink-0">
                              <Badge tone="neutral">{providerLabels[session.provider]}</Badge>
                            </span>
                          </div>
                          {(session.user_categories ?? []).length ? (
                            <div className="mb-1.5 flex flex-wrap gap-1">
                              {(session.user_categories ?? []).slice(0, 3).map((category) => (
                                <span
                                  key={category}
                                  className={isActive ? "rounded-full border border-white/20 px-2 py-0.5 text-[10px] text-white/75" : "rounded-full border border-[var(--color-line)] px-2 py-0.5 text-[10px] text-[var(--color-ink-soft)]"}
                                >
                                  {category}
                                </span>
                              ))}
                            </div>
                          ) : null}
                          <div className={isActive ? "text-xs uppercase tracking-[0.08em] text-white/70" : "text-xs uppercase tracking-[0.08em] text-[var(--color-ink-soft)]"}>
                            {formatCompactDate(session.updated_at)}
                          </div>
                          <p className={isActive ? "mt-1.5 line-clamp-2 break-words text-xs leading-5 text-white/80" : "mt-1.5 line-clamp-2 break-words text-xs leading-5 text-[var(--color-ink-soft)]"}>
                            {sessionPreviewText(session, match, session.category ?? activeDisplayCategory)}
                          </p>
                        </button>
                      );
                    })}
                    {!noteListItems.length ? <p className="text-sm text-[var(--color-ink-soft)]">No notes match this view yet.</p> : null}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            <Card className="overflow-hidden p-3">
              <CardHeader className="gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-soft)]">Reader</div>
                  <CardTitle className="mt-0.5 truncate text-base">{selectedSession ? titleFromSession(selectedSession) : "Choose a note"}</CardTitle>
                  <CardDescription className="line-clamp-1 text-xs leading-5">
                    {noteQuery.data
                      ? [
                          providerLabels[noteQuery.data.provider],
                          categoryLabels[noteQuery.data.category ?? route.category],
                          formatLongDate(noteQuery.data.updated_at),
                          `${formatNumber(noteQuery.data.word_count)} words`
                        ].join(" · ")
                      : "Select a note, graph node, or storyline to inspect it."}
                  </CardDescription>
                  {selectedSession ? (
                    <div className="mt-4 space-y-3 xl:hidden">
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">Custom categories</div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {(selectedSession.user_categories ?? []).map((category) => (
                            <button
                              key={category}
                              type="button"
                              onClick={() => void handleRemoveUserCategory(category)}
                              className="rounded-full border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 py-1 text-xs text-[var(--color-ink-soft)] transition hover:bg-[var(--color-paper-sunken)]"
                            >
                              {category} ×
                            </button>
                          ))}
                          {!(selectedSession.user_categories ?? []).length ? (
                            <span className="text-sm text-[var(--color-ink-soft)]">No custom categories assigned yet.</span>
                          ) : null}
                        </div>
                      </div>
                      <form
                        className="flex flex-col gap-2 sm:flex-row"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void handleAddUserCategory(userCategoryDraft);
                        }}
                      >
                        <input
                          type="text"
                          value={userCategoryDraft}
                          onChange={(event) => setUserCategoryDraft(event.target.value)}
                          placeholder="Add this note to a custom category"
                          className="h-10 flex-1 rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 text-sm outline-none transition focus:border-[var(--color-line-strong)]"
                        />
                        <Button type="submit" size="sm" variant="secondary" disabled={!userCategoryDraft.trim()}>
                          Add category
                        </Button>
                      </form>
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {selectedSession ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-8 px-2.5 text-xs"
                      onClick={() => {
                        window.location.href = notePageUrl({
                          id: selectedSession.id,
                          category: route.category,
                          q: route.q,
                          provider: route.provider,
                          sort: route.sort,
                          userCategory: route.userCategory
                        });
                      }}
                    >
                      Open note
                    </Button>
                  ) : null}
                  {noteQuery.data?.source_url ? (
                    <Button variant="secondary" size="sm" className="h-8 px-2.5 text-xs" onClick={() => void chrome.tabs.create({ url: noteQuery.data!.source_url! })}>
                      <ExternalLink className="h-4 w-4" />
                      Source
                    </Button>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="mt-2">
                {userCategoryError ? (
                  <div className="mb-4 rounded-[8px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{userCategoryError}</div>
                ) : null}
                {selectedSession && noteQuery.isLoading ? (
                  <div className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-5 text-sm text-[var(--color-ink-soft)]">Loading note content…</div>
                ) : selectedSession && noteQuery.data ? (
                  <Tabs.Root value={readerTab} onValueChange={(value) => setReaderTab(value as typeof readerTab)}>
                    <Tabs.List className="mb-2 inline-flex rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-1">
                      {[
                        { value: "overview", label: "Overview" },
                        { value: "transcript", label: "Transcript" },
                        { value: "markdown", label: "Markdown" }
                      ].map((tab) => (
                        <Tabs.Trigger
                          key={tab.value}
                          value={tab.value}
                          className="rounded-[6px] px-2.5 py-1.5 text-xs font-medium text-[var(--color-ink-soft)] outline-none transition data-[state=active]:bg-[var(--color-paper-raised)] data-[state=active]:text-[var(--color-ink)] data-[state=active]:shadow-sm"
                        >
                          {tab.label}
                        </Tabs.Trigger>
                      ))}
                    </Tabs.List>

                    <ScrollArea className="h-[min(56vh,560px)]">
                      <div className="pr-5 pb-1">
                        <Tabs.Content value="overview" className="outline-none">
                          <NoteOverview note={noteQuery.data as BackendSessionNoteRead} />
                        </Tabs.Content>
                        <Tabs.Content value="transcript" className="outline-none">
                          <TranscriptView note={noteQuery.data as BackendSessionNoteRead} />
                        </Tabs.Content>
                        <Tabs.Content value="markdown" className="outline-none">
                          <MarkdownView note={noteQuery.data as BackendSessionNoteRead} />
                        </Tabs.Content>
                      </div>
                    </ScrollArea>
                  </Tabs.Root>
                ) : (
                  <div className="rounded-[8px] border border-dashed border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-6 text-sm text-[var(--color-ink-soft)]">
                    Select a note from the list, atlas, or storyline view to inspect its summary, transcript, and markdown.
                  </div>
                )}
              </CardContent>
            </Card>
      </div>

      {error ||
      sessionsQuery.error ||
      searchQuery.error ||
      statsQuery.error ||
      graphQuery.error ||
      noteQuery.error ||
      todoQuery.error ||
      userCategoriesQuery.error ||
      status?.backendValidationError ? (
        <div className="rounded-[8px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {status?.backendValidationError ||
            error ||
            (sessionsQuery.error instanceof Error && sessionsQuery.error.message) ||
            (searchQuery.error instanceof Error && searchQuery.error.message) ||
            (statsQuery.error instanceof Error && statsQuery.error.message) ||
            (graphQuery.error instanceof Error && graphQuery.error.message) ||
            (noteQuery.error instanceof Error && noteQuery.error.message) ||
            (todoQuery.error instanceof Error && todoQuery.error.message) ||
            (userCategoriesQuery.error instanceof Error && userCategoriesQuery.error.message) ||
            "Could not load the category explorer."}
        </div>
      ) : null}
    </div>
  );
}

mountApp(<App />);
