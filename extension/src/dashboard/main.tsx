import { useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import * as Tabs from "@radix-ui/react-tabs";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, BrainCircuit, Database, FolderKanban, RefreshCcw, Settings2 } from "lucide-react";

import {
  fetchDashboardSummary,
  fetchGraphEdges,
  fetchGraphNodes,
  fetchSessions,
  fetchSystemStatus
} from "../background/backend";
import { categoryDescriptions, categoryLabels, categoryPageUrl, titleFromSession } from "../shared/explorer";
import type { BackendSessionListItem, ExtensionSettings, ProviderName, SessionCategoryName } from "../shared/types";
import { mountApp } from "../ui/boot";
import { Badge } from "../ui/components/badge";
import { Button } from "../ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/components/card";
import { ScrollArea } from "../ui/components/scroll-area";
import {
  connectionTone,
  enabledProviderLabels,
  formatBackendLabel,
  formatBackendStatus,
  formatCompactDate,
  formatHistorySync,
  formatNumber,
  formatProcessing,
  formatProviderDriftAlert,
  processingTone,
  providerLabels
} from "../ui/lib/format";
import { useExtensionBootstrap } from "../ui/lib/runtime";

const categoryColors: Record<SessionCategoryName, string> = {
  factual: "#0f8a84",
  ideas: "#c77724",
  journal: "#1d8aac",
  todo: "#b4543a"
};

function readInitialTab(): "overview" | "knowledge" | "operations" {
  const params = new URLSearchParams(window.location.search);
  if (params.get("view") === "processing") {
    return "operations";
  }
  if (params.get("focus") === "triplets") {
    return "knowledge";
  }
  return "overview";
}

function readHighlightedCategory(): SessionCategoryName | null {
  const raw = new URLSearchParams(window.location.search).get("category");
  return raw === "factual" || raw === "ideas" || raw === "journal" || raw === "todo" ? raw : null;
}

function openCategory(category: SessionCategoryName): void {
  window.location.href = categoryPageUrl({ category });
}

