import { useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { BookOpen, BrainCircuit, Database, LoaderCircle, Search, Settings2, Sparkles, Workflow } from "lucide-react";
import { Cell, Pie, PieChart, Tooltip } from "recharts";

import { fetchDashboardSummary, fetchSessions } from "../background/backend";
import { categoryLabels, categoryOrder, categoryPageUrl, providerLabels, titleFromSession } from "../shared/explorer";
import type {
  BackendDashboardSummary,
  ExtensionSettings,
  SessionCategoryName,
  SourceCaptureResponse,
  SyncStatus
} from "../shared/types";
import { mountApp } from "../ui/boot";
import { Badge } from "../ui/components/badge";
import { Button } from "../ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/components/card";
import {
  connectionTone,
  enabledProviderLabels,
  formatBackendLabel,
  formatBackendStatus,
  formatCompactDate,
  formatHistorySync,
  formatIndexingStatus,
  formatNumber,
  formatProcessing,
  formatProcessingMode,
  formatProviderDriftAlert,
  historyTone,
  nextActionText,
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
  const latestSession = useMemo(
    () => [...(sessionsQuery.data ?? [])].sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0] ?? null,
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
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-3 p-3" data-testid="popup-root">
      <div id="last-session" className="sr-only">
        {status?.lastSessionKey ?? ""}
      </div>
      <Card className="p-4">
        <CardHeader className="items-start">
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">SaveMyContext</div>
            <CardTitle className="text-[26px] leading-none">Context Workspace</CardTitle>
            <CardDescription>
              {summary
                ? `Corpus sync · ${formatCompactDate(summary.latest_sync_at, "No data yet")}`
                : "Context capture, search, and processing in one view."}
            </CardDescription>
          </div>
          <Badge tone={connection.tone}>{connection.label}</Badge>
        </CardHeader>

        <CardContent className="mt-4 grid grid-cols-[1.45fr_1fr] gap-3">
          <div className="space-y-3">
            <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Next action</div>
              <p className="text-sm leading-6 text-zinc-900">
                {settings && status ? nextActionText(settings, status, summary) : "Loading extension status…"}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-[8px] border border-zinc-200 bg-white p-3">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Backend</div>
                <div className="text-sm font-medium text-zinc-900">
                  {settings ? formatBackendLabel(settings) : loading ? "Loading" : "Unavailable"}
                </div>
                <div className="mt-1 text-xs leading-5 text-zinc-500">
                  {status ? formatBackendStatus(status) : error ?? "Checking configuration"}
                </div>
              </div>

              <div className="rounded-[8px] border border-zinc-200 bg-white p-3">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Latest note</div>
                <div className="truncate text-sm font-medium text-zinc-900">
                  {latestSession ? titleFromSession(latestSession) : "No saved notes yet"}
                </div>
                <div className="mt-1 text-xs leading-5 text-zinc-500">
                  {latestSession
                    ? `${providerLabels[latestSession.provider]} · ${formatCompactDate(latestSession.updated_at)}`
                    : `Last sync · ${formatCompactDate(status?.lastSuccessAt, "No sync yet")}`}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-3">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Corpus mix</div>
                <div className="text-sm font-medium text-zinc-900">
                  {summary ? `${formatNumber(summary.total_sessions)} indexed sessions` : "Waiting for corpus data"}
                </div>
              </div>
              {summaryQuery.isFetching ? <LoaderCircle className="h-4 w-4 animate-spin text-zinc-400" /> : null}
            </div>

            <div className="flex h-[136px] items-center justify-center">
              <PieChart width={190} height={136}>
                <Pie
                  data={categoryData}
                  dataKey="count"
                  nameKey="label"
                  innerRadius={36}
                  outerRadius={52}
                  paddingAngle={3}
                  strokeWidth={0}
                  cx={95}
                  cy={68}
                >
                  {categoryData.map((item) => (
                    <Cell key={item.category} fill={item.color} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value, _name, payload) => [
                    `${formatTooltipNumber(value)} notes`,
                    payload?.payload?.label ?? "Category"
                  ]}
                />
              </PieChart>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Badge tone={history.tone}>{history.label}</Badge>
              <Badge tone={processing.tone}>{processing.label}</Badge>
              <div className="col-span-2 text-xs leading-5 text-zinc-500">
                {status ? formatProcessing(status) : "Loading pipeline state"}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-4 gap-2">
        {[
          {
            label: "Sessions",
            value: summary ? formatNumber(summary.total_sessions) : "—",
            icon: Database,
            onClick: () => openDashboard({ view: "notes" })
          },
          {
            label: "Messages",
            value: summary ? formatNumber(summary.total_messages) : "—",
            icon: Workflow,
            onClick: () => openDashboard({ view: "notes" })
          },
          {
            label: "Facts",
            value: summary ? formatNumber(summary.total_triplets) : "—",
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
            className="panel-surface flex h-[90px] flex-col items-start justify-between rounded-[8px] p-3 text-left transition hover:border-zinc-300 hover:bg-zinc-50"
          >
            <metric.icon className="h-4 w-4 text-zinc-400" />
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">{metric.label}</div>
              <div className="mt-1 text-2xl font-semibold leading-none text-zinc-950">{metric.value}</div>
            </div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-[1.4fr_1fr] gap-3">
        <Card className="p-4">
          <CardHeader>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Collections</div>
              <CardTitle className="mt-1 text-lg">Jump into a category</CardTitle>
            </div>
            <div className="text-xs text-zinc-500">{summary ? "Click to open explorer" : "No indexed notes yet"}</div>
          </CardHeader>

          <CardContent className="mt-4 grid gap-2">
            {categoryData.map((item) => (
              <button
                key={item.category}
                type="button"
                onClick={() => openCategory(item.category)}
                className="rounded-[8px] border border-zinc-200 bg-white p-3 text-left transition hover:border-zinc-300 hover:bg-zinc-50"
                data-testid={`popup-category-${item.category}`}
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                    <span className="text-sm font-medium text-zinc-900">{item.label}</span>
                  </div>
                  <span className="text-sm font-semibold text-zinc-950">{formatNumber(item.count)}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-zinc-100">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.max(item.share, item.count ? 10 : 0)}%`, backgroundColor: item.color }}
                  />
                </div>
                <div className="mt-2 text-xs text-zinc-500">{item.share.toFixed(0)}% of indexed context</div>
              </button>
            ))}
          </CardContent>
        </Card>

        <div className="grid gap-3">
          <Card className="p-4">
            <CardHeader>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Actions</div>
                <CardTitle className="mt-1 text-lg">Work from here</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="mt-4 grid grid-cols-2 gap-2">
              <Button variant="primary" className="col-span-2" onClick={() => void handleSaveCurrentPage()}>
                <BookOpen className="h-4 w-4" />
                Save page
              </Button>
              <Button variant="secondary" onClick={() => void handleQuickSearch()}>
                <Search className="h-4 w-4" />
                Search page
              </Button>
              <Button variant="secondary" onClick={() => openDashboard()}>
                <Database className="h-4 w-4" />
                Dashboard
              </Button>
              <Button variant="secondary" onClick={() => void chrome.runtime.openOptionsPage()}>
                <Settings2 className="h-4 w-4" />
                Settings
              </Button>
              {status?.processingMode === "extension_browser" ? (
                <Button
                  variant="subtle"
                  className="col-span-2"
                  disabled={runQueueState.disabled}
                  title={runQueueState.title}
                  onClick={() => void handleRunQueue()}
                >
                  <Sparkles className="h-4 w-4" />
                  {runQueueState.label}
                </Button>
              ) : null}
            </CardContent>
          </Card>

          <Card className="p-4">
            <CardHeader>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Pipeline</div>
                <CardTitle className="mt-1 text-lg">Capture health</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="mt-4 space-y-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">History sync</div>
                <div id="history-sync" className="mt-1 text-sm text-zinc-900">
                  {settings && status ? formatHistorySync(settings, status) : "Loading"}
                </div>
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Processing mode</div>
                <div className="mt-1 text-sm text-zinc-900">{status ? formatProcessingMode(status) : "Loading"}</div>
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Providers</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {settings
                    ? enabledProviderLabels(settings).map((label) => (
                        <Badge key={label} tone="neutral">
                          {label}
                        </Badge>
                      ))
                    : null}
                </div>
              </div>
              <div className="text-xs leading-5 text-zinc-500">
                Last capture · {status ? formatIndexingStatus(status) : "Loading"}
              </div>
              {status?.providerDriftAlert ? (
                <div
                  id="provider-drift-card"
                  className="rounded-[8px] border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800"
                >
                  <span id="provider-drift" className="sr-only">
                    {status.providerDriftAlert.provider}: {status.providerDriftAlert.message}
                  </span>
                  <span>{formatProviderDriftAlert(status.providerDriftAlert)}</span>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>

      {captureStatus || actionError || summaryQuery.error ? (
        <div className="rounded-[8px] border border-zinc-200 bg-white px-3 py-2 text-xs leading-5 text-zinc-600">
          {captureStatus || actionError || (summaryQuery.error instanceof Error ? summaryQuery.error.message : "Could not load dashboard summary.")}
        </div>
      ) : null}
    </div>
  );
}

mountApp(<PopupApp />);
