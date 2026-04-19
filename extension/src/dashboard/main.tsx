import { useMemo, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import {
  ArrowRight,
  BookOpen,
  ExternalLink,
  Layers,
  LoaderCircle,
  RefreshCcw,
  Search,
  SlidersHorizontal,
  Settings2
} from "lucide-react";

import {
  fetchDashboardSummary,
  fetchDiscardedSessions,
  fetchGraphEdges,
  fetchGraphNodes,
  fetchSessions,
  fetchSystemStatus,
  fetchTodoList,
  recoverDiscardedSession
} from "../background/backend";
import {
  categoryDescriptions,
  categoryGlyphs,
  categoryLabels,
  categoryOrder,
  categoryPageUrl,
  categoryPalette,
  titleFromSession
} from "../shared/explorer";
import type {
  BackendSessionListItem,
  ExtensionSettings,
  ProviderName,
  SessionCategoryName
} from "../shared/types";
import { mountApp } from "../ui/boot";
import { Button } from "../ui/components/button";
import {
  connectionTone,
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
import { sendRuntimeMessage, useExtensionBootstrap } from "../ui/lib/runtime";
import type { SourceCaptureResponse } from "../shared/types";

function openCategory(category: SessionCategoryName): void {
  window.location.href = categoryPageUrl({ category });
}

function sessionActivity(sessions: BackendSessionListItem[]): Array<{ day: string; sessions: number }> {
  const map = new Map<string, number>();
  for (const session of sessions) {
    const date = new Date(session.updated_at);
    if (Number.isNaN(date.getTime())) continue;
    const key = date.toISOString().slice(5, 10);
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-21)
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

function App() {
  const { settings, status, loading, error, reload } = useExtensionBootstrap();
  const [captureState, setCaptureState] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [captureMessage, setCaptureMessage] = useState<string>("");

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

  const todoQuery = useQuery({
    queryKey: ["dashboard-todo", settings?.backendUrl, settings?.backendToken],
    queryFn: () => fetchTodoList(settings as ExtensionSettings),
    enabled: Boolean(settings && !status?.backendValidationError)
  });

  const discardedQuery = useQuery({
    queryKey: ["dashboard-discarded", settings?.backendUrl, settings?.backendToken],
    queryFn: () => fetchDiscardedSessions(settings as ExtensionSettings),
    enabled: Boolean(settings && !status?.backendValidationError)
  });

  const queryClient = useQueryClient();
  const [recoverError, setRecoverError] = useState<string | null>(null);

  const recoverMutation = useMutation({
    mutationFn: (sessionId: string) =>
      recoverDiscardedSession(settings as ExtensionSettings, sessionId),
    onSuccess: async () => {
      setRecoverError(null);
      await Promise.all([
        discardedQuery.refetch(),
        summaryQuery.refetch(),
        sessionsQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["dashboard-graph-nodes"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-graph-edges"] })
      ]);
    },
    onError: (error: unknown) => {
      setRecoverError(error instanceof Error ? error.message : "Could not recover the session.");
    }
  });

  const summary = status?.backendValidationError ? null : summaryQuery.data ?? null;
  const systemStatus = systemQuery.data;
  const nodes = nodesQuery.data ?? [];
  const edges = edgesQuery.data ?? [];
  const sessions = sessionsQuery.data ?? [];
  const connection = status ? connectionTone(status) : { label: "Checking", tone: "neutral" as const };
  const processing = status ? processingTone(status) : { label: "Waiting", tone: "neutral" as const };

  const totalSessions = summary?.total_sessions ?? 0;
  const totalMessages = summary?.total_messages ?? 0;
  const totalTriplets = summary?.total_triplets ?? 0;
  const totalSyncEvents = summary?.total_sync_events ?? 0;

  const uniqueEntities = useMemo(() => {
    const labels = new Set<string>();
    for (const node of nodes) labels.add(node.label);
    return labels.size;
  }, [nodes]);

  const categoryData = useMemo(() => {
    const counts = new Map(summary?.categories.map((item) => [item.category, item.count] as const) ?? []);
    return categoryOrder
      .filter((category) => category !== "discarded")
      .map((category) => ({
        category,
        label: categoryLabels[category],
        count: counts.get(category) ?? 0,
        accent: categoryPalette[category].accent,
        description: categoryDescriptions[category]
      }));
  }, [summary]);

  const providerData = useMemo(() => providerMix(sessions), [sessions]);
  const maxProviderCount = Math.max(...providerData.map((item) => item.count), 1);
  const activityData = useMemo(() => sessionActivity(sessions), [sessions]);
  const topEntities = useMemo(
    () => [...nodes].sort((a, b) => b.degree - a.degree).slice(0, 6),
    [nodes]
  );
  const recentSessions = useMemo(
    () => [...sessions].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 6),
    [sessions]
  );

  async function refreshAll(): Promise<void> {
    await reload();
    await Promise.all([
      summaryQuery.refetch(),
      systemQuery.refetch(),
      nodesQuery.refetch(),
      edgesQuery.refetch(),
      sessionsQuery.refetch(),
      todoQuery.refetch(),
      discardedQuery.refetch()
    ]);
  }

  async function handleQuickSave(): Promise<void> {
    setCaptureState("saving");
    setCaptureMessage("Saving current page…");
    try {
      const response = await sendRuntimeMessage<SourceCaptureResponse>({
        type: "SAVE_CURRENT_PAGE_SOURCE",
        payload: { saveMode: "raw" }
      });
      if (!response.ok) throw new Error(response.error ?? "Could not save.");
      setCaptureState("done");
      setCaptureMessage(`Saved · ${response.title ?? "page"}`);
      await summaryQuery.refetch();
      await sessionsQuery.refetch();
    } catch (captureError) {
      setCaptureState("error");
      setCaptureMessage(captureError instanceof Error ? captureError.message : "Save failed");
    }
  }

  async function handleQuickSearch(): Promise<void> {
    await sendRuntimeMessage<{ ok: boolean; error?: string }>({ type: "OPEN_QUICK_SEARCH" });
  }

  const hasBackendError = Boolean(status?.backendValidationError);
  const connectionDot =
    connection.tone === "success"
      ? "bg-[var(--color-factual)]"
      : connection.tone === "warning"
        ? "bg-[var(--color-ideas)]"
        : connection.tone === "danger"
          ? "bg-[var(--color-todo)]"
          : "bg-[var(--color-ink-subtle)]";

  const isFetching =
    summaryQuery.isFetching ||
    systemQuery.isFetching ||
    nodesQuery.isFetching ||
    sessionsQuery.isFetching ||
    todoQuery.isFetching;

  return (
    <div className="app-page">
      <header className="app-page-header">
        <div className="app-page-heading">
          <div className="app-page-mark">C</div>
          <div>
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${connectionDot}`} />
              <span className="eyebrow">{connection.label}</span>
              {isFetching ? <LoaderCircle className="h-3.5 w-3.5 animate-spin text-[var(--color-ink-subtle)]" /> : null}
            </div>
            <h1 className="app-page-title">
              Your context, collected.
            </h1>
            <p className="app-page-copy max-w-[48ch]">
              {settings ? formatBackendLabel(settings) : loading ? "Loading…" : "Unavailable"}
              {status ? ` · ${formatBackendStatus(status)}` : ""}
            </p>
          </div>
        </div>
        <div className="app-page-actions">
          <Button variant="ghost" size="sm" onClick={() => void refreshAll()} disabled={isFetching}>
            <RefreshCcw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              window.location.href = chrome.runtime.getURL("piles.html");
            }}
          >
            <Layers className="h-3.5 w-3.5" />
            Piles
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              window.location.href = chrome.runtime.getURL("prompts.html");
            }}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Prompts
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void chrome.runtime.openOptionsPage()}>
            <Settings2 className="h-3.5 w-3.5" />
            Settings
          </Button>
        </div>
      </header>

      {hasBackendError ? (
        <div
          id="backend-alert"
          className="mb-6 rounded-[8px] border border-[rgba(193,90,64,0.35)] bg-[rgba(193,90,64,0.08)] px-5 py-4 text-sm text-[#8a3b27]"
        >
          <strong className="font-semibold">Backend unavailable.</strong> {status?.backendValidationError}
        </div>
      ) : (
        <div id="backend-alert" hidden aria-hidden="true" />
      )}

      <section className="mb-10 grid gap-4 md:grid-cols-[1.25fr_1fr]">
        <div className="surface overflow-hidden p-0">
          <div className="flex items-center justify-between border-b border-[var(--color-line)] px-6 py-4">
            <div>
              <div className="eyebrow">Now</div>
              <div className="display-serif mt-1 text-[22px] font-semibold text-[var(--color-ink)]">Capture & recall</div>
            </div>
            <div className="text-xs text-[var(--color-ink-subtle)]">
              Sync {formatCompactDate(summary?.latest_sync_at ?? status?.lastSuccessAt, "idle")}
            </div>
          </div>
          <div className="grid gap-2 p-4 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => void handleQuickSave()}
              disabled={captureState === "saving"}
              className="group flex items-center justify-between gap-3 rounded-[8px] bg-[var(--color-ink)] px-5 py-4 text-left text-[var(--color-paper)] transition hover:bg-[#1a2c44] disabled:opacity-70"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-[8px] bg-white/10">
                  {captureState === "saving" ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <BookOpen className="h-4 w-4" />
                  )}
                </div>
                <div>
                  <div className="text-[14px] font-semibold">Save current page</div>
                  <div className="text-[12px] text-white/60">
                    {captureMessage || "Save the active tab as a raw note"}
                  </div>
                </div>
              </div>
              <ArrowRight className="h-4 w-4 text-white/80 transition group-hover:translate-x-0.5" />
            </button>

            <button
              type="button"
              onClick={() => void handleQuickSearch()}
              className="flex items-center justify-between gap-3 rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] px-5 py-4 text-left transition hover:border-[var(--color-line-strong)] hover:bg-[#e6dfcd]"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-[8px] bg-[var(--color-paper-raised)]">
                  <Search className="h-4 w-4 text-[var(--color-ink)]" />
                </div>
                <div>
                  <div className="text-[14px] font-semibold text-[var(--color-ink)]">Quick search</div>
                  <div className="text-[12px] text-[var(--color-ink-subtle)]">
                    Find and inject a fact into the focused page
                  </div>
                </div>
              </div>
              <ArrowRight className="h-4 w-4 text-[var(--color-ink-subtle)]" />
            </button>
          </div>
        </div>

        <div className="surface grid grid-cols-2 gap-px overflow-hidden bg-[var(--color-line)] p-0">
          {[
            { label: "Sessions", value: formatNumber(totalSessions), id: "metric-sessions" },
            { label: "Messages", value: formatNumber(totalMessages), id: "metric-messages" },
            { label: "Facts", value: formatNumber(totalTriplets), id: "metric-triplets" },
            { label: "Sync events", value: formatNumber(totalSyncEvents), id: "metric-sync-events" }
          ].map((metric) => (
            <div key={metric.label} className="bg-[var(--color-paper-raised)] px-5 py-4">
              <div className="eyebrow">{metric.label}</div>
              <div
                id={metric.id}
                className="display-serif mt-2 text-[28px] font-semibold leading-none tabular-nums text-[var(--color-ink)]"
              >
                {metric.value}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-10">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="eyebrow">Collections</div>
            <h2 className="display-serif mt-1 text-[24px] font-semibold text-[var(--color-ink)]">
              Four shelves for every capture
            </h2>
          </div>
          <div id="category-total-label" className="text-sm text-[var(--color-ink-subtle)]">
            {formatNumber(totalSessions)} indexed sessions
          </div>
        </div>

        <div id="category-list" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {categoryData.map((item) => (
            <button
              key={item.category}
              type="button"
              onClick={() => openCategory(item.category)}
              className="group relative overflow-hidden rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-5 text-left transition hover:-translate-y-0.5 hover:border-[var(--color-line-strong)] hover:shadow-[0_14px_32px_-18px_rgba(15,27,44,0.22)]"
            >
              <div
                className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full opacity-50 transition group-hover:opacity-80"
                style={{ background: `radial-gradient(circle, ${item.accent}22, transparent 65%)` }}
              />
              <div className="flex items-start justify-between">
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-[8px]"
                  style={{ backgroundColor: `${item.accent}1a`, color: item.accent }}
                >
                  <span className="display-serif text-[19px] leading-none">{categoryGlyphs[item.category]}</span>
                </div>
                <span
                  className="display-serif text-[28px] font-semibold tabular-nums"
                  style={{ color: "var(--color-ink)" }}
                >
                  {formatNumber(item.count)}
                </span>
              </div>
              <div className="mt-5">
                <div className="display-serif text-[20px] font-semibold text-[var(--color-ink)]">{item.label}</div>
                <p className="mt-1.5 line-clamp-2 text-[13px] leading-5 text-[var(--color-ink-soft)]">
                  {item.description}
                </p>
              </div>
              <div className="mt-4 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.1em]" style={{ color: item.accent }}>
                Open shelf
                <ArrowRight className="h-3 w-3" />
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="mb-10">
        <div className="surface overflow-hidden p-0">
          <div className="flex items-center justify-between border-b border-[var(--color-line)] px-6 py-4">
            <div>
              <div className="eyebrow">Discarded</div>
              <div className="display-serif mt-1 text-[22px] font-semibold text-[var(--color-ink)]">
                Captured but shelved
              </div>
              <p className="mt-1 max-w-[68ch] text-[13px] leading-5 text-[var(--color-ink-soft)]">
                Sessions whose opening request matched a discard word (default: <code>loom</code>) land here. They never run
                through classification or notifications, but stay in the vault under <code>Discarded/</code> so you can
                recover them.
              </p>
            </div>
            <div className="text-xs tabular-nums text-[var(--color-ink-subtle)]">
              {formatNumber(discardedQuery.data?.count ?? 0)} item
              {discardedQuery.data?.count === 1 ? "" : "s"}
            </div>
          </div>
          <div className="px-6 py-4">
            {recoverError ? (
              <div className="mb-3 rounded-[8px] border border-[rgba(193,90,64,0.35)] bg-[rgba(193,90,64,0.08)] px-3 py-2 text-xs text-[#8a3b27]">
                {recoverError}
              </div>
            ) : null}
            {discardedQuery.isLoading ? (
              <div className="text-sm text-[var(--color-ink-subtle)]">Loading…</div>
            ) : discardedQuery.data?.items.length ? (
              <ul className="divide-y divide-[var(--color-line)]">
                {discardedQuery.data.items.slice(0, 10).map((item) => (
                  <li key={item.id} className="flex items-start justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[var(--color-ink)]">
                        {item.title?.trim() || `${providerLabels[item.provider]} · ${item.external_session_id}`}
                      </div>
                      <div className="mt-0.5 text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-subtle)]">
                        {providerLabels[item.provider]} · {formatCompactDate(item.last_captured_at ?? item.updated_at)}
                      </div>
                      {item.discarded_reason ? (
                        <div className="mt-1 line-clamp-2 text-[12px] text-[var(--color-ink-soft)]">
                          {item.discarded_reason}
                        </div>
                      ) : null}
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={recoverMutation.isPending && recoverMutation.variables === item.id}
                      onClick={() => recoverMutation.mutate(item.id)}
                    >
                      {recoverMutation.isPending && recoverMutation.variables === item.id ? "Recovering…" : "Recover"}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-sm text-[var(--color-ink-subtle)]">
                Nothing discarded. Say <code>loom</code> at the start of a session to route it here.
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="mb-10 grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <div className="surface overflow-hidden p-0">
          <div className="flex items-center justify-between border-b border-[var(--color-line)] px-6 py-4">
            <div>
              <div className="eyebrow">Pulse</div>
              <div className="display-serif mt-1 text-[22px] font-semibold text-[var(--color-ink)]">Capture activity</div>
            </div>
            <div className="text-xs text-[var(--color-ink-subtle)]">{activityData.length} active days</div>
          </div>
          <div className="h-[260px] px-4 pb-4 pt-6">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={activityData}>
                <defs>
                  <linearGradient id="sessionFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0f8a84" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#0f8a84" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#ebe4d1" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="day" tick={{ fill: "#8693a2", fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fill: "#8693a2", fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} width={26} />
                <Tooltip
                  contentStyle={{
                    borderRadius: 10,
                    border: "1px solid #ebe4d1",
                    background: "#fbf9f3",
                    fontSize: 12
                  }}
                  cursor={{ stroke: "#d7cfb9" }}
                />
                <Area type="monotone" dataKey="sessions" stroke="#0f8a84" fill="url(#sessionFill)" strokeWidth={2.25} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="surface p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="eyebrow">Sources</div>
              <div className="display-serif mt-1 text-[22px] font-semibold text-[var(--color-ink)]">Where it comes from</div>
            </div>
          </div>
          <div className="mt-5 space-y-3">
            {providerData.map((item) => (
              <div key={item.provider} className="space-y-1.5">
                <div className="flex items-center justify-between text-[13px]">
                  <span className="font-medium text-[var(--color-ink)]">{item.label}</span>
                  <span className="tabular-nums text-[var(--color-ink-soft)]">{formatNumber(item.count)}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-paper-sunken)]">
                  <div
                    className="h-full rounded-full transition-[width] duration-500"
                    style={{
                      width: `${(item.count / maxProviderCount) * 100}%`,
                      backgroundColor:
                        item.provider === "chatgpt"
                          ? "var(--color-factual)"
                          : item.provider === "gemini"
                            ? "var(--color-ideas)"
                            : "var(--color-journal)"
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mb-10 grid gap-4 xl:grid-cols-[1fr_1fr]">
        <div className="surface p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="eyebrow">Graph</div>
              <div className="display-serif mt-1 text-[22px] font-semibold text-[var(--color-ink)]">
                Top connected entities
              </div>
              <div id="graph-summary" className="mt-1 text-xs text-[var(--color-ink-subtle)]">
                <span id="metric-entities">{formatNumber(uniqueEntities)}</span> entities,{" "}
                <span id="metric-edges">{formatNumber(edges.length)}</span> edges
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => openCategory("factual")}>
              Atlas
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div id="top-entities" className="mt-4 space-y-2">
            {topEntities.map((node) => (
              <div
                key={node.id}
                className="flex items-center justify-between gap-3 rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-[var(--color-ink)]">{node.label}</div>
                  <div className="mt-0.5 text-[10.5px] uppercase tracking-[0.08em] text-[var(--color-ink-subtle)]">
                    {node.kind}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-1 w-16 overflow-hidden rounded-full bg-[var(--color-paper-sunken)]">
                    <div
                      className="h-full rounded-full bg-[var(--color-factual)]"
                      style={{
                        width: `${Math.min(100, (node.degree / Math.max(topEntities[0]?.degree ?? 1, 1)) * 100)}%`
                      }}
                    />
                  </div>
                  <span className="w-6 text-right text-[12px] font-semibold tabular-nums text-[var(--color-ink)]">
                    {node.degree}
                  </span>
                </div>
              </div>
            ))}
            {!topEntities.length ? (
              <div className="rounded-[8px] border border-dashed border-[var(--color-line)] bg-[var(--color-paper-sunken)] px-4 py-6 text-center text-sm text-[var(--color-ink-subtle)]">
                No entities yet — save a chat to populate the graph.
              </div>
            ) : null}
          </div>
        </div>

        <div className="surface p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="eyebrow">Latest</div>
              <div className="display-serif mt-1 text-[22px] font-semibold text-[var(--color-ink)]">
                Recently indexed
              </div>
            </div>
          </div>

          <div className="mt-4 space-y-2">
            {recentSessions.map((session) => {
              const category = (session.category ?? "factual") as SessionCategoryName;
              const accent = categoryPalette[category].accent;
              return (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => openCategory(category)}
                  className="group flex w-full items-center gap-3 rounded-[8px] px-2 py-2 text-left transition hover:bg-[var(--color-paper-sunken)]"
                >
                  <span className="h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: accent }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold text-[var(--color-ink)]">
                      {titleFromSession(session)}
                    </span>
                    <span className="mt-0.5 block truncate text-[11.5px] text-[var(--color-ink-subtle)]">
                      {categoryLabels[category]} · {providerLabels[session.provider]} · {formatCompactDate(session.updated_at)}
                    </span>
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 text-[var(--color-ink-subtle)] opacity-0 transition group-hover:opacity-100" />
                </button>
              );
            })}
            {!recentSessions.length ? (
              <div className="rounded-[8px] border border-dashed border-[var(--color-line)] bg-[var(--color-paper-sunken)] px-4 py-6 text-center text-sm text-[var(--color-ink-subtle)]">
                Recent captures will appear here.
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
        <div className="surface p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="eyebrow">System</div>
              <div className="display-serif mt-1 text-[22px] font-semibold text-[var(--color-ink)]">Vault & processing</div>
            </div>
            <div className="flex items-center gap-2">
              <span className="eyebrow">{processing.label}</span>
            </div>
          </div>

          <dl className="mt-5 grid gap-px overflow-hidden rounded-[8px] border border-[var(--color-line)] bg-[var(--color-line)] sm:grid-cols-2">
            <div className="bg-[var(--color-paper-raised)] p-4">
              <dt className="eyebrow">Auth mode</dt>
              <dd id="system-auth-mode" className="mt-2 text-[14px] font-medium text-[var(--color-ink)]">
                {systemStatus?.auth_mode ?? "—"}
              </dd>
            </div>
            <div className="bg-[var(--color-paper-raised)] p-4">
              <dt className="eyebrow">Processing</dt>
              <dd className="mt-2 text-[14px] font-medium text-[var(--color-ink)]">
                {status ? formatProcessing(status) : "—"}
              </dd>
            </div>
            <div className="bg-[var(--color-paper-raised)] p-4 sm:col-span-2">
              <dt className="eyebrow">Vault</dt>
              <dd className="mt-2 break-all text-[13px] text-[var(--color-ink)]">
                {systemStatus?.vault_root ?? "—"}
              </dd>
            </div>
            <div className="bg-[var(--color-paper-raised)] p-4 sm:col-span-2">
              <dt className="eyebrow">Shared list</dt>
              <dd id="system-todo-path" className="mt-2 break-all text-[13px] text-[var(--color-ink)]">
                {systemStatus?.todo_list_path ?? "—"}
              </dd>
            </div>
            <div className="bg-[var(--color-paper-raised)] p-4">
              <dt className="eyebrow">History sync</dt>
              <dd className="mt-2 text-[13px] text-[var(--color-ink)]">
                {settings && status ? formatHistorySync(settings, status) : "—"}
              </dd>
            </div>
            <div className="bg-[var(--color-paper-raised)] p-4">
              <dt className="eyebrow">Last error</dt>
              <dd id="health-last-error" className="mt-2 break-all text-[13px] text-[var(--color-ink)]">
                {status?.lastError ?? status?.historySyncLastError ?? status?.processingLastError ?? "None"}
              </dd>
            </div>
          </dl>

          {status?.providerDriftAlert ? (
            <div className="mt-4 rounded-[8px] border border-[rgba(209,132,37,0.35)] bg-[rgba(209,132,37,0.08)] px-4 py-3 text-[13px] text-[#8a561a]">
              {formatProviderDriftAlert(status.providerDriftAlert)}
            </div>
          ) : null}
        </div>

        <div className="surface p-5">
          <div>
            <div className="eyebrow">Shared list</div>
            <div className="display-serif mt-1 text-[22px] font-semibold text-[var(--color-ink)]">To-Do pulse</div>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-px overflow-hidden rounded-[8px] border border-[var(--color-line)] bg-[var(--color-line)]">
            <div className="bg-[var(--color-paper-raised)] p-4">
              <div className="eyebrow">Total</div>
              <div className="display-serif mt-2 text-[22px] font-semibold text-[var(--color-ink)]">
                {formatNumber(todoQuery.data?.total_count)}
              </div>
            </div>
            <div className="bg-[var(--color-paper-raised)] p-4">
              <div className="eyebrow">Active</div>
              <div className="display-serif mt-2 text-[22px] font-semibold text-[var(--color-ink)]">
                {formatNumber(todoQuery.data?.active_count)}
              </div>
            </div>
            <div className="bg-[var(--color-paper-raised)] p-4">
              <div className="eyebrow">Done</div>
              <div className="display-serif mt-2 text-[22px] font-semibold text-[var(--color-ink)]">
                {formatNumber(todoQuery.data?.completed_count)}
              </div>
            </div>
          </div>
          <Button variant="secondary" size="sm" className="mt-5 w-full justify-center" onClick={() => openCategory("todo")}>
            Open To-Do shelf
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>

          {systemStatus?.public_url ? (
            <a
              href={systemStatus.public_url}
              target="_blank"
              rel="noreferrer"
              className="mt-3 flex items-center justify-center gap-1 text-[12px] text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]"
            >
              <ExternalLink className="h-3 w-3" /> Public endpoint
            </a>
          ) : null}
        </div>
      </section>

      {error ||
      summaryQuery.error ||
      systemQuery.error ||
      nodesQuery.error ||
      edgesQuery.error ||
      sessionsQuery.error ||
      todoQuery.error ? (
        <div className="mt-6 rounded-[8px] border border-[rgba(193,90,64,0.35)] bg-[rgba(193,90,64,0.08)] px-4 py-3 text-sm text-[#8a3b27]">
          {error ||
            (summaryQuery.error instanceof Error && summaryQuery.error.message) ||
            (systemQuery.error instanceof Error && systemQuery.error.message) ||
            (nodesQuery.error instanceof Error && nodesQuery.error.message) ||
            (edgesQuery.error instanceof Error && edgesQuery.error.message) ||
            (sessionsQuery.error instanceof Error && sessionsQuery.error.message) ||
            (todoQuery.error instanceof Error && todoQuery.error.message) ||
            "Could not load dashboard data."}
        </div>
      ) : null}
    </div>
  );
}

mountApp(<App />);