function sessionActivity(sessions: BackendSessionListItem[]): Array<{ day: string; sessions: number }> {
  const map = new Map<string, number>();
  for (const session of sessions) {
    const date = new Date(session.updated_at);
    if (Number.isNaN(date.getTime())) {
      continue;
    }
    const key = date.toISOString().slice(5, 10);
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  return Array.from(map.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-14)
    .map(([day, count]) => ({ day, sessions: count }));
}

function providerMix(sessions: BackendSessionListItem[]): Array<{ provider: ProviderName; label: string; count: number }> {
  const counts = new Map<ProviderName, number>();
  for (const session of sessions) {
    counts.set(session.provider, (counts.get(session.provider) ?? 0) + 1);
  }

  return (["chatgpt", "gemini", "grok"] as const).map((provider) => ({
    provider,
    label: providerLabels[provider],
    count: counts.get(provider) ?? 0
  }));
}

function formatTooltipMetric(value: unknown): string {
  return formatNumber(typeof value === "number" ? value : Number(value ?? 0));
}

function App() {
  const { settings, status, loading, error, reload } = useExtensionBootstrap();
  const [currentTab, setCurrentTab] = useState<"overview" | "knowledge" | "operations">(readInitialTab());
  const highlightedCategory = readHighlightedCategory();

  const summaryQuery = useQuery({
    queryKey: ["dashboard-summary", settings?.backendUrl, settings?.backendToken],
    queryFn: () => fetchDashboardSummary(settings as ExtensionSettings),
    enabled: Boolean(settings && !status?.backendValidationError)
  });

  const systemQuery = useQuery({
    queryKey: ["dashboard-system", settings?.backendUrl, settings?.backendToken],
    queryFn: () => fetchSystemStatus(settings as ExtensionSettings),
    enabled: Boolean(settings && !status?.backendValidationError)
  });

  const nodesQuery = useQuery({
    queryKey: ["dashboard-graph-nodes", settings?.backendUrl, settings?.backendToken],
    queryFn: () => fetchGraphNodes(settings as ExtensionSettings),
    enabled: Boolean(settings && !status?.backendValidationError)
  });

  const edgesQuery = useQuery({
    queryKey: ["dashboard-graph-edges", settings?.backendUrl, settings?.backendToken],
    queryFn: () => fetchGraphEdges(settings as ExtensionSettings),
    enabled: Boolean(settings && !status?.backendValidationError)
  });

  const sessionsQuery = useQuery({
    queryKey: ["dashboard-sessions", settings?.backendUrl, settings?.backendToken],
    queryFn: () => fetchSessions(settings as ExtensionSettings),
    enabled: Boolean(settings && !status?.backendValidationError)
  });

  const summary = status?.backendValidationError ? null : summaryQuery.data ?? null;
  const nodes = nodesQuery.data ?? [];
  const edges = edgesQuery.data ?? [];
  const sessions = sessionsQuery.data ?? [];
  const connection = status ? connectionTone(status) : { label: "Checking", tone: "neutral" as const };
  const processing = status ? processingTone(status) : { label: "Waiting", tone: "neutral" as const };

  const categoryData = useMemo(() => {
    const counts = new Map(summary?.categories.map((item) => [item.category, item.count] as const) ?? []);
    return (["factual", "ideas", "journal", "todo"] as const).map((category) => ({
      category,
      label: categoryLabels[category],
      count: counts.get(category) ?? 0,
      color: categoryColors[category]
    }));
  }, [summary]);

  const providerData = useMemo(() => providerMix(sessions), [sessions]);
  const activityData = useMemo(() => sessionActivity(sessions), [sessions]);
  const topEntities = useMemo(
    () =>
      [...nodes]
        .sort((left, right) => right.degree - left.degree)
        .slice(0, 8)
        .map((node) => ({
          label: node.label.length > 18 ? `${node.label.slice(0, 18)}…` : node.label,
          degree: node.degree
        })),
    [nodes]
  );
  const recentSessions = useMemo(
    () => [...sessions].sort((left, right) => right.updated_at.localeCompare(left.updated_at)).slice(0, 8),
    [sessions]
  );

  async function refreshAll(): Promise<void> {
    await reload();
    await Promise.all([
      summaryQuery.refetch(),
      systemQuery.refetch(),
      nodesQuery.refetch(),
      edgesQuery.refetch(),
      sessionsQuery.refetch()
    ]);
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-4 sm:px-6 sm:py-6">
      <Card className="p-5">
        <CardHeader>
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">SaveMyContext Dashboard</div>
            <CardTitle className="text-3xl leading-none">Context Operations</CardTitle>
            <CardDescription>
              Monitor corpus growth, graph coverage, provider capture, and backend storage from one place.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={connection.tone}>{connection.label}</Badge>
            <Button variant="secondary" onClick={() => void refreshAll()}>
              <RefreshCcw className="h-4 w-4" />
              Refresh
            </Button>
            <Button variant="secondary" onClick={() => void chrome.runtime.openOptionsPage()}>
              <Settings2 className="h-4 w-4" />
              Settings
            </Button>
          </div>
        </CardHeader>

        <CardContent className="mt-5 grid gap-3 md:grid-cols-[1.7fr_1fr]">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: "Sessions", value: formatNumber(summary?.total_sessions), icon: Database },
              { label: "Messages", value: formatNumber(summary?.total_messages), icon: Activity },
              { label: "Facts", value: formatNumber(summary?.total_triplets), icon: BrainCircuit },
              { label: "Graph nodes", value: formatNumber(nodes.length), icon: FolderKanban }
            ].map((metric) => (
              <div key={metric.label} className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
                <metric.icon className="h-4 w-4 text-zinc-400" />
                <div className="mt-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">{metric.label}</div>
                <div className="mt-2 text-3xl font-semibold leading-none text-zinc-950">{metric.value}</div>
              </div>
            ))}
          </div>

          <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Backend</div>
                <div className="mt-1 text-base font-semibold text-zinc-950">
                  {settings ? formatBackendLabel(settings) : loading ? "Loading" : "Unavailable"}
                </div>
              </div>
              <Badge tone={processing.tone}>{processing.label}</Badge>
            </div>
            <div className="space-y-2 text-sm leading-6 text-zinc-600">
              <p>{status ? formatBackendStatus(status) : error ?? "Checking backend configuration"}</p>
              <p>{settings && status ? formatHistorySync(settings, status) : "Loading sync status"}</p>
              <p>{status ? formatProcessing(status) : "Loading processing state"}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs.Root value={currentTab} onValueChange={(value) => setCurrentTab(value as typeof currentTab)}>
        <div className="flex items-center justify-between gap-4">
          <Tabs.List className="inline-flex rounded-[8px] border border-zinc-200 bg-white p-1 shadow-sm">
            {[
              { value: "overview", label: "Overview" },
              { value: "knowledge", label: "Knowledge" },
              { value: "operations", label: "Operations" }
            ].map((tab) => (
              <Tabs.Trigger
                key={tab.value}
                value={tab.value}
                className="rounded-[6px] px-3 py-2 text-sm font-medium text-zinc-500 outline-none transition data-[state=active]:bg-zinc-950 data-[state=active]:text-white"
              >
                {tab.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          {summaryQuery.isFetching || systemQuery.isFetching || nodesQuery.isFetching || sessionsQuery.isFetching ? (
            <div className="text-sm text-zinc-500">Refreshing data…</div>
          ) : null}
        </div>

        <Tabs.Content value="overview" className="mt-4 space-y-4 outline-none">
          <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
            <Card className="p-5">
              <CardHeader>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Corpus mix</div>
                  <CardTitle className="mt-1">What is stored</CardTitle>
                </div>
                <div className="text-sm text-zinc-500">
                  {summary ? `${formatNumber(summary.total_sessions)} indexed sessions` : "No corpus data yet"}
                </div>
              </CardHeader>
              <CardContent className="mt-4 grid gap-4 lg:grid-cols-[260px_1fr]">
                <div className="h-[240px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={categoryData} dataKey="count" nameKey="label" innerRadius={60} outerRadius={92} paddingAngle={3}>
                        {categoryData.map((entry) => (
                          <Cell key={entry.category} fill={entry.color} onClick={() => openCategory(entry.category)} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value, name) => [`${formatTooltipMetric(value)} notes`, String(name ?? "Category")]} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {categoryData.map((item) => (
                    <button
                      key={item.category}
                      type="button"
                      onClick={() => openCategory(item.category)}
                      className={`rounded-[8px] border p-4 text-left transition hover:border-zinc-300 hover:bg-zinc-50 ${
                        highlightedCategory === item.category ? "border-zinc-950 bg-zinc-950 text-white" : "border-zinc-200 bg-white"
                      }`}
                    >
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                          <span className="text-sm font-semibold">{item.label}</span>
                        </div>
                        <span className="text-lg font-semibold">{formatNumber(item.count)}</span>
                      </div>
                      <p className={highlightedCategory === item.category ? "text-sm text-white/80" : "text-sm text-zinc-500"}>
                        {categoryDescriptions[item.category]}
                      </p>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="p-5">
              <CardHeader>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Capture activity</div>
                  <CardTitle className="mt-1">Recent session flow</CardTitle>
                </div>
                <div className="text-sm text-zinc-500">{activityData.length ? "Last 14 active buckets" : "No recent activity yet"}</div>
              </CardHeader>
              <CardContent className="mt-4">
                <div className="h-[280px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={activityData}>
                      <defs>
                        <linearGradient id="sessionFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#0f8a84" stopOpacity={0.32} />
                          <stop offset="100%" stopColor="#0f8a84" stopOpacity={0.04} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#e4e4e7" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="day" tick={{ fill: "#71717a", fontSize: 12 }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fill: "#71717a", fontSize: 12 }} tickLine={false} axisLine={false} allowDecimals={false} />
                      <Tooltip />
                      <Area type="monotone" dataKey="sessions" stroke="#0f8a84" fill="url(#sessionFill)" strokeWidth={2.5} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
            <Card className="p-5">
              <CardHeader>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Providers</div>
                  <CardTitle className="mt-1">Where context is coming from</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="mt-4">
                <div className="h-[240px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={providerData}>
                      <CartesianGrid stroke="#e4e4e7" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="label" tick={{ fill: "#71717a", fontSize: 12 }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fill: "#71717a", fontSize: 12 }} tickLine={false} axisLine={false} allowDecimals={false} />
                      <Tooltip formatter={(value) => `${formatTooltipMetric(value)} sessions`} />
                      <Bar dataKey="count" radius={[8, 8, 0, 0]}>
                        {providerData.map((entry) => (
                          <Cell
                            key={entry.provider}
                            fill={entry.provider === "chatgpt" ? "#0f8a84" : entry.provider === "gemini" ? "#c77724" : "#1d8aac"}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card className="p-5">
              <CardHeader>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Recent notes</div>
                  <CardTitle className="mt-1">Latest indexed sessions</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="mt-4">
                <ScrollArea className="h-[240px] pr-4">
                  <div className="space-y-2">
                    {recentSessions.map((session) => (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => openCategory((session.category ?? "factual") as SessionCategoryName)}
                        className="w-full rounded-[8px] border border-zinc-200 bg-white p-3 text-left transition hover:border-zinc-300 hover:bg-zinc-50"
                      >
                        <div className="mb-1 text-sm font-semibold text-zinc-900">{titleFromSession(session)}</div>
                        <div className="text-xs uppercase tracking-[0.08em] text-zinc-500">
                          {providerLabels[session.provider]} · {formatCompactDate(session.updated_at)}
                        </div>
                      </button>
                    ))}
                    {!recentSessions.length ? <p className="text-sm text-zinc-500">No indexed sessions yet.</p> : null}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </div>
        </Tabs.Content>

        <Tabs.Content value="knowledge" className="mt-4 space-y-4 outline-none">
          <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
            <Card className="p-5">
              <CardHeader>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Graph coverage</div>
                  <CardTitle className="mt-1">Knowledge map density</CardTitle>
                </div>
                <div className="text-sm text-zinc-500">
                  {formatNumber(nodes.length)} entities · {formatNumber(edges.length)} relationships
                </div>
              </CardHeader>
              <CardContent className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Graph nodes</div>
                  <div className="mt-2 text-3xl font-semibold text-zinc-950">{formatNumber(nodes.length)}</div>
                </div>
                <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Graph edges</div>
                  <div className="mt-2 text-3xl font-semibold text-zinc-950">{formatNumber(edges.length)}</div>
                </div>
                <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Facts per session</div>
                  <div className="mt-2 text-3xl font-semibold text-zinc-950">
                    {summary?.total_sessions ? (summary.total_triplets / summary.total_sessions).toFixed(1) : "0.0"}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="p-5">
              <CardHeader>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Backend reach</div>
                  <CardTitle className="mt-1">Enabled providers</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="mt-4 flex flex-wrap gap-2">
                {settings
                  ? enabledProviderLabels(settings).map((label) => (
                      <Badge key={label} tone="neutral">
                        {label}
                      </Badge>
                    ))
                  : null}
              </CardContent>
            </Card>
          </div>

          <Card className="p-5">
            <CardHeader>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Top entities</div>
                <CardTitle className="mt-1">Most connected nodes</CardTitle>
              </div>
              <div className="text-sm text-zinc-500">Highest degree entities in the current corpus</div>
            </CardHeader>
            <CardContent className="mt-4">
              <div className="h-[320px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={topEntities} layout="vertical" margin={{ left: 12 }}>
                    <CartesianGrid stroke="#e4e4e7" strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" tick={{ fill: "#71717a", fontSize: 12 }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <YAxis
                      type="category"
                      dataKey="label"
                      tick={{ fill: "#71717a", fontSize: 12 }}
                      tickLine={false}
                      axisLine={false}
                      width={140}
                    />
                    <Tooltip formatter={(value) => `${formatTooltipMetric(value)} edges`} />
                    <Bar dataKey="degree" fill="#0f8a84" radius={[0, 8, 8, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </Tabs.Content>

        <Tabs.Content value="operations" className="mt-4 space-y-4 outline-none">
          <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
            <Card className="p-5">
              <CardHeader>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Runtime health</div>
                  <CardTitle className="mt-1">Extension and backend</CardTitle>
                </div>
                <div className="text-sm text-zinc-500">
                  Latest success · {formatCompactDate(status?.lastSuccessAt, "No sync yet")}
                </div>
              </CardHeader>
              <CardContent className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Backend</div>
                  <div className="mt-2 text-sm font-semibold text-zinc-950">
                    {settings ? formatBackendLabel(settings) : "Unavailable"}
                  </div>
                  <p className="mt-2 text-sm leading-6 text-zinc-600">{status ? formatBackendStatus(status) : error ?? "Loading"}</p>
                </div>
                <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Processing</div>
                  <div className="mt-2 text-sm font-semibold text-zinc-950">{status ? formatProcessing(status) : "Loading"}</div>
                  <p className="mt-2 text-sm leading-6 text-zinc-600">
                    Pending jobs · {formatNumber(status?.processingPendingCount)} · last session {status?.lastSessionKey ?? "n/a"}
                  </p>
                </div>
                <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4 sm:col-span-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">History sync</div>
                  <p className="mt-2 text-sm leading-6 text-zinc-600">
                    {settings && status ? formatHistorySync(settings, status) : "Loading sync status"}
                  </p>
                </div>
                {status?.providerDriftAlert ? (
                  <div className="rounded-[8px] border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-800 sm:col-span-2">
                    {formatProviderDriftAlert(status.providerDriftAlert)}
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card className="p-5">
              <CardHeader>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Storage</div>
                  <CardTitle className="mt-1">Service footprint</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="mt-4 space-y-3 text-sm leading-6 text-zinc-600">
                <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Vault root</div>
                  <div className="mt-2 break-all text-zinc-900">{systemQuery.data?.vault_root ?? "Loading"}</div>
                </div>
                <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Markdown root</div>
                  <div className="mt-2 break-all text-zinc-900">{systemQuery.data?.markdown_root ?? "Loading"}</div>
                </div>
                <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Auth mode</div>
                  <div className="mt-2 text-zinc-900">{systemQuery.data?.auth_mode ?? "Loading"}</div>
                </div>
              </CardContent>
            </Card>
          </div>
        </Tabs.Content>
      </Tabs.Root>

      {(error || summaryQuery.error || systemQuery.error || nodesQuery.error || edgesQuery.error || sessionsQuery.error) && (
        <div className="rounded-[8px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error ||
            (summaryQuery.error instanceof Error && summaryQuery.error.message) ||
            (systemQuery.error instanceof Error && systemQuery.error.message) ||
            (nodesQuery.error instanceof Error && nodesQuery.error.message) ||
            (edgesQuery.error instanceof Error && edgesQuery.error.message) ||
            (sessionsQuery.error instanceof Error && sessionsQuery.error.message) ||
            "Could not load dashboard data."}
        </div>
      )}
    </div>
  );
}

mountApp(<App />);
