import { useEffect, useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import * as Tabs from "@radix-ui/react-tabs";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { ArrowLeft, ExternalLink, Search } from "lucide-react";

import {
  fetchCategoryGraph,
  fetchCategoryStats,
  fetchExplorerSearch,
  fetchSessionNote,
  fetchSessions
} from "../background/backend";
import {
  categoryDescriptions,
  categoryLabels,
  categoryOrder,
  categoryPageUrl,
  categoryPalette,
  formatCompactDate,
  formatLongDate,
  notePageUrl,
  parseCategory,
  parseProvider,
  parseSortMode,
  providerColors,
  providerLabels,
  titleFromSession,
  type CategorySortMode
} from "../shared/explorer";
import type {
  BackendCategoryGraph,
  BackendCategoryStats,
  BackendSearchResponse,
  BackendSessionListItem,
  BackendSessionNoteRead,
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
import { formatNumber } from "../ui/lib/format";
import { MarkdownView, NoteOverview, TranscriptView } from "../ui/lib/notes";
import { useDebouncedValue, useExtensionBootstrap } from "../ui/lib/runtime";

type RouteState = {
  category: SessionCategoryName;
  q: string;
  provider: ProviderName | null;
  sort: CategorySortMode;
  note: string | null;
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
    note: params.get("note")
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
  if (state.note) {
    url.searchParams.set("note", state.note);
  } else {
    url.searchParams.delete("note");
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

function statsCards(stats: BackendCategoryStats): Array<{ label: string; value: string }> {
  if (stats.category === "factual") {
    return [
      { label: "Notes", value: formatNumber(stats.total_sessions) },
      { label: "Messages", value: formatNumber(stats.total_messages) },
      { label: "Facts", value: formatNumber(stats.total_triplets) },
      { label: "Entities", value: formatNumber(stats.top_entities.reduce((count, item) => count + item.count, 0)) }
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
    { label: "Messages", value: formatNumber(stats.total_messages) },
    { label: "Task updates", value: formatNumber(stats.notes_with_todo_summary) },
    { label: "Share posts", value: formatNumber(stats.notes_with_share_post) }
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

function noteListMeta(route: RouteState, total: number, visible: number, focus: GraphFocus | null): string {
  const providerText = route.provider ? ` in ${providerLabels[route.provider]}` : "";
  if (focus) {
    return `${formatNumber(visible)} notes linked to ${focus.label}`;
  }
  if (route.q) {
    return `${formatNumber(visible)} matches for "${route.q}" from ${formatNumber(total)} notes${providerText}`;
  }
  return `${formatNumber(total)} notes in view${providerText}`;
}

function formatTooltipMetric(value: unknown): string {
  return formatNumber(typeof value === "number" ? value : Number(value ?? 0));
}

function App() {
  const { settings, status, loading, error } = useExtensionBootstrap();
  const [route, setRoute] = useState<RouteState>(readRouteState);
  const [graphFocus, setGraphFocus] = useState<GraphFocus | null>(null);
  const [readerTab, setReaderTab] = useState<"overview" | "transcript" | "markdown">("overview");
  const debouncedQuery = useDebouncedValue(route.q);

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
    queryKey: ["category-sessions", settings?.backendUrl, settings?.backendToken, route.category, route.provider],
    queryFn: () =>
      fetchSessions(
        settings as ExtensionSettings,
        route.provider ? { category: route.category, provider: route.provider } : { category: route.category }
      ),
    enabled: Boolean(settings && !status?.backendValidationError)
  });

  const searchQuery = useQuery({
    queryKey: [
      "category-search",
      settings?.backendUrl,
      settings?.backendToken,
      route.category,
      route.provider,
      debouncedQuery
    ],
    queryFn: () =>
      fetchExplorerSearch(settings as ExtensionSettings, debouncedQuery, {
        category: route.category,
        provider: route.provider ?? undefined,
        limit: 80
      }),
    enabled: Boolean(settings && !status?.backendValidationError && debouncedQuery.trim())
  });

  const matches = useMemo(() => searchMatchMap(searchQuery.data), [searchQuery.data]);
  const allSessions = sessionsQuery.data ?? [];
  const visibleSessions = useMemo(() => {
    const base = sortSessions(allSessions, route.sort);
    if (!debouncedQuery.trim()) {
      return base;
    }
    const visibleIds = new Set(matches.keys());
    return base.filter((session) => visibleIds.has(session.id));
  }, [allSessions, debouncedQuery, matches, route.sort]);

  const scopedSessionIds = debouncedQuery.trim() ? visibleSessions.map((session) => session.id) : undefined;

  const statsQuery = useQuery({
    queryKey: [
      "category-stats",
      settings?.backendUrl,
      settings?.backendToken,
      route.category,
      route.provider,
      scopedSessionIds?.join("|") ?? "*"
    ],
    queryFn: () =>
      fetchCategoryStats(
        settings as ExtensionSettings,
        route.category,
        route.provider || scopedSessionIds
          ? {
              provider: route.provider ?? undefined,
              sessionIds: scopedSessionIds
            }
          : undefined
      ),
    enabled: Boolean(settings && !status?.backendValidationError && (!debouncedQuery.trim() || visibleSessions.length > 0))
  });

  const graphQuery = useQuery({
    queryKey: [
      "category-graph",
      settings?.backendUrl,
      settings?.backendToken,
      route.category,
      route.provider,
      scopedSessionIds?.join("|") ?? "*"
    ],
    queryFn: () =>
      fetchCategoryGraph(
        settings as ExtensionSettings,
        route.category,
        route.provider || scopedSessionIds
          ? {
              provider: route.provider ?? undefined,
              sessionIds: scopedSessionIds
            }
          : undefined
      ),
    enabled: Boolean(settings && !status?.backendValidationError && (!debouncedQuery.trim() || visibleSessions.length > 0))
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

  const stats =
    debouncedQuery.trim() && !visibleSessions.length ? createEmptyStats(route.category) : statsQuery.data ?? createEmptyStats(route.category);
  const graph =
    debouncedQuery.trim() && !visibleSessions.length ? createEmptyGraph(route.category) : graphQuery.data ?? createEmptyGraph(route.category);
  const signals = signalGroups(stats);
  const providerPie = stats.provider_counts.map((item) => ({
    provider: item.provider,
    label: providerLabels[item.provider],
    count: item.count,
    color: providerColors[item.provider]
  }));

  function handleCategorySwitch(category: SessionCategoryName): void {
    setGraphFocus(null);
    updateRoute({ category, note: null }, true);
  }

  function handleFocus(label: string, sessionIds: string[]): void {
    setGraphFocus({ label, sessionIds });
    if (sessionIds.length > 0) {
      const nextId = noteListItems.find((item) => sessionIds.includes(item.id))?.id ?? sessionIds[0] ?? null;
      updateRoute({ note: nextId }, false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 px-4 py-4 sm:px-6 sm:py-6">
      <Card className="p-5">
        <CardHeader>
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">SaveMyContext</div>
            <CardTitle className="text-3xl leading-none">{categoryLabels[route.category]}</CardTitle>
            <CardDescription>{categoryDescriptions[route.category]}</CardDescription>
          </div>
          <Button variant="secondary" onClick={() => (window.location.href = chrome.runtime.getURL("dashboard.html"))}>
            <ArrowLeft className="h-4 w-4" />
            Overview
          </Button>
        </CardHeader>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[340px_1fr]">
        <div className="space-y-4">
          <Card className="p-4">
            <CardHeader>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Categories</div>
                <CardTitle className="mt-1 text-lg">Switch collection</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="mt-4 grid gap-2">
              {categoryOrder.map((category) => (
                <button
                  key={category}
                  type="button"
                  onClick={() => handleCategorySwitch(category)}
                  className={`rounded-[8px] border px-3 py-3 text-left transition ${
                    route.category === category ? "border-zinc-950 bg-zinc-950 text-white" : "border-zinc-200 bg-white hover:bg-zinc-50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold">{categoryLabels[category]}</span>
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: categoryPalette[category].accent }}
                    />
                  </div>
                </button>
              ))}
            </CardContent>
          </Card>

          <Card className="p-4">
            <CardHeader>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Explore</div>
                <CardTitle className="mt-1 text-lg">Search and filter</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="mt-4 space-y-3">
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
                    className="h-11 w-full rounded-[8px] border border-zinc-200 bg-white pl-10 pr-3 text-sm outline-none ring-0 transition focus:border-zinc-300"
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
                  <Select
                    value={route.sort}
                    onValueChange={(value) => updateRoute({ sort: value as CategorySortMode }, true)}
                  >
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
            </CardContent>
          </Card>

          <Card className="p-4">
            <CardHeader>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Snapshot</div>
                <CardTitle className="mt-1 text-lg">What this view contains</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="mt-4 grid grid-cols-2 gap-2">
              {statsCards(stats).map((metric) => (
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
                <CardTitle className="mt-1 text-lg">Activity and composition</CardTitle>
              </div>
              <div className="text-sm text-zinc-500">{noteListMeta(route, allSessions.length, visibleSessions.length, graphFocus)}</div>
            </CardHeader>
            <CardContent className="mt-4 space-y-4">
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Activity</div>
                <div className="h-[180px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={stats.activity}>
                      <defs>
                        <linearGradient id="categoryActivity" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={categoryPalette[route.category].accent} stopOpacity={0.3} />
                          <stop offset="100%" stopColor={categoryPalette[route.category].accent} stopOpacity={0.05} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#e4e4e7" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="bucket" tickFormatter={(value) => String(value).slice(5)} tick={{ fill: "#71717a", fontSize: 12 }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fill: "#71717a", fontSize: 12 }} tickLine={false} axisLine={false} allowDecimals={false} />
                      <Tooltip />
                      <Area type="monotone" dataKey="count" stroke={categoryPalette[route.category].accent} fill="url(#categoryActivity)" strokeWidth={2.5} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Providers</div>
                  <div className="h-[180px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={providerPie} dataKey="count" nameKey="label" innerRadius={40} outerRadius={64}>
                          {providerPie.map((item) => (
                            <Cell key={item.provider} fill={item.color} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(value, name) => [`${formatTooltipMetric(value)} notes`, String(name ?? "Provider")]} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div>
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Top signals</div>
                  <div className="space-y-2">
                    {signals.primary.slice(0, 5).map((item) => (
                      <div key={item.label} className="flex items-center justify-between gap-3 rounded-[8px] border border-zinc-200 bg-zinc-50 px-3 py-2">
                        <span className="truncate text-sm text-zinc-700">{item.label}</span>
                        <span className="text-sm font-semibold text-zinc-950">{formatNumber(item.count)}</span>
                      </div>
                    ))}
                    {!signals.primary.length ? <p className="text-sm text-zinc-500">No recurring signals yet.</p> : null}
                  </div>
                </div>
              </div>

              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Secondary signals</div>
                <div className="space-y-2">
                  {signals.secondary.slice(0, 5).map((item) => (
                    <div key={item.label} className="flex items-center justify-between gap-3 rounded-[8px] border border-zinc-200 bg-zinc-50 px-3 py-2">
                      <span className="truncate text-sm text-zinc-700">{item.label}</span>
                      <span className="text-sm font-semibold text-zinc-950">{formatNumber(item.count)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="p-5">
            <CardHeader>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Graph</div>
                <CardTitle className="mt-1 text-lg">{route.category === "factual" ? "Knowledge graph" : "Note relationships"}</CardTitle>
                <CardDescription>
                  {graphFocus
                    ? `${graph.node_count} nodes · ${graph.edge_count} edges · focus on ${graphFocus.label}`
                    : `${graph.node_count} nodes · ${graph.edge_count} edges`}
                </CardDescription>
              </div>
              {graphFocus ? (
                <Button variant="secondary" onClick={() => setGraphFocus(null)}>
                  Clear focus
                </Button>
              ) : null}
            </CardHeader>
            <CardContent className="mt-4">
              <CategoryGraph
                graph={graph}
                category={route.category}
                focusSessionIds={graphFocus?.sessionIds}
                onFocus={handleFocus}
              />
            </CardContent>
          </Card>

          <div className="grid gap-4 2xl:grid-cols-[360px_1fr]">
            <Card className="p-4">
              <CardHeader>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Results</div>
                  <CardTitle className="mt-1 text-lg">Matching notes</CardTitle>
                </div>
                <div className="text-sm text-zinc-500">{noteListMeta(route, allSessions.length, noteListItems.length, graphFocus)}</div>
              </CardHeader>
              <CardContent className="mt-4">
                <ScrollArea className="h-[520px] pr-4">
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
                          <div className={isActive ? "text-xs uppercase tracking-[0.08em] text-white/70" : "text-xs uppercase tracking-[0.08em] text-zinc-500"}>
                            {formatCompactDate(session.updated_at)}
                          </div>
                          <p className={isActive ? "mt-2 line-clamp-3 text-sm leading-6 text-white/80" : "mt-2 line-clamp-3 text-sm leading-6 text-zinc-600"}>
                            {match?.snippet || session.share_post || session.markdown_path || "Open to inspect this note."}
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
                      : "Select a note, graph node, or search result to inspect it."}
                  </CardDescription>
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
                          sort: route.sort
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

                    <ScrollArea className="h-[520px] pr-4">
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
                    Select a note from the list or graph to inspect its structured summary, transcript, and markdown.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {(error || sessionsQuery.error || searchQuery.error || statsQuery.error || graphQuery.error || noteQuery.error || status?.backendValidationError) ? (
        <div className="rounded-[8px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {status?.backendValidationError ||
            error ||
            (sessionsQuery.error instanceof Error && sessionsQuery.error.message) ||
            (searchQuery.error instanceof Error && searchQuery.error.message) ||
            (statsQuery.error instanceof Error && statsQuery.error.message) ||
            (graphQuery.error instanceof Error && graphQuery.error.message) ||
            (noteQuery.error instanceof Error && noteQuery.error.message) ||
            "Could not load the category explorer."}
        </div>
      ) : null}
    </div>
  );
}

mountApp(<App />);
