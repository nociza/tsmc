import { useEffect, useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import * as Tabs from "@radix-ui/react-tabs";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { Activity, ArrowLeft, BrainCircuit, Database, ExternalLink, Search, Sparkles, Workflow } from "lucide-react";

import {
  fetchCategoryGraph,
  fetchCategoryStats,
  fetchCustomCategoryGraph,
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
  categoryDescriptions,
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
  BackendCategoryStats,
  BackendSearchResponse,
  BackendSessionListItem,
  BackendSessionNoteRead,
  BackendTodoItem,
  BackendTodoListRead,
  BackendUserCategorySummary,
  ExtensionSettings,
  ProviderName,
  SessionCategoryName
} from "../shared/types";
import { mountApp } from "../ui/boot";
import { Badge } from "../ui/components/badge";
import { Button } from "../ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/components/card";
import { CategoryGraph } from "../ui/components/category-graph";
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

function statsCards(stats: BackendCategoryStats, todo: BackendTodoListRead | null): Array<{ label: string; value: string }> {
  if (stats.scope_kind === "custom") {
    return [
      { label: "Notes", value: formatNumber(stats.total_sessions) },
      { label: "Messages", value: formatNumber(stats.total_messages) },
      { label: "Facts", value: formatNumber(stats.total_triplets) },
      { label: "Base groups", value: formatNumber(stats.system_category_counts.length) }
    ];
  }

  if (stats.category === "factual") {
    return [
      { label: "Notes", value: formatNumber(stats.total_sessions) },
      { label: "Facts", value: formatNumber(stats.total_triplets) },
      { label: "Entities", value: formatNumber(stats.top_entities.reduce((count, item) => count + item.count, 0)) },
      { label: "Predicates", value: formatNumber(stats.top_predicates.reduce((count, item) => count + item.count, 0)) }
    ];
  }

  if (stats.category === "ideas") {
    return [
      { label: "Notes", value: formatNumber(stats.total_sessions) },
      { label: "Messages", value: formatNumber(stats.total_messages) },
      { label: "Idea summaries", value: formatNumber(stats.notes_with_idea_summary) },
      { label: "Share posts", value: formatNumber(stats.notes_with_share_post) }
    ];
  }

  if (stats.category === "journal") {
    return [
      { label: "Notes", value: formatNumber(stats.total_sessions) },
      { label: "Messages", value: formatNumber(stats.total_messages) },
      { label: "Entries", value: formatNumber(stats.notes_with_journal_entry) },
      { label: "Share posts", value: formatNumber(stats.notes_with_share_post) }
    ];
  }

  return [
    { label: "Notes", value: formatNumber(stats.total_sessions) },
    { label: "Shared tasks", value: formatNumber(todo?.total_count) },
    { label: "Active", value: formatNumber(todo?.active_count) },
    { label: "Completed", value: formatNumber(todo?.completed_count) },
    { label: "Task updates", value: formatNumber(stats.notes_with_todo_summary) },
  ];
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

function formatTooltipMetric(value: unknown): string {
  return formatNumber(typeof value === "number" ? value : Number(value ?? 0));
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

function App() {
  const { settings, status, loading, error } = useExtensionBootstrap();
  const [route, setRoute] = useState<RouteState>(readRouteState);
  const [graphFocus, setGraphFocus] = useState<GraphFocus | null>(null);
  const [readerTab, setReaderTab] = useState<"overview" | "transcript" | "markdown">("overview");
  const [groupingMode, setGroupingMode] = useState<GraphGroupingMode>("provider");
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
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
  const graphInsights = useMemo(
    () => buildCategoryGraphInsights(graph, visibleSessions, activeDisplayCategory, groupingMode),
    [activeDisplayCategory, graph, groupingMode, visibleSessions]
  );
  const scopePills = [
    { key: "category", label: isCustomScope ? "Default base" : "Category", value: categoryLabels[activeDisplayCategory] },
    route.userCategory ? { key: "user-category", label: "Custom", value: route.userCategory } : null,
    route.provider ? { key: "provider", label: "Provider", value: providerLabels[route.provider] } : null,
    route.q ? { key: "query", label: "Query", value: route.q } : null,
    route.bucket ? { key: "bucket", label: "Time", value: formatBucketLabel(route.bucket) } : null,
    graphFocus ? { key: "focus", label: "Focus", value: graphFocus.label } : null
  ].filter((item): item is { key: string; label: string; value: string } => Boolean(item));

  useEffect(() => {
    const allowedClusters = new Set(graphInsights.clusters.map((cluster) => cluster.id));
    setCollapsedGroups((current) => {
      const next = current.filter((clusterId) => allowedClusters.has(clusterId));
      return next.length === current.length && next.every((clusterId, index) => clusterId === current[index]) ? current : next;
    });
  }, [graphInsights.clusters]);

  function handleCategorySwitch(category: SessionCategoryName): void {
    setGraphFocus(null);
    setCollapsedGroups([]);
    updateRoute({ category, note: null, bucket: null, view: "atlas", userCategory: null }, true);
  }

  function handleUserCategorySwitch(name: string): void {
    setGraphFocus(null);
    setCollapsedGroups([]);
    updateRoute({ userCategory: name, note: null, bucket: null, view: "atlas" }, true);
  }

  function activateFocus(label: string, sessionIds: string[], nextView?: CategoryWorkspaceView): void {
    setGraphFocus({ label, sessionIds });
    const nextId = visibleSessions.find((item) => sessionIds.includes(item.id))?.id ?? sessionIds[0] ?? null;
    updateRoute({ note: nextId, view: nextView ?? route.view }, false);
  }

  function handleFocus(label: string, sessionIds: string[]): void {
    activateFocus(label, sessionIds);
  }

  function handleBucketToggle(bucket: string): void {
    setGraphFocus(null);
    updateRoute({ bucket: route.bucket === bucket ? null : bucket, note: null }, true);
  }

  function clearScope(): void {
    setGraphFocus(null);
    setCollapsedGroups([]);
    updateRoute({ q: "", provider: null, sort: "recent", bucket: null, note: null, view: "atlas", userCategory: null }, true);
  }

  const workspaceCards = [
    {
      value: "atlas" as const,
      label: "Atlas",
      accent: categoryPalette[activeDisplayCategory].accent,
      icon: BrainCircuit,
      metric: `${formatNumber(graph.node_count)} nodes`,
      detail: `${formatNumber(graph.edge_count)} relationships`
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

  const headerMetrics =
    !isCustomScope && route.category === "todo"
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

  return (
    <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-6 px-4 py-4 sm:px-6 sm:py-6">
      <Card className="p-5">
        <CardHeader>
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">SaveMyContext</div>
            <CardTitle className="break-words text-3xl leading-none">
              {isCustomScope ? route.userCategory : categoryLabels[route.category]}
            </CardTitle>
            <CardDescription>
              {isCustomScope
                ? "User-defined category for organizing notes and sessions across the workspace."
                : categoryDescriptions[route.category]}
            </CardDescription>
          </div>
          <Button variant="secondary" onClick={() => (window.location.href = chrome.runtime.getURL("dashboard.html"))}>
            <ArrowLeft className="h-4 w-4" />
            Overview
          </Button>
        </CardHeader>

        <CardContent className="mt-5 grid gap-3 lg:grid-cols-[1.3fr_1fr]">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {headerMetrics.map((metric) => (
              <div key={metric.label} className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
                <metric.icon className="h-4 w-4 text-zinc-400" />
                <div className="mt-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">{metric.label}</div>
                <div className="mt-2 break-words text-2xl font-semibold leading-none text-zinc-950">{metric.value}</div>
              </div>
            ))}
          </div>

          <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Current scope</div>
            <div className="mt-2 text-lg font-semibold text-zinc-950">
              {graphFocus ? graphFocus.label : route.q ? `Search: ${route.q}` : isCustomScope ? route.userCategory : "Entire category"}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {scopePills.map((pill) => (
                <div key={pill.key} className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600">
                  <span className="text-zinc-400">{pill.label}</span> {pill.value}
                </div>
              ))}
              {!scopePills.length ? (
                <div className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600">
                  {isCustomScope ? "Custom category" : "Full category"}
                </div>
              ) : null}
            </div>
            <div className="mt-4 text-sm leading-6 text-zinc-600">
              {noteListMeta(route, allSessions.length, visibleSessions.length, graphFocus, activeDisplayCategory)}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card className="p-4">
            <CardHeader>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Collections</div>
                <CardTitle className="mt-1 text-lg">Default and custom categories</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="mt-4 space-y-4">
              <div className="grid gap-2">
                {categoryOrder.map((category) => (
                  <button
                    key={category}
                    type="button"
                    onClick={() => handleCategorySwitch(category)}
                    className={`rounded-[8px] border px-3 py-3 text-left transition ${
                      !isCustomScope && route.category === category
                        ? "border-zinc-950 bg-zinc-950 text-white"
                        : "border-zinc-200 bg-white hover:bg-zinc-50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold">{categoryLabels[category]}</span>
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: categoryPalette[category].accent }} />
                    </div>
                  </button>
                ))}
              </div>

              <div className="space-y-3 border-t border-zinc-200 pt-4">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Custom categories</div>
                  <div className="mt-1 text-sm text-zinc-500">Use these to organize notes and sessions beyond the default classifier.</div>
                </div>

                <div className="space-y-2">
                  {userCategories.map((item) => (
                    <button
                      key={item.name}
                      type="button"
                      onClick={() => handleUserCategorySwitch(item.name)}
                      className={`flex w-full items-center justify-between gap-3 rounded-[8px] border px-3 py-3 text-left transition ${
                        route.userCategory === item.name ? "border-zinc-950 bg-zinc-950 text-white" : "border-zinc-200 bg-white hover:bg-zinc-50"
                      }`}
                    >
                      <span className="truncate text-sm font-semibold">{item.name}</span>
                      <span className={route.userCategory === item.name ? "text-xs text-white/70" : "text-xs text-zinc-500"}>
                        {formatNumber(item.count)}
                      </span>
                    </button>
                  ))}
                  {!userCategories.length ? <p className="text-sm text-zinc-500">Assign a note to a custom category to make it appear here.</p> : null}
                </div>

                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleAddUserCategory(userCategoryDraft);
                  }}
                >
                  <input
                    type="text"
                    value={userCategoryDraft}
                    onChange={(event) => setUserCategoryDraft(event.target.value)}
                    placeholder={selectedSession ? "Create and assign to the selected note" : "Select a note to create a custom category"}
                    className="h-10 w-full rounded-[8px] border border-zinc-200 bg-white px-3 text-sm outline-none transition focus:border-zinc-300"
                  />
                  <Button type="submit" size="sm" variant="secondary" disabled={!selectedSession || !userCategoryDraft.trim()}>
                    Add to selected note
                  </Button>
                </form>
              </div>
            </CardContent>
          </Card>

          <Card className="p-4">
            <CardHeader>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Explore</div>
                <CardTitle className="mt-1 text-lg">Query and scope</CardTitle>
              </div>
              <div className="text-sm text-zinc-500">Everything here reshapes the graph, storylines, and note list.</div>
            </CardHeader>

            <CardContent className="mt-4 space-y-4">
              <label className="block">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Search</div>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                  <input
                    type="search"
                    value={route.q}
                    onChange={(event) => {
                      setGraphFocus(null);
                      updateRoute({ q: event.target.value, note: null }, true);
                    }}
                    placeholder="Search notes, entities, or transcript text"
                    className="h-11 w-full rounded-[8px] border border-zinc-200 bg-white pl-10 pr-3 text-sm outline-none transition focus:border-zinc-300"
                  />
                </div>
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Provider</div>
                  <Select
                    value={route.provider ?? "__all__"}
                    onValueChange={(value) => {
                      setGraphFocus(null);
                      updateRoute({ provider: value === "__all__" ? null : (value as ProviderName), note: null }, true);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">All providers</SelectItem>
                      <SelectItem value="chatgpt">ChatGPT</SelectItem>
                      <SelectItem value="gemini">Gemini</SelectItem>
                      <SelectItem value="grok">Grok</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Sort</div>
                  <Select value={route.sort} onValueChange={(value) => updateRoute({ sort: value as CategorySortMode }, true)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="recent">Most recent</SelectItem>
                      <SelectItem value="title">Title</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Recent activity buckets</div>
                <div className="flex flex-wrap gap-2">
                  {activityBuckets.map((bucket) => (
                    <button
                      key={bucket.bucket}
                      type="button"
                      onClick={() => handleBucketToggle(bucket.bucket)}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                        route.bucket === bucket.bucket
                          ? "border-zinc-950 bg-zinc-950 text-white"
                          : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50"
                      }`}
                    >
                      {bucket.label} · {formatNumber(bucket.count)}
                    </button>
                  ))}
                  {!activityBuckets.length ? <p className="text-sm text-zinc-500">No recent activity buckets yet.</p> : null}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" onClick={clearScope}>
                  Clear scope
                </Button>
                {graphFocus ? (
                  <Button size="sm" variant="ghost" onClick={() => setGraphFocus(null)}>
                    Clear focus
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card className="p-4">
            <CardHeader>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Snapshot</div>
                <CardTitle className="mt-1 text-lg">What this scope contains</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="mt-4 grid grid-cols-2 gap-2">
              {statsCards(stats, todo).map((metric) => (
                <div key={metric.label} className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">{metric.label}</div>
                  <div className="mt-2 text-2xl font-semibold text-zinc-950">{metric.value}</div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="p-4">
            <CardHeader>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Signals</div>
                <CardTitle className="mt-1 text-lg">Recurring concepts</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="mt-4 space-y-3">
              <div className="space-y-2">
                {signals.primary.slice(0, 5).map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => {
                      updateRoute({ q: item.label, note: null, view: "atlas" }, true);
                      setGraphFocus(null);
                    }}
                    className="flex w-full items-center justify-between gap-3 rounded-[8px] border border-zinc-200 bg-zinc-50 px-3 py-2 text-left transition hover:bg-white"
                  >
                    <span className="truncate text-sm text-zinc-700">{item.label}</span>
                    <span className="text-sm font-semibold text-zinc-950">{formatNumber(item.count)}</span>
                  </button>
                ))}
                {!signals.primary.length ? <p className="text-sm text-zinc-500">No recurring signals yet.</p> : null}
              </div>

              <div className="space-y-2">
                {signals.secondary.slice(0, 4).map((item) => (
                  <div key={item.label} className="flex items-center justify-between gap-3 rounded-[8px] border border-zinc-200 bg-white px-3 py-2">
                    <span className="truncate text-sm text-zinc-700">{item.label}</span>
                    <span className="text-sm font-semibold text-zinc-950">{formatNumber(item.count)}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="p-5">
            <CardHeader>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Workspace</div>
                <CardTitle className="mt-1 text-lg">
                  {!isCustomScope && route.category === "todo"
                    ? "Shared list workspace"
                    : activeDisplayCategory === "factual"
                      ? "Knowledge graph workspace"
                      : "Context workspace"}
                </CardTitle>
                <CardDescription>
                  {!isCustomScope && route.category === "todo"
                    ? "Check tasks off, review git-backed list history, and keep note evidence close to the shared checklist."
                    : isCustomScope
                      ? "This view follows one user-defined category while preserving the underlying note and graph structure."
                      : "Atlas for structure, storylines for guided exploration, and graph ops for maintenance and retrieval quality."}
                </CardDescription>
              </div>
            </CardHeader>

            <CardContent className="mt-5">
              {!isCustomScope && route.category === "todo" ? (
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
                <Tabs.Root value={route.view} onValueChange={(value) => updateRoute({ view: value as CategoryWorkspaceView }, true)}>
                <Tabs.List className="grid gap-3 lg:grid-cols-3">
                  {workspaceCards.map((card) => (
                    <Tabs.Trigger
                      key={card.value}
                      value={card.value}
                      className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4 text-left outline-none transition data-[state=active]:border-zinc-950 data-[state=active]:bg-white data-[state=active]:shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">{card.label}</div>
                          <div className="mt-2 text-xl font-semibold text-zinc-950">{card.metric}</div>
                          <div className="mt-1 text-sm text-zinc-500">{card.detail}</div>
                        </div>
                        <div className="rounded-[8px] border border-zinc-200 bg-white p-2">
                          <card.icon className="h-4 w-4" style={{ color: card.accent }} />
                        </div>
                      </div>
                    </Tabs.Trigger>
                  ))}
                </Tabs.List>

                <Tabs.Content value="atlas" className="mt-5 outline-none">
                  <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_320px]">
                    <div className="space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-zinc-200 bg-zinc-50 px-3 py-3">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant={groupingMode === "provider" ? "primary" : "secondary"}
                            onClick={() => setGroupingMode("provider")}
                          >
                            Group by provider
                          </Button>
                          <Button
                            size="sm"
                            variant={groupingMode === "kind" ? "primary" : "secondary"}
                            onClick={() => setGroupingMode("kind")}
                          >
                            Group by concept
                          </Button>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setCollapsedGroups(graphInsights.clusters.map((cluster) => cluster.id))}
                            disabled={!graphInsights.clusters.length}
                          >
                            Collapse all
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setCollapsedGroups([])} disabled={!collapsedGroups.length}>
                            Expand all
                          </Button>
                          {graphFocus ? (
                            <Button size="sm" variant="secondary" onClick={() => setGraphFocus(null)}>
                              Clear focus
                            </Button>
                          ) : null}
                        </div>
                      </div>

                      <CategoryGraph
                        graph={graph}
                        category={activeDisplayCategory}
                        groupingMode={groupingMode}
                        collapsedGroups={collapsedGroups}
                        focusSessionIds={graphFocus?.sessionIds}
                        className="min-h-[420px] h-[min(62vh,700px)]"
                        onFocus={handleFocus}
                      />
                    </div>

                    <div className="space-y-4">
                      <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">Scope summary</div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {scopePills.map((pill) => (
                            <Badge key={pill.key} tone="neutral">
                              {pill.label}: {pill.value}
                            </Badge>
                          ))}
                          {!scopePills.length ? <Badge tone="neutral">Full category</Badge> : null}
                        </div>
                        <div className="mt-4 grid grid-cols-2 gap-2">
                          {[
                            { label: "Linked notes", value: formatNumber(graphInsights.graphSessionIds.length) },
                            { label: "Outside graph", value: formatNumber(graphInsights.uncoveredSessions) },
                            { label: "Clusters", value: formatNumber(graphInsights.clusters.length) },
                            { label: "Collapsed", value: formatNumber(collapsedGroups.length) }
                          ].map((metric) => (
                            <div key={metric.label} className="rounded-[8px] border border-zinc-200 bg-white p-3">
                              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">{metric.label}</div>
                              <div className="mt-2 text-lg font-semibold text-zinc-950">{metric.value}</div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div>
                            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">Semantic groups</div>
                            <div className="mt-1 text-base font-semibold text-zinc-950">
                              {groupingMode === "provider" ? "Provider clusters" : "Concept clusters"}
                            </div>
                          </div>
                          <Badge tone="neutral">{formatNumber(graphInsights.clusters.length)}</Badge>
                        </div>

                        <ScrollArea className="h-[min(46vh,448px)] pr-4">
                          <div className="space-y-3">
                            {graphInsights.clusters.map((cluster) => {
                              const collapsed = collapsedGroups.includes(cluster.id);
                              return (
                                <div key={cluster.id} className="rounded-[8px] border border-zinc-200 bg-white p-3">
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="flex items-center gap-2">
                                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: cluster.accent }} />
                                        <div className="truncate text-sm font-semibold text-zinc-950">{cluster.label}</div>
                                      </div>
                                      <div className="mt-1 text-xs uppercase tracking-[0.08em] text-zinc-500">
                                        {formatNumber(cluster.nodeCount)} entities · {formatNumber(cluster.noteCount)} notes
                                      </div>
                                    </div>
                                    {collapsed ? <Badge tone="info">Collapsed</Badge> : null}
                                  </div>

                                  <div className="mt-3 flex flex-wrap gap-2">
                                    <Button size="sm" variant="secondary" onClick={() => activateFocus(cluster.label, cluster.sessionIds)}>
                                      Focus
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() =>
                                        setCollapsedGroups((current) =>
                                          current.includes(cluster.id)
                                            ? current.filter((value) => value !== cluster.id)
                                            : [...current, cluster.id]
                                        )
                                      }
                                    >
                                      {collapsed ? "Expand" : "Collapse"}
                                    </Button>
                                  </div>
                                </div>
                              );
                            })}
                            {!graphInsights.clusters.length ? <p className="text-sm text-zinc-500">No clusters available in this scope yet.</p> : null}
                          </div>
                        </ScrollArea>
                      </div>
                    </div>
                  </div>
                </Tabs.Content>

                <Tabs.Content value="story" className="mt-5 outline-none">
                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
                    <div className="grid gap-3 md:grid-cols-2">
                      {graphInsights.storylines.map((storyline) => (
                        <button
                          key={storyline.id}
                          type="button"
                          onClick={() => activateFocus(storyline.label, storyline.sessionIds, "atlas")}
                          className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4 text-left transition hover:border-zinc-300 hover:bg-white"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">{storyline.clusterLabel}</div>
                              <div className="mt-1 truncate text-lg font-semibold text-zinc-950">{storyline.label}</div>
                            </div>
                            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: storyline.accent }} />
                          </div>

                          <p className="mt-3 text-sm leading-6 text-zinc-600">{storyline.summary}</p>
                          <div className="mt-4 flex flex-wrap gap-2">
                            <Badge tone="neutral">{formatNumber(storyline.noteCount)} notes</Badge>
                            <Badge tone="neutral">{formatNumber(storyline.degree)} links</Badge>
                          </div>
                          <div className="mt-4 text-xs uppercase tracking-[0.08em] text-zinc-500">
                            Updated {formatCompactDate(storyline.lastUpdated, "No recent change")}
                          </div>
                        </button>
                      ))}
                      {!graphInsights.storylines.length ? (
                        <div className="rounded-[8px] border border-dashed border-zinc-200 bg-zinc-50 p-6 text-sm text-zinc-500 md:col-span-2">
                          No storylines are available in this scope yet.
                        </div>
                      ) : null}
                    </div>

                    <div className="space-y-4">
                      <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">Activity lane</div>
                        <div className="mt-1 text-base font-semibold text-zinc-950">Recent note movement</div>
                        <div className="mt-4 flex justify-center">
                          <AreaChart width={292} height={220} data={activityBuckets}>
                            <defs>
                              <linearGradient id="categoryActivity" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor={categoryPalette[activeDisplayCategory].accent} stopOpacity={0.28} />
                                <stop offset="100%" stopColor={categoryPalette[activeDisplayCategory].accent} stopOpacity={0.04} />
                              </linearGradient>
                            </defs>
                            <CartesianGrid stroke="#e4e4e7" strokeDasharray="3 3" vertical={false} />
                            <XAxis dataKey="label" tick={{ fill: "#71717a", fontSize: 12 }} tickLine={false} axisLine={false} />
                            <YAxis tick={{ fill: "#71717a", fontSize: 12 }} tickLine={false} axisLine={false} allowDecimals={false} />
                            <Tooltip formatter={(value) => `${formatTooltipMetric(value)} notes`} />
                            <Area
                              type="monotone"
                              dataKey="count"
                              stroke={categoryPalette[activeDisplayCategory].accent}
                              fill="url(#categoryActivity)"
                              strokeWidth={2.5}
                            />
                          </AreaChart>
                        </div>

                        <div className="mt-4 flex flex-wrap gap-2">
                          {activityBuckets.map((bucket) => (
                            <button
                              key={bucket.bucket}
                              type="button"
                              onClick={() => handleBucketToggle(bucket.bucket)}
                              className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                                route.bucket === bucket.bucket
                                  ? "border-zinc-950 bg-zinc-950 text-white"
                                  : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50"
                              }`}
                            >
                              {bucket.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">Dense nodes</div>
                        <div className="mt-1 text-base font-semibold text-zinc-950">High-traffic concepts</div>
                        <div className="mt-4 space-y-2">
                          {graphInsights.denseNodes.slice(0, 6).map((node) => (
                            <button
                              key={node.id}
                              type="button"
                              onClick={() => activateFocus(node.label, node.sessionIds, "atlas")}
                              className="flex w-full items-center justify-between gap-3 rounded-[8px] border border-zinc-200 bg-white px-3 py-3 text-left transition hover:bg-zinc-50"
                            >
                              <div className="min-w-0">
                                <div className="truncate text-sm font-semibold text-zinc-950">{node.label}</div>
                                <div className="mt-1 text-xs uppercase tracking-[0.08em] text-zinc-500">
                                  {formatNumber(node.degree)} links · {formatNumber(node.noteCount)} notes
                                </div>
                              </div>
                              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: node.accent }} />
                            </button>
                          ))}
                          {!graphInsights.denseNodes.length ? <p className="text-sm text-zinc-500">No dense nodes in this scope yet.</p> : null}
                        </div>
                      </div>
                    </div>
                  </div>
                </Tabs.Content>

                <Tabs.Content value="ops" className="mt-5 outline-none">
                  <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
                    <div className="space-y-4">
                      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        {[
                          { label: "Coverage", value: `${formatPercent(graphInsights.sessionCoverage * 100)}%`, detail: `${formatNumber(graphInsights.graphSessionIds.length)} linked notes` },
                          { label: "Corroborated", value: formatNumber(graphInsights.corroboratedNodes), detail: "Nodes shared across notes" },
                          { label: "Orphans", value: formatNumber(graphInsights.orphanNodes), detail: "Disconnected nodes in scope" },
                          { label: "Clusters", value: formatNumber(graphInsights.clusters.length), detail: `${groupingMode === "provider" ? "Provider" : "Concept"} groups` }
                        ].map((metric) => (
                          <div key={metric.label} className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">{metric.label}</div>
                            <div className="mt-2 text-3xl font-semibold text-zinc-950">{metric.value}</div>
                            <div className="mt-2 text-sm text-zinc-500">{metric.detail}</div>
                          </div>
                        ))}
                      </div>

                      <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div>
                            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">Graph hygiene</div>
                            <div className="mt-1 text-base font-semibold text-zinc-950">Lint and maintenance cues</div>
                          </div>
                          <Badge tone={graphInsights.warnings.length ? "warning" : "success"}>
                            {graphInsights.warnings.length ? `${graphInsights.warnings.length} signals` : "Healthy"}
                          </Badge>
                        </div>

                        <div className="space-y-3">
                          {graphInsights.warnings.map((warning) => (
                            <div key={warning.id} className="rounded-[8px] border border-zinc-200 bg-white p-3">
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <div className="text-sm font-semibold text-zinc-950">{warning.label}</div>
                                  <div className="mt-1 text-sm leading-6 text-zinc-600">{warning.detail}</div>
                                </div>
                                <Badge tone={warning.tone === "warning" ? "warning" : warning.tone === "danger" ? "danger" : "info"}>
                                  {warning.tone}
                                </Badge>
                              </div>
                              {warning.sessionIds?.length ? (
                                <div className="mt-3">
                                  <Button size="sm" variant="secondary" onClick={() => activateFocus(warning.label, warning.sessionIds ?? [], "atlas")}>
                                    Inspect in atlas
                                  </Button>
                                </div>
                              ) : null}
                            </div>
                          ))}

                          {!graphInsights.warnings.length ? (
                            <div className="rounded-[8px] border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                              The current scope is reasonably connected. Use atlas grouping to inspect clusters or storyline view to follow the dominant paths.
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">Query surface</div>
                        <div className="mt-1 text-base font-semibold text-zinc-950">What the retriever can see right now</div>
                        <div className="mt-4 grid gap-3 sm:grid-cols-2">
                          {[
                            { label: "Visible notes", value: formatNumber(visibleSessions.length) },
                            { label: "Average link weight", value: graphInsights.averageEdgeWeight.toFixed(1) },
                            { label: "Nodes per note", value: graphInsights.averageNodesPerSession.toFixed(1) },
                            { label: "Single-source nodes", value: formatNumber(graphInsights.singleSourceNodes) }
                          ].map((metric) => (
                            <div key={metric.label} className="rounded-[8px] border border-zinc-200 bg-white p-3">
                              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">{metric.label}</div>
                              <div className="mt-2 text-lg font-semibold text-zinc-950">{metric.value}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">Provider mix</div>
                        <div className="mt-1 text-base font-semibold text-zinc-950">Evidence by source</div>
                        <div className="mt-4 space-y-3">
                          {providerPie.map((item) => {
                            const maxCount = Math.max(...providerPie.map((provider) => provider.count), 1);
                            return (
                              <div key={item.provider} className="rounded-[8px] border border-zinc-200 bg-white p-3">
                                <div className="flex items-center justify-between gap-3">
                                  <div className="text-sm font-medium text-zinc-700">{item.label}</div>
                                  <div className="text-sm font-semibold text-zinc-950">{formatNumber(item.count)}</div>
                                </div>
                                <div className="mt-2 h-2 rounded-full bg-zinc-100">
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
                          {!providerPie.length ? <p className="text-sm text-zinc-500">No provider evidence in this scope yet.</p> : null}
                        </div>
                      </div>

                      <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">Top signals</div>
                        <div className="mt-1 text-base font-semibold text-zinc-950">Most repeated labels in scope</div>
                        <div className="mt-4 space-y-2">
                          {signals.primary.slice(0, 6).map((item) => (
                            <button
                              key={item.label}
                              type="button"
                              onClick={() => {
                                setGraphFocus(null);
                                updateRoute({ q: item.label, view: "atlas", note: null }, true);
                              }}
                              className="flex w-full items-center justify-between gap-3 rounded-[8px] border border-zinc-200 bg-white px-3 py-3 text-left transition hover:bg-zinc-50"
                            >
                              <span className="truncate text-sm font-medium text-zinc-700">{item.label}</span>
                              <span className="text-sm font-semibold text-zinc-950">{formatNumber(item.count)}</span>
                            </button>
                          ))}
                          {!signals.primary.length ? <p className="text-sm text-zinc-500">No repeated labels yet.</p> : null}
                        </div>
                      </div>
                    </div>
                  </div>
                </Tabs.Content>
                </Tabs.Root>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 2xl:grid-cols-[360px_minmax(0,1fr)]">
            <Card className="p-4">
              <CardHeader>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Results</div>
                  <CardTitle className="mt-1 text-lg">
                    {!isCustomScope && route.category === "todo" ? "Change log notes" : isCustomScope ? "Notes in custom category" : "Notes in scope"}
                  </CardTitle>
                </div>
                <div className="text-sm text-zinc-500">{noteListMeta(route, allSessions.length, noteListItems.length, graphFocus, activeDisplayCategory)}</div>
              </CardHeader>
              <CardContent className="mt-4">
                <ScrollArea className="h-[min(56vh,560px)] pr-4">
                  <div className="space-y-2">
                    {noteListItems.map((session) => {
                      const match = matches.get(session.id);
                      const isActive = session.id === selectedSessionId;
                      return (
                        <button
                          key={session.id}
                          type="button"
                          onClick={() => updateRoute({ note: session.id }, false)}
                          className={`w-full rounded-[8px] border p-3 text-left transition ${
                            isActive ? "border-zinc-950 bg-zinc-950 text-white" : "border-zinc-200 bg-white hover:bg-zinc-50"
                          }`}
                        >
                          <div className="mb-2 flex items-center justify-between gap-3">
                            <span className="truncate text-sm font-semibold">{titleFromSession(session)}</span>
                            <Badge tone="neutral">{providerLabels[session.provider]}</Badge>
                          </div>
                          {(session.user_categories ?? []).length ? (
                            <div className="mb-2 flex flex-wrap gap-1.5">
                              {(session.user_categories ?? []).slice(0, 3).map((category) => (
                                <span
                                  key={category}
                                  className={isActive ? "rounded-full border border-white/20 px-2 py-0.5 text-[10px] text-white/75" : "rounded-full border border-zinc-200 px-2 py-0.5 text-[10px] text-zinc-500"}
                                >
                                  {category}
                                </span>
                              ))}
                            </div>
                          ) : null}
                          <div className={isActive ? "text-xs uppercase tracking-[0.08em] text-white/70" : "text-xs uppercase tracking-[0.08em] text-zinc-500"}>
                            {formatCompactDate(session.updated_at)}
                          </div>
                          <p className={isActive ? "mt-2 line-clamp-3 break-words text-sm leading-6 text-white/80" : "mt-2 line-clamp-3 break-words text-sm leading-6 text-zinc-600"}>
                            {sessionPreviewText(session, match, session.category ?? activeDisplayCategory)}
                          </p>
                        </button>
                      );
                    })}
                    {!noteListItems.length ? <p className="text-sm text-zinc-500">No notes match this view yet.</p> : null}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            <Card className="p-4">
              <CardHeader>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Reader</div>
                  <CardTitle className="mt-1 text-lg">{selectedSession ? titleFromSession(selectedSession) : "Choose a note"}</CardTitle>
                  <CardDescription>
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
                    <div className="mt-4 space-y-3">
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Custom categories</div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {(selectedSession.user_categories ?? []).map((category) => (
                            <button
                              key={category}
                              type="button"
                              onClick={() => void handleRemoveUserCategory(category)}
                              className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs text-zinc-600 transition hover:bg-zinc-50"
                            >
                              {category} ×
                            </button>
                          ))}
                          {!(selectedSession.user_categories ?? []).length ? (
                            <span className="text-sm text-zinc-500">No custom categories assigned yet.</span>
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
                          className="h-10 flex-1 rounded-[8px] border border-zinc-200 bg-white px-3 text-sm outline-none transition focus:border-zinc-300"
                        />
                        <Button type="submit" size="sm" variant="secondary" disabled={!userCategoryDraft.trim()}>
                          Add category
                        </Button>
                      </form>
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {selectedSession ? (
                    <Button
                      variant="secondary"
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
                    <Button variant="secondary" onClick={() => void chrome.tabs.create({ url: noteQuery.data!.source_url! })}>
                      <ExternalLink className="h-4 w-4" />
                      Source
                    </Button>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="mt-4">
                {userCategoryError ? (
                  <div className="mb-4 rounded-[8px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{userCategoryError}</div>
                ) : null}
                {selectedSession && noteQuery.isLoading ? (
                  <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-5 text-sm text-zinc-500">Loading note content…</div>
                ) : selectedSession && noteQuery.data ? (
                  <Tabs.Root value={readerTab} onValueChange={(value) => setReaderTab(value as typeof readerTab)}>
                    <Tabs.List className="mb-4 inline-flex rounded-[8px] border border-zinc-200 bg-zinc-50 p-1">
                      {[
                        { value: "overview", label: "Overview" },
                        { value: "transcript", label: "Transcript" },
                        { value: "markdown", label: "Markdown" }
                      ].map((tab) => (
                        <Tabs.Trigger
                          key={tab.value}
                          value={tab.value}
                          className="rounded-[6px] px-3 py-2 text-sm font-medium text-zinc-500 outline-none transition data-[state=active]:bg-white data-[state=active]:text-zinc-950 data-[state=active]:shadow-sm"
                        >
                          {tab.label}
                        </Tabs.Trigger>
                      ))}
                    </Tabs.List>

                    <ScrollArea className="h-[min(56vh,560px)] pr-4">
                      <Tabs.Content value="overview" className="outline-none">
                        <NoteOverview note={noteQuery.data as BackendSessionNoteRead} />
                      </Tabs.Content>
                      <Tabs.Content value="transcript" className="outline-none">
                        <TranscriptView note={noteQuery.data as BackendSessionNoteRead} />
                      </Tabs.Content>
                      <Tabs.Content value="markdown" className="outline-none">
                        <MarkdownView note={noteQuery.data as BackendSessionNoteRead} />
                      </Tabs.Content>
                    </ScrollArea>
                  </Tabs.Root>
                ) : (
                  <div className="rounded-[8px] border border-dashed border-zinc-200 bg-zinc-50 p-6 text-sm text-zinc-500">
                    Select a note from the list, atlas, or storyline view to inspect its summary, transcript, and markdown.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
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
