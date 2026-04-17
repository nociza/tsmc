import { useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { BookOpen, BrainCircuit, Database, LoaderCircle, MessageSquare, Search, Settings2, Sparkles } from "lucide-react";
import { Cell, Pie, PieChart, Tooltip } from "recharts";

import { fetchDashboardSummary, fetchSessions } from "../background/backend";
import { categoryLabels, categoryOrder, categoryPageUrl, notePageUrl, providerLabels, titleFromSession } from "../shared/explorer";
import type {
  BackendDashboardSummary,
  BackendSessionListItem,
  ExtensionSettings,
  SessionCategoryName,
  SourceCaptureResponse,
  SyncStatus
} from "../shared/types";
import { mountApp } from "../ui/boot";
import { Badge } from "../ui/components/badge";
import { Button } from "../ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/components/card";
import {
  connectionTone,
  formatBackendLabel,
  formatBackendStatus,
  formatCompactDate,
  formatHistorySync,
  formatNumber,
  formatProcessing,
  formatProviderDriftAlert,
  historyTone,
  processingButtonState,
  processingTone
} from "../ui/lib/format";
import { sendRuntimeMessage, useExtensionBootstrap } from "../ui/lib/runtime";

type DashboardRouteState = {
  category?: SessionCategoryName | null;
  view?: "notes" | "processing" | null;
  focus?: "triplets" | null;
};

const categoryColors: Record<SessionCategoryName, string> = {
  factual: "#0f8a84",
  ideas: "#c77724",
  journal: "#1d8aac",
  todo: "#b4543a"
};

function dashboardUrl(state: DashboardRouteState = {}): string {
  const url = new URL(chrome.runtime.getURL("dashboard.html"));
  if (state.category) {
    url.searchParams.set("category", state.category);
  }
  if (state.view) {
    url.searchParams.set("view", state.view);
  }
  if (state.focus) {
    url.searchParams.set("focus", state.focus);
  }
  return url.toString();
}

function openDashboard(state: DashboardRouteState = {}): void {
  void chrome.tabs.create({ url: dashboardUrl(state) });
  window.close();
}

function openCategory(category: SessionCategoryName): void {
  void chrome.tabs.create({ url: categoryPageUrl({ category }) });
  window.close();
}

function openNote(session: BackendSessionListItem): void {
  void chrome.tabs.create({
    url: notePageUrl({ id: session.id, category: session.category ?? "factual" })
  });
  window.close();
}

function summaryOrNull(summary: BackendDashboardSummary | undefined, status: SyncStatus | null): BackendDashboardSummary | null {
  if (!summary || status?.backendValidationError) {
    return null;
  }
  return summary;
}

function formatTooltipNumber(value: unknown): string {
  return formatNumber(typeof value === "number" ? value : Number(value ?? 0));
}

function PopupApp() {
  const { settings, status, loading, error, reload } = useExtensionBootstrap();
  const [captureStatus, setCaptureStatus] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [hoveredCategory, setHoveredCategory] = useState<SessionCategoryName | null>(null);

  const summaryQuery = useQuery({
    queryKey: ["popup-summary", settings?.backendUrl, settings?.backendToken],
    queryFn: () => fetchDashboardSummary(settings as ExtensionSettings),
    enabled: Boolean(settings && !status?.backendValidationError)
  });

  const sessionsQuery = useQuery({
    queryKey: ["popup-sessions", settings?.backendUrl, settings?.backendToken],
    queryFn: () => fetchSessions(settings as ExtensionSettings),
    enabled: Boolean(settings && !status?.backendValidationError)
  });

  const summary = summaryOrNull(summaryQuery.data, status);
  const recentSessions = useMemo(
    () => [...(sessionsQuery.data ?? [])].sort((left, right) => right.updated_at.localeCompare(left.updated_at)).slice(0, 4),
    [sessionsQuery.data]
  );
  const connection = status ? connectionTone(status) : { label: "Checking", tone: "neutral" as const };
  const history = settings && status ? historyTone(settings, status) : { label: "Waiting", tone: "neutral" as const };
  const processing = status ? processingTone(status) : { label: "Waiting", tone: "neutral" as const };
  const runQueueState = status ? processingButtonState(status) : { disabled: true, label: "Run queue", title: "Loading" };

  const categoryData = useMemo(() => {
    const counts = new Map(summary?.categories.map((item) => [item.category, item.count] as const) ?? []);
    const total = summary?.categories.reduce((current, item) => current + item.count, 0) ?? 0;
    return categoryOrder.map((category) => {
      const count = counts.get(category) ?? 0;
      return {
        category,
        label: categoryLabels[category],
        count,
        share: total ? (count / total) * 100 : 0,
        color: categoryColors[category]
      };
    });
  }, [summary]);
  const featuredCategory = hoveredCategory ?? categoryData.find((item) => item.count > 0)?.category ?? "factual";
  const featuredCategoryData = categoryData.find((item) => item.category === featuredCategory) ?? categoryData[0];
  const lastErrorText = status?.lastError ?? status?.historySyncLastError ?? status?.processingLastError ?? "None";

  async function handleSaveCurrentPage(): Promise<void> {
    setCaptureStatus("Saving current page…");
    setActionError(null);

    try {
      const response = await sendRuntimeMessage<SourceCaptureResponse>({
        type: "SAVE_CURRENT_PAGE_SOURCE",
        payload: { saveMode: "ai" }
      });

      if (!response.ok) {
        throw new Error(response.error ?? "Could not save the current page.");
      }

      setCaptureStatus(`Saved ${response.title ?? "page"} to SaveMyContext.`);
      await reload();
      await summaryQuery.refetch();
    } catch (captureError) {
      const message = captureError instanceof Error ? captureError.message : "Could not save the current page.";
      setCaptureStatus(message);
      setActionError(message);
    }
  }

  async function handleQuickSearch(): Promise<void> {
    setActionError(null);
    const response = await sendRuntimeMessage<{ ok: boolean; error?: string }>({ type: "OPEN_QUICK_SEARCH" });
    if (!response.ok) {
      setActionError(response.error ?? "Could not open quick search on the current page.");
      return;
    }
    window.close();
  }

  async function handleRunQueue(): Promise<void> {
    setActionError(null);
    const response = await sendRuntimeMessage<{ ok: boolean; error?: string }>({ type: "START_PROCESSING" });
    if (!response.ok) {
      setActionError(response.error ?? "AI processing failed.");
      return;
    }

    await reload();
    await summaryQuery.refetch();
  }

  return (
    <div className="mx-auto grid h-[560px] w-full max-w-[640px] grid-rows-[auto_auto_auto_1fr_auto_auto] gap-2 overflow-hidden p-3" data-testid="popup-root">
      <div className="sr-only">
        <span id="last-session">{status?.lastSessionKey ?? ""}</span>
        <span id="last-error">{lastErrorText}</span>
      </div>

      <header className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold text-zinc-500">SaveMyContext</div>
          <h1 className="mt-0.5 text-2xl font-semibold leading-none text-zinc-950">Context Workspace</h1>
        </div>
        <div className="flex items-center gap-2">
          {summaryQuery.isFetching || sessionsQuery.isFetching ? <LoaderCircle className="h-4 w-4 animate-spin text-zinc-400" /> : null}
          <Badge tone={connection.tone}>{connection.label}</Badge>
        </div>
      </header>

      <div className="panel-surface grid h-[58px] grid-cols-[1.35fr_1fr_1fr] overflow-hidden rounded-[8px]">
        <div className="border-r border-zinc-200 px-3 py-2">
          <div className="text-[11px] font-semibold text-zinc-500">Backend</div>
          <div className="mt-0.5 truncate text-sm font-medium text-zinc-950">
            {settings ? formatBackendLabel(settings) : loading ? "Loading" : "Unavailable"}
          </div>
          <div className="truncate text-xs text-zinc-500">{status ? formatBackendStatus(status) : error ?? "Checking configuration"}</div>
        </div>
        <div className="border-r border-zinc-200 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] font-semibold text-zinc-500">History</div>
            <Badge tone={history.tone} className="px-2 py-0.5 text-[10px]">
              {history.label}
            </Badge>
          </div>
          <div id="history-sync" className="mt-1 truncate text-xs text-zinc-700">
            {settings && status ? formatHistorySync(settings, status) : "Loading"}
          </div>
        </div>
        <div className="px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] font-semibold text-zinc-500">Processing</div>
            <Badge tone={processing.tone} className="px-2 py-0.5 text-[10px]">
              {processing.label}
            </Badge>
          </div>
          <div id="processing-status" className="mt-1 truncate text-xs text-zinc-700">
            {status ? formatProcessing(status) : "Loading"}
          </div>
        </div>
      </div>

      <div className="grid h-[58px] grid-cols-4 gap-2">
        {[
          {
            label: "Sessions",
            value: formatNumber(summary?.total_sessions),
            icon: Database,
            onClick: () => openDashboard({ view: "notes" })
          },
          {
            label: "Messages",
            value: formatNumber(summary?.total_messages),
            icon: MessageSquare,
            onClick: () => openDashboard({ view: "notes" })
          },
          {
            label: "Facts",
            value: formatNumber(summary?.total_triplets),
            icon: BrainCircuit,
            onClick: () => openCategory("factual")
          },
          {
            label: "Queued AI",
            value: formatNumber(status?.processingPendingCount),
            icon: Sparkles,
            onClick: () => openDashboard({ view: "processing" })
          }
        ].map((metric) => (
          <button
            key={metric.label}
            type="button"
            onClick={metric.onClick}
            className="panel-surface grid grid-cols-[auto_1fr] items-center gap-2 rounded-[8px] px-3 py-2 text-left transition hover:border-zinc-300 hover:bg-zinc-50"
          >
            <metric.icon className="h-4 w-4 text-zinc-400" />
            <div>
              <div className="text-[11px] font-semibold text-zinc-500">{metric.label}</div>
              <div
                id={metric.label === "Queued AI" ? "processing-pending" : undefined}
                className="mt-0.5 text-xl font-semibold leading-none text-zinc-950"
              >
                {metric.value}
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="grid min-h-0 grid-cols-[1.08fr_0.92fr] gap-2">
        <Card className="min-h-0 p-3">
          <CardHeader className="items-center">
            <div>
              <div className="text-[11px] font-semibold text-zinc-500">Corpus mix</div>
              <CardTitle className="mt-0.5 text-base">Choose a collection</CardTitle>
            </div>
            <div className="text-xs text-zinc-500">{summary ? `${formatNumber(summary.total_sessions)} indexed` : "No data yet"}</div>
          </CardHeader>

          <CardContent className="mt-2 grid min-h-0 grid-cols-[150px_1fr] gap-3">
            <button
              type="button"
              onClick={() => openCategory(featuredCategory)}
              className="relative flex h-[168px] items-center justify-center rounded-[8px] border border-zinc-200 bg-zinc-50 transition hover:border-zinc-300 hover:bg-white"
              aria-label={`Open ${featuredCategoryData.label}`}
            >
              <PieChart width={142} height={142}>
                <Pie
                  data={categoryData}
                  dataKey="count"
                  nameKey="label"
                  innerRadius={38}
                  outerRadius={58}
                  paddingAngle={3}
                  strokeWidth={0}
                  cx={71}
                  cy={71}
                  isAnimationActive={false}
                >
                  {categoryData.map((item) => (
                    <Cell
                      key={item.category}
                      fill={item.color}
                      opacity={featuredCategory === item.category ? 1 : 0.48}
                      onClick={(event) => {
                        event.stopPropagation();
                        openCategory(item.category);
                      }}
                      onMouseEnter={() => setHoveredCategory(item.category)}
                      onMouseLeave={() => setHoveredCategory(null)}
                      style={{ cursor: "pointer" }}
                    />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value, _name, payload) => [
                    `${formatTooltipNumber(value)} notes`,
                    payload?.payload?.label ?? "Category"
                  ]}
                />
              </PieChart>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                <div className="text-lg font-semibold leading-none text-zinc-950">{formatNumber(featuredCategoryData.count)}</div>
                <div className="mt-1 text-[11px] font-medium text-zinc-500">{featuredCategoryData.share.toFixed(0)}%</div>
              </div>
            </button>

            <div className="grid min-h-0 grid-rows-4 gap-2">
              {categoryData.map((item) => (
                <button
                  key={item.category}
                  type="button"
                  onClick={() => openCategory(item.category)}
                  onMouseEnter={() => setHoveredCategory(item.category)}
                  onMouseLeave={() => setHoveredCategory(null)}
                  className={`flex items-center justify-between gap-2 rounded-[8px] border px-2 py-1.5 text-left transition hover:border-zinc-300 ${
                    featuredCategory === item.category ? "border-zinc-950 bg-zinc-950 text-white" : "border-zinc-200 bg-white text-zinc-900"
                  }`}
                  data-testid={`popup-category-${item.category}`}
                >
                  <span className="flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
                    {item.label}
                  </span>
                  <span className="text-sm font-semibold">{formatNumber(item.count)}</span>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="min-h-0 p-3">
          <CardHeader className="items-center">
            <div>
              <div className="text-[11px] font-semibold text-zinc-500">Recent notes</div>
              <CardTitle className="mt-0.5 text-base">Rolling history</CardTitle>
            </div>
            <button type="button" className="text-xs font-medium text-zinc-600 hover:text-zinc-950" onClick={() => openDashboard({ view: "notes" })}>
              View all
            </button>
          </CardHeader>
          <CardContent className="mt-2 grid gap-2">
            {recentSessions.map((session) => {
              const category = session.category ?? "factual";
              return (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => openNote(session)}
                  className="grid h-[35px] grid-cols-[auto_1fr] items-center gap-2 rounded-[8px] border border-zinc-200 bg-white px-2 text-left transition hover:border-zinc-300 hover:bg-zinc-50"
                >
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: categoryColors[category] }} />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-semibold text-zinc-950">{titleFromSession(session)}</span>
                    <span className="block truncate text-[11px] text-zinc-500">
                      {categoryLabels[category]} · {providerLabels[session.provider]} · {formatCompactDate(session.updated_at)}
                    </span>
                  </span>
                </button>
              );
            })}
            {!recentSessions.length ? (
              <div className="flex h-[164px] items-center justify-center rounded-[8px] border border-dashed border-zinc-200 bg-zinc-50 px-4 text-center text-sm text-zinc-500">
                Saved notes will appear here after capture.
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className={`grid gap-2 ${status?.processingMode === "extension_browser" ? "grid-cols-5" : "grid-cols-4"}`}>
        <Button size="sm" variant="primary" onClick={() => void handleSaveCurrentPage()}>
          <BookOpen className="h-4 w-4" />
          Save
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void handleQuickSearch()}>
          <Search className="h-4 w-4" />
          Search
        </Button>
        <Button id="open-dashboard" size="sm" variant="secondary" onClick={() => openDashboard()}>
          <Database className="h-4 w-4" />
          Dashboard
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void chrome.runtime.openOptionsPage()}>
          <Settings2 className="h-4 w-4" />
          Settings
        </Button>
        {status?.processingMode === "extension_browser" ? (
          <Button
            id="run-processing"
            size="sm"
            variant="subtle"
            disabled={runQueueState.disabled}
            title={runQueueState.title}
            onClick={() => void handleRunQueue()}
          >
            <Sparkles className="h-4 w-4" />
            {runQueueState.label}
          </Button>
        ) : null}
      </div>

      <div className="min-h-[28px]">
        {status?.providerDriftAlert ? (
          <div id="provider-drift-card" className="truncate rounded-[8px] border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
            <span id="provider-drift" className="sr-only">
              {status.providerDriftAlert.provider}: {status.providerDriftAlert.message}
            </span>
            {formatProviderDriftAlert(status.providerDriftAlert)}
          </div>
        ) : captureStatus || actionError || summaryQuery.error ? (
          <div className="truncate rounded-[8px] border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-600">
            {captureStatus || actionError || (summaryQuery.error instanceof Error ? summaryQuery.error.message : "Could not load dashboard summary.")}
          </div>
        ) : (
          <div className="truncate px-1 py-1.5 text-xs text-zinc-500">
            Last sync · {formatCompactDate(summary?.latest_sync_at ?? status?.lastSuccessAt, "No sync yet")}
          </div>
        )}
      </div>
    </div>
  );
}

mountApp(<PopupApp />);
