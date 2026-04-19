import { useEffect, useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpen,
  Inbox,
  LoaderCircle,
  Search,
  Settings2,
  Sparkles
} from "lucide-react";

import { fetchDashboardSummary, fetchSessions } from "../background/backend";
import {
  categoryGlyphs,
  categoryLabels,
  categoryOrder,
  categoryPageUrl,
  categoryPalette,
  notePageUrl,
  providerLabels,
  titleFromSession
} from "../shared/explorer";
import type {
  BackendDashboardSummary,
  BackendSessionListItem,
  ExtensionSettings,
  SessionCategoryName,
  SourceCaptureResponse,
  SyncStatus
} from "../shared/types";
import { mountApp } from "../ui/boot";
import { Button } from "../ui/components/button";
import {
  connectionTone,
  formatCompactDate,
  formatNumber,
  formatProcessing,
  formatHistorySync,
  formatProviderDriftAlert,
  processingButtonState
} from "../ui/lib/format";
import { sendRuntimeMessage, useExtensionBootstrap } from "../ui/lib/runtime";

type DashboardRouteState = {
  category?: SessionCategoryName | null;
  view?: "notes" | "processing" | null;
  focus?: "triplets" | null;
};

function dashboardUrl(state: DashboardRouteState = {}): string {
  const url = new URL(chrome.runtime.getURL("dashboard.html"));
  if (state.category) url.searchParams.set("category", state.category);
  if (state.view) url.searchParams.set("view", state.view);
  if (state.focus) url.searchParams.set("focus", state.focus);
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
  if (!summary || status?.backendValidationError) return null;
  return summary;
}

function providerFromUrl(urlString: string | undefined): "chatgpt" | "gemini" | "grok" | null {
  if (!urlString) return null;
  try {
    const host = new URL(urlString).hostname;
    if (host.includes("chatgpt") || host.includes("openai")) return "chatgpt";
    if (host.includes("gemini") || host.includes("google")) return "gemini";
    if (host.includes("grok") || host.includes("x.ai") || host.includes("twitter")) return "grok";
  } catch {
    return null;
  }
  return null;
}

function PopupApp() {
  const { settings, status, loading, error, reload } = useExtensionBootstrap();
  const [captureStatus, setCaptureStatus] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [activeTabInfo, setActiveTabInfo] = useState<{ url?: string; title?: string } | null>(null);

  useEffect(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const tab = tabs[0];
      if (tab) setActiveTabInfo({ url: tab.url, title: tab.title });
    });
  }, []);

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
    () => [...(sessionsQuery.data ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 3),
    [sessionsQuery.data]
  );

  const connection = status ? connectionTone(status) : { label: "Checking", tone: "neutral" as const };
  const runQueueState = status ? processingButtonState(status) : { disabled: true, label: "Run queue", title: "Loading" };

  const categoryData = useMemo(() => {
    const counts = new Map(summary?.categories.map((item) => [item.category, item.count] as const) ?? []);
    return categoryOrder
      .filter((category) => category !== "discarded")
      .map((category) => ({
        category,
        label: categoryLabels[category],
        count: counts.get(category) ?? 0,
        accent: categoryPalette[category].accent
      }));
  }, [summary]);

  const activeProvider = providerFromUrl(activeTabInfo?.url);
  const isProviderTab = Boolean(activeProvider);
  const primaryLabel = isProviderTab
    ? `Capture this ${providerLabels[activeProvider as "chatgpt"]} chat`
    : "Save this page";

  const lastErrorText = status?.lastError ?? status?.historySyncLastError ?? status?.processingLastError ?? "None";
  const lastSyncLabel = formatCompactDate(summary?.latest_sync_at ?? status?.lastSuccessAt, "never");
  const totalNotes = summary?.total_sessions ?? 0;
  const historySyncing = Boolean(status?.historySyncInProgress);
  const historySyncProcessed = status?.historySyncProcessedCount ?? 0;
  const historySyncTotal = status?.historySyncTotalCount;
  const historySyncSkipped = status?.historySyncSkippedCount ?? 0;
  const historySyncStatusProviders = status?.historySyncActiveProviders?.length
    ? status.historySyncActiveProviders
    : status?.historySyncProvider
      ? [status.historySyncProvider]
      : [];
  const historySyncProviderLabel = historySyncStatusProviders.length
    ? historySyncStatusProviders.map((provider) => providerLabels[provider]).join(", ")
    : activeProvider
      ? providerLabels[activeProvider]
      : "provider";
  const showHistorySyncBanner = Boolean(
    historySyncing &&
      activeProvider &&
      historySyncStatusProviders.includes(activeProvider)
  );
  const historySyncKnownTotal = typeof historySyncTotal === "number" && historySyncTotal > 0 ? historySyncTotal : null;
  const historySyncProgressCount = historySyncKnownTotal !== null
    ? Math.min(historySyncProcessed, historySyncKnownTotal)
    : historySyncProcessed;
  const historySyncProgress = historySyncKnownTotal !== null
    ? Math.min(100, Math.max(4, Math.round((historySyncProgressCount / historySyncKnownTotal) * 100)))
    : null;
  const historySyncProgressLabel = historySyncKnownTotal !== null
    ? `${formatNumber(historySyncProgressCount)}/${formatNumber(historySyncKnownTotal)} chats${
        historySyncSkipped ? ` · ${formatNumber(historySyncSkipped)} skipped` : ""
      }`
    : historySyncProcessed > 0
      ? `${formatNumber(historySyncProcessed)} chats synced${historySyncSkipped ? ` · ${formatNumber(historySyncSkipped)} skipped` : ""}`
      : "Scanning chats…";

  async function handleSave(): Promise<void> {
    setCaptureStatus("");
    setActionError(null);
    setIsSaving(true);

    try {
      const response = await sendRuntimeMessage<SourceCaptureResponse>({
        type: "SAVE_CURRENT_PAGE_SOURCE",
        payload: { saveMode: "raw" }
      });

      if (!response.ok) throw new Error(response.error ?? "Could not save the current page.");

      setCaptureStatus(`Saved · ${response.title ?? "page"}`);
      await reload();
      await summaryQuery.refetch();
    } catch (captureError) {
      const message = captureError instanceof Error ? captureError.message : "Could not save the current page.";
      setCaptureStatus(message);
      setActionError(message);
    } finally {
      setIsSaving(false);
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

  const summaryErrorMessage =
    summaryQuery.error instanceof Error ? summaryQuery.error.message : summaryQuery.error ? "Could not load summary." : "";
  const toastMessage = actionError || summaryErrorMessage;
  const hasDrift = Boolean(status?.providerDriftAlert);

  const connectionDotClass =
    connection.tone === "success"
      ? "bg-[var(--color-factual)]"
      : connection.tone === "warning"
        ? "bg-[var(--color-ideas)]"
        : connection.tone === "danger"
          ? "bg-[var(--color-todo)]"
          : "bg-[var(--color-ink-subtle)]";

  return (
    <div
      className="relative flex h-[560px] w-[420px] flex-col overflow-hidden"
      data-testid="popup-root"
    >
      <div className="sr-only">
        <span id="last-session">{status?.lastSessionKey ?? ""}</span>
        <span id="last-error">{lastErrorText}</span>
        <span id="history-sync">{settings && status ? formatHistorySync(settings, status) : "Loading"}</span>
        <span id="processing-status">{status ? formatProcessing(status) : "Loading"}</span>
      </div>

      <header className="flex items-center justify-between px-5 pb-2 pt-4">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-[var(--color-ink)] text-[var(--color-paper)]">
            <span className="display-serif text-[15px] font-semibold leading-none">C</span>
          </div>
          <div className="flex flex-col leading-none">
            <span className="display-serif text-[15px] font-semibold tracking-tight text-[var(--color-ink)]">
              SaveMyContext
            </span>
            <span className="mt-0.5 text-[10.5px] text-[var(--color-ink-subtle)]">
              {loading ? "Loading…" : `${formatNumber(totalNotes)} notes · synced ${lastSyncLabel}`}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {summaryQuery.isFetching || sessionsQuery.isFetching ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin text-[var(--color-ink-subtle)]" />
          ) : null}
          <span className={`h-2 w-2 rounded-full ${connectionDotClass}`} title={connection.label} />
        </div>
      </header>

      <div className="mx-5 mb-3 flex-none">
        <div className="relative overflow-hidden rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-3">
          <div
            className="pointer-events-none absolute -right-8 -top-10 h-28 w-28 rounded-full opacity-60"
            style={{ background: "radial-gradient(circle, rgba(15,138,132,0.18), transparent 65%)" }}
          />
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={isSaving}
            className="group relative flex w-full items-center justify-between gap-3 rounded-[8px] bg-[var(--color-ink)] px-4 py-3 text-left text-[var(--color-paper)] transition hover:bg-[#1a2c44] disabled:opacity-70"
          >
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-white/10">
                {isSaving ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : isProviderTab ? (
                  <Sparkles className="h-4 w-4" />
                ) : (
                  <BookOpen className="h-4 w-4" />
                )}
              </div>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold leading-tight">{primaryLabel}</div>
                <div className="mt-0.5 truncate text-[11px] text-white/60">
                  {activeTabInfo?.title ?? "Capture the current tab to your vault"}
                </div>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 shrink-0 text-white/80 transition group-hover:translate-x-0.5" />
          </button>

          <button
            type="button"
            onClick={() => void handleQuickSearch()}
            className="mt-2 flex w-full items-center gap-3 rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper)] px-4 py-2.5 text-left transition hover:border-[var(--color-line-strong)] hover:bg-[var(--color-paper-sunken)]"
          >
            <Search className="h-4 w-4 shrink-0 text-[var(--color-ink-soft)]" />
            <span className="text-[13px] text-[var(--color-ink-soft)]">Search your vault on this page…</span>
            <kbd className="ml-auto rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-ink-subtle)]">
              ⏎
            </kbd>
          </button>

          {showHistorySyncBanner ? (
            <div className="relative mt-2 rounded-[8px] border border-[rgba(15,138,132,0.22)] bg-[rgba(15,138,132,0.07)] px-3 py-2">
              <div className="mb-1 flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-[#076b66]">
                  <LoaderCircle className="h-3 w-3 shrink-0 animate-spin" />
                  <span className="truncate">Syncing {historySyncProviderLabel} chats</span>
                </span>
                <span className="shrink-0 text-[10.5px] font-medium text-[#076b66]/80">{historySyncProgressLabel}</span>
              </div>
              <div className="relative h-1 overflow-hidden rounded-full bg-[rgba(15,138,132,0.16)]">
                {historySyncProgress === null ? (
                  <div className="popup-progress-indeterminate absolute inset-y-0 left-0 w-[34%] rounded-full bg-[var(--color-factual)]" />
                ) : (
                  <div
                    className="h-full rounded-full bg-[var(--color-factual)] transition-[width] duration-300"
                    style={{ width: `${historySyncProgress}%` }}
                  />
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mx-5 mb-3 grid grid-cols-2 gap-2">
        {categoryData.map((item) => (
          <button
            key={item.category}
            type="button"
            data-testid={`popup-category-${item.category}`}
            onClick={() => openCategory(item.category)}
            className="group relative flex items-center justify-between gap-2 rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 py-2.5 text-left transition hover:-translate-y-px hover:border-[var(--color-line-strong)] hover:shadow-[0_8px_22px_-12px_rgba(15,27,44,0.18)]"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <div
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-[14px]"
                style={{
                  backgroundColor: `${item.accent}1a`,
                  color: item.accent,
                  fontFamily: "var(--font-display)"
                }}
              >
                {categoryGlyphs[item.category]}
              </div>
              <div className="flex min-w-0 flex-col leading-none">
                <span className="text-[13px] font-semibold text-[var(--color-ink)]">{item.label}</span>
                <span className="mt-1 text-[10.5px] uppercase tracking-[0.12em] text-[var(--color-ink-subtle)]">
                  {item.count === 1 ? "1 note" : `${formatNumber(item.count)} notes`}
                </span>
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="mx-5 flex min-h-0 flex-1 flex-col">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="eyebrow">Latest</span>
          <button
            type="button"
            onClick={() => openDashboard({ view: "notes" })}
            className="text-[11px] font-medium text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
          >
            View all →
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5">
          {recentSessions.length ? (
            recentSessions.map((session) => {
              const category = session.category ?? "factual";
              const accent = categoryPalette[category].accent;
              return (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => openNote(session)}
                  className="flex w-full items-center gap-3 rounded-[8px] border border-transparent bg-transparent px-2 py-2 text-left transition hover:border-[var(--color-line)] hover:bg-[var(--color-paper-raised)]"
                >
                  <span className="h-8 w-1 rounded-full shrink-0" style={{ backgroundColor: accent }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-semibold leading-tight text-[var(--color-ink)]">
                      {titleFromSession(session)}
                    </span>
                    <span className="mt-0.5 block truncate text-[10.5px] text-[var(--color-ink-subtle)]">
                      {categoryLabels[category]} · {providerLabels[session.provider]} · {formatCompactDate(session.updated_at)}
                    </span>
                  </span>
                </button>
              );
            })
          ) : (
            <div className="flex items-center gap-3 rounded-[8px] border border-dashed border-[var(--color-line)] bg-[var(--color-paper-raised)]/60 px-3 py-4 text-[12px] text-[var(--color-ink-subtle)]">
              <Inbox className="h-4 w-4" />
              Saved notes will appear here after your first capture.
            </div>
          )}
        </div>
      </div>

      {toastMessage || hasDrift || captureStatus ? (
        <div className="mx-5 mb-2 mt-2 flex-none">
          {hasDrift ? (
            <div
              id="provider-drift-card"
              className="truncate rounded-[8px] border border-[rgba(209,132,37,0.35)] bg-[rgba(209,132,37,0.1)] px-3 py-2 text-[11.5px] font-medium text-[#8b561a]"
            >
              <span id="provider-drift" className="sr-only">
                {status?.providerDriftAlert?.provider}: {status?.providerDriftAlert?.message}
              </span>
              {formatProviderDriftAlert(status?.providerDriftAlert)}
            </div>
          ) : toastMessage ? (
            <div className="truncate rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 py-2 text-[11.5px] text-[var(--color-ink-soft)]">
              {toastMessage || error}
            </div>
          ) : captureStatus ? (
            <div className="truncate rounded-[8px] border border-[rgba(15,138,132,0.2)] bg-[rgba(15,138,132,0.08)] px-3 py-2 text-[11.5px] font-medium text-[#076b66]">
              {captureStatus}
            </div>
          ) : null}
        </div>
      ) : null}

      <footer className="flex items-center gap-1 border-t border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 py-2">
        <Button
          id="open-dashboard"
          size="sm"
          variant="ghost"
          className="flex-1 justify-center"
          onClick={() => openDashboard()}
        >
          Dashboard
        </Button>
        <span className="h-4 w-px bg-[var(--color-line)]" />
        <Button
          size="sm"
          variant="ghost"
          className="flex-1 justify-center"
          onClick={() => void chrome.runtime.openOptionsPage()}
        >
          <Settings2 className="h-3.5 w-3.5" />
          Settings
        </Button>
        {status?.processingMode === "extension_browser" ? (
          <>
            <span className="h-4 w-px bg-[var(--color-line)]" />
            <Button
              id="run-processing"
              size="sm"
              variant="ghost"
              className="flex-1 justify-center"
              disabled={runQueueState.disabled}
              title={runQueueState.title}
              onClick={() => void handleRunQueue()}
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>
                Queue (<span id="processing-pending">{formatNumber(status?.processingPendingCount)}</span>)
              </span>
            </Button>
          </>
        ) : (
          <span id="processing-pending" className="sr-only">
            {formatNumber(status?.processingPendingCount)}
          </span>
        )}
      </footer>
    </div>
  );
}

mountApp(<PopupApp />);
