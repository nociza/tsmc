import "./styles.css";

import { fetchDashboardSummary } from "../background/backend";
import type {
  BackendDashboardSummary,
  ExtensionSettings,
  ProviderDriftAlert,
  ProviderName,
  RuntimeMessage,
  SessionCategoryName,
  SourceCaptureResponse,
  SyncStatus
} from "../shared/types";

const numberFormatter = new Intl.NumberFormat();
const percentFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compactDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit"
});

const categoryOrder: SessionCategoryName[] = ["factual", "ideas", "journal", "todo"];
const categoryPalette: Record<SessionCategoryName, { fill: string; track: string }> = {
  factual: { fill: "#17805d", track: "#e7f4ee" },
  ideas: { fill: "#ba7a21", track: "#f8efe2" },
  journal: { fill: "#1b89ae", track: "#e8f4fa" },
  todo: { fill: "#bf5d42", track: "#faece7" }
};
const categoryLabels: Record<SessionCategoryName, string> = {
  factual: "Factual",
  ideas: "Ideas",
  journal: "Journal",
  todo: "To-Do"
};
const providerLabels: Record<ProviderName, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  grok: "Grok"
};
const toneClasses = ["tone-success", "tone-busy", "tone-warning", "tone-info", "tone-muted"];

const connectionChip = document.querySelector<HTMLParagraphElement>("#connection-chip");
const backendUrl = document.querySelector<HTMLParagraphElement>("#backend-url");
const backendStatus = document.querySelector<HTMLParagraphElement>("#backend-status");
const lastSuccess = document.querySelector<HTMLParagraphElement>("#last-success");
const lastSession = document.querySelector<HTMLParagraphElement>("#last-session");
const corpusStatus = document.querySelector<HTMLParagraphElement>("#corpus-status");
const metricSessions = document.querySelector<HTMLParagraphElement>("#metric-sessions");
const metricMessages = document.querySelector<HTMLParagraphElement>("#metric-messages");
const metricTriplets = document.querySelector<HTMLParagraphElement>("#metric-triplets");
const historySync = document.querySelector<HTMLParagraphElement>("#history-sync");
const historyBadge = document.querySelector<HTMLParagraphElement>("#history-badge");
const processingStatus = document.querySelector<HTMLParagraphElement>("#processing-status");
const processingBadge = document.querySelector<HTMLParagraphElement>("#processing-badge");
const processingPending = document.querySelector<HTMLParagraphElement>("#processing-pending");
const processingMode = document.querySelector<HTMLParagraphElement>("#processing-mode");
const providers = document.querySelector<HTMLDivElement>("#providers");
const indexingStatus = document.querySelector<HTMLParagraphElement>("#indexing-status");
const lastError = document.querySelector<HTMLParagraphElement>("#last-error");
const categoryList = document.querySelector<HTMLDivElement>("#category-list");
const actionGrid = document.querySelector<HTMLDivElement>(".action-grid");
const providerDriftCard = document.querySelector<HTMLDivElement>("#provider-drift-card");
const providerDrift = document.querySelector<HTMLParagraphElement>("#provider-drift");
const runProcessingButton = document.querySelector<HTMLButtonElement>("#run-processing");
const saveCurrentPageButton = document.querySelector<HTMLButtonElement>("#save-current-page");
const openQuickSearchButton = document.querySelector<HTMLButtonElement>("#open-quick-search");
const openDashboardButton = document.querySelector<HTMLButtonElement>("#open-dashboard");
const openOptionsButton = document.querySelector<HTMLButtonElement>("#open-options");
const captureStatus = document.querySelector<HTMLParagraphElement>("#capture-status");

let currentSettings: ExtensionSettings | null = null;
let currentStatus: SyncStatus | null = null;
let currentSummary: BackendDashboardSummary | null = null;
let loadPromise: Promise<void> | null = null;
let loadQueued = false;

function formatNumber(value: number | undefined | null): string {
  return numberFormatter.format(value ?? 0);
}

function setText(node: HTMLElement | null, text: string): void {
  if (!node) {
    return;
  }
  node.textContent = text;
  node.title = text;
}

function applyTone(node: HTMLElement | null, tone: string): void {
  if (!node) {
    return;
  }
  node.classList.remove(...toneClasses);
  node.classList.add(tone);
}

function formatDate(value?: string | null, fallback = "No sync yet"): string {
  if (!value) {
    return fallback;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : compactDateFormatter.format(date);
}

function formatBackendLabel(settings: ExtensionSettings, _status: SyncStatus): string {
  try {
    const parsed = new URL(settings.backendUrl);
    const location =
      parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]"
        ? "Local"
        : "Remote";
    return `${location} · ${parsed.host}`;
  } catch {
    return settings.backendUrl;
  }
}

function formatBackendStatus(status: SyncStatus): string {
  if (status.backendValidationError) {
    return status.backendValidationError;
  }

  if (status.backendValidatedAt && status.backendVersion) {
    const authMode =
      status.backendAuthMode === "bootstrap_local"
        ? "local"
        : status.backendAuthMode === "app_token"
          ? "token"
          : status.backendAuthMode ?? "auth";
    return `v${status.backendVersion} · ${authMode}`;
  }

  return "Checking…";
}

function formatHistorySync(settings: ExtensionSettings, status: SyncStatus): string {
  if (!settings.autoSyncHistory) {
    return "Auto history sync is off.";
  }

  if (status.historySyncInProgress) {
    const provider = status.historySyncProvider ?? "";
    const progress =
      typeof status.historySyncTotalCount === "number"
        ? ` ${status.historySyncProcessedCount ?? 0}/${status.historySyncTotalCount}`
        : "";
    const skipped =
      typeof status.historySyncSkippedCount === "number" && status.historySyncSkippedCount > 0
        ? ` (${status.historySyncSkippedCount} skipped)`
        : "";
    return `Running ${provider}${progress}${skipped}`.trim();
  }

  if (status.historySyncLastCompletedAt) {
    const count =
      typeof status.historySyncLastConversationCount === "number"
        ? ` · ${status.historySyncLastConversationCount} conversations`
        : "";
    return `${status.historySyncLastResult ?? "success"} · ${formatDate(status.historySyncLastCompletedAt)}${count}`;
  }

  return "Waiting for next provider visit.";
}

function formatProcessing(status: SyncStatus): string {
  if (status.processingInProgress) {
    const provider = status.processingProvider ?? "provider";
    const processed = typeof status.processingProcessedCount === "number" ? ` · ${status.processingProcessedCount} done` : "";
    return `Running ${provider}${processed}`;
  }

  if (status.processingLastError) {
    return `Failed: ${status.processingLastError}`;
  }

  if (status.processingMode === "immediate") {
    return status.processingWorkerModel ? `Immediate · ${status.processingWorkerModel}` : "Immediate processing";
  }

  if (status.processingMode === "disabled") {
    return "Browser worker disabled.";
  }

  if (status.processingWorkerModel) {
    return `Manual · ${status.processingWorkerModel}`;
  }

  return "No AI worker configured.";
}

function formatProcessingMode(status: SyncStatus): string {
  if (status.processingMode === "immediate") {
    return status.processingWorkerModel ? `Server · ${status.processingWorkerModel}` : "Server-side";
  }
  if (status.processingMode === "extension_browser") {
    return status.processingWorkerModel ? `Browser · ${status.processingWorkerModel}` : "Browser worker";
  }
  if (status.processingMode === "disabled") {
    return "Disabled";
  }
  return "Unavailable";
}

function formatProviderDriftAlert(alert?: ProviderDriftAlert | null): string {
  if (!alert) {
    return "None";
  }

  return `${alert.provider}: ${alert.message} · ${formatDate(alert.detectedAt)}`;
}

function formatIndexingStatus(status: SyncStatus): string {
  if (!status.lastSessionKey) {
    return "No captures yet";
  }

  const decision =
    status.lastIndexingDecision === "skipped"
      ? "Skipped"
      : status.lastIndexingDecision === "indexed"
        ? "Indexed"
        : "Captured";
  const extras: string[] = [decision];

  if (typeof status.lastSyncedMessageCount === "number" && status.lastSyncedMessageCount > 0) {
    extras.push(`${status.lastSyncedMessageCount} msgs`);
  }

  return extras.join(" · ");
}

function processingButtonState(status: SyncStatus): {
  disabled: boolean;
  label: string;
  title: string;
} {
  if (status.processingInProgress) {
    return {
      disabled: true,
      label: "Running…",
      title: "AI processing is already running."
    };
  }

  if (status.backendValidationError) {
    return {
      disabled: true,
      label: "Run queue",
      title: status.backendValidationError
    };
  }

  if (status.processingMode === "immediate") {
    return {
      disabled: true,
      label: "Run queue",
      title: "This backend is using immediate server-side processing instead of the extension worker."
    };
  }

  if (status.processingMode === "disabled") {
    return {
      disabled: true,
      label: "Run queue",
      title: "Experimental browser automation is disabled on this backend."
    };
  }

  if (!status.processingPendingCount) {
    return {
      disabled: true,
      label: "Run queue",
      title: "There are no pending AI jobs right now."
    };
  }

  return {
    disabled: false,
    label: "Run queue",
    title: "Use your current signed-in provider tab to process queued SaveMyContext jobs."
  };
}

function connectionState(status: SyncStatus): { label: string; tone: string } {
  if (status.backendValidationError) {
    return { label: "Needs attention", tone: "tone-warning" };
  }
  if (status.historySyncInProgress || status.processingInProgress) {
    return { label: "Active", tone: "tone-busy" };
  }
  if (status.backendValidatedAt && status.backendVersion) {
    return { label: "Connected", tone: "tone-success" };
  }
  return { label: "Checking", tone: "tone-muted" };
}

function historyState(settings: ExtensionSettings, status: SyncStatus): { label: string; tone: string } {
  if (!settings.autoSyncHistory) {
    return { label: "Off", tone: "tone-muted" };
  }
  if (status.historySyncInProgress) {
    return { label: "Running", tone: "tone-busy" };
  }
  if (status.historySyncLastResult === "failed" || status.historySyncLastResult === "unsupported") {
    return { label: "Alert", tone: "tone-warning" };
  }
  if (status.historySyncLastCompletedAt) {
    return { label: "Ready", tone: "tone-success" };
  }
  return { label: "On", tone: "tone-info" };
}

function processingState(status: SyncStatus): { label: string; tone: string } {
  if (status.processingInProgress) {
    return { label: "Running", tone: "tone-busy" };
  }
  if (status.processingLastError) {
    return { label: "Alert", tone: "tone-warning" };
  }
  if (status.processingMode === "disabled") {
    return { label: "Off", tone: "tone-muted" };
  }
  if ((status.processingPendingCount ?? 0) > 0) {
    return { label: `${status.processingPendingCount} queued`, tone: "tone-info" };
  }
  if (status.processingMode === "immediate") {
    return { label: "Server", tone: "tone-success" };
  }
  if (status.processingMode === "extension_browser") {
    return { label: "Idle", tone: "tone-success" };
  }
  return { label: "Unavailable", tone: "tone-muted" };
}

function renderProviders(settings: ExtensionSettings): void {
  if (!providers) {
    return;
  }

  providers.replaceChildren();
  const enabled = (Object.keys(settings.enabledProviders) as ProviderName[]).filter(
    (provider) => settings.enabledProviders[provider]
  );

  if (!enabled.length) {
    const pill = document.createElement("span");
    pill.className = "provider-pill tone-muted";
    pill.textContent = "None";
    providers.append(pill);
    return;
  }

  for (const provider of enabled) {
    const pill = document.createElement("span");
    pill.className = "provider-pill tone-muted";
    pill.textContent = providerLabels[provider];
    providers.append(pill);
  }
}

function renderCategoryMix(summary?: BackendDashboardSummary | null): void {
  if (!categoryList) {
    return;
  }

  const counts = new Map<SessionCategoryName, number>(
    summary?.categories.map((item) => [item.category, item.count] satisfies [SessionCategoryName, number]) ?? []
  );
  const total = summary?.categories.reduce((current, item) => current + item.count, 0) ?? 0;

  categoryList.replaceChildren();

  for (const category of categoryOrder) {
    const count = counts.get(category) ?? 0;
    const ratio = total ? count / total : 0;

    const item = document.createElement("div");
    item.className = "category-item";
    item.style.setProperty("--category-fill", categoryPalette[category].fill);
    item.style.setProperty("--category-track", categoryPalette[category].track);
    item.style.setProperty("--category-border", categoryPalette[category].track);

    const dot = document.createElement("span");
    dot.className = "category-dot";
    dot.style.background = categoryPalette[category].fill;

    const name = document.createElement("span");
    name.className = "category-name";
    name.textContent = categoryLabels[category];

    const value = document.createElement("span");
    value.className = "category-value";
    value.textContent = formatNumber(count);
    item.title = `${categoryLabels[category]} · ${formatNumber(count)} · ${percentFormatter.format(ratio * 100)}%`;

    item.append(dot, name, value);
    categoryList.append(item);
  }
}

function renderSummary(summary: BackendDashboardSummary | null, status: SyncStatus): void {
  setText(metricSessions, summary ? formatNumber(summary.total_sessions) : "—");
  setText(metricMessages, summary ? formatNumber(summary.total_messages) : "—");
  setText(metricTriplets, summary ? formatNumber(summary.total_triplets) : "—");
  setText(
    processingPending,
    typeof status.processingPendingCount === "number" ? String(status.processingPendingCount) : "0"
  );
  setText(corpusStatus, `Corpus sync · ${formatDate(summary?.latest_sync_at, "No data yet")}`);
  renderCategoryMix(summary);
}

function render(settings: ExtensionSettings, status: SyncStatus, summary: BackendDashboardSummary | null): void {
  const effectiveSummary = status.backendValidationError ? null : summary;
  const connection = connectionState(status);
  setText(connectionChip, connection.label);
  applyTone(connectionChip, connection.tone);

  setText(backendUrl, formatBackendLabel(settings, status));
  setText(backendStatus, formatBackendStatus(status));
  setText(lastSuccess, formatDate(status.lastSuccessAt, "No sync yet"));
  setText(lastSession, status.lastSessionKey ?? "n/a");

  const history = historyState(settings, status);
  setText(historyBadge, history.label);
  applyTone(historyBadge, history.tone);
  setText(historySync, formatHistorySync(settings, status));

  const processing = processingState(status);
  setText(processingBadge, processing.label);
  applyTone(processingBadge, processing.tone);
  setText(processingStatus, formatProcessing(status));
  setText(processingMode, formatProcessingMode(status));

  renderSummary(effectiveSummary, status);
  renderProviders(settings);
  setText(indexingStatus, formatIndexingStatus(status));
  setText(lastError, status.processingLastError ?? status.historySyncLastError ?? status.lastError ?? "None");

  if (providerDriftCard && providerDrift) {
    providerDriftCard.hidden = !status.providerDriftAlert;
    setText(providerDrift, formatProviderDriftAlert(status.providerDriftAlert));
  }

  if (runProcessingButton) {
    runProcessingButton.hidden = status.processingMode !== "extension_browser";
    const buttonState = processingButtonState(status);
    runProcessingButton.disabled = buttonState.disabled;
    runProcessingButton.textContent = buttonState.label;
    runProcessingButton.title = buttonState.title;
  }

  actionGrid?.classList.toggle("without-processing", runProcessingButton?.hidden ?? true);
}

async function sendMessage<TResponse>(message: RuntimeMessage): Promise<TResponse> {
  return chrome.runtime.sendMessage(message) as Promise<TResponse>;
}

async function load(): Promise<void> {
  if (loadPromise) {
    loadQueued = true;
    return loadPromise;
  }

  loadPromise = (async () => {
    do {
      loadQueued = false;

      const previousBackendUrl = currentSettings?.backendUrl ?? null;
      const [settings, status] = await Promise.all([
        sendMessage<ExtensionSettings>({ type: "GET_SETTINGS" }),
        sendMessage<SyncStatus>({ type: "GET_STATUS" })
      ]);

      currentSettings = settings;
      currentStatus = status;

      if (previousBackendUrl !== settings.backendUrl) {
        currentSummary = null;
      }

      render(settings, status, currentSummary);

      if (status.backendValidationError) {
        currentSummary = null;
        render(settings, status, currentSummary);
        continue;
      }

      try {
        currentSummary = await fetchDashboardSummary(settings);
      } catch {
        currentSummary = null;
      }

      render(settings, status, currentSummary);
    } while (loadQueued);
  })();

  try {
    await loadPromise;
  } finally {
    loadPromise = null;
  }
}

openDashboardButton?.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

openQuickSearchButton?.addEventListener("click", async () => {
  const response = await sendMessage<{ ok: boolean; error?: string }>({ type: "OPEN_QUICK_SEARCH" });
  if (!response.ok) {
    setText(lastError, response.error ?? "Could not open quick search on the current page.");
    return;
  }
  window.close();
});

saveCurrentPageButton?.addEventListener("click", async () => {
  setText(captureStatus, "Saving current page…");

  const response = await sendMessage<SourceCaptureResponse>({
    type: "SAVE_CURRENT_PAGE_SOURCE",
    payload: {
      saveMode: "ai"
    }
  });

  if (!response.ok) {
    setText(captureStatus, response.error ?? "Could not save the current page.");
    return;
  }

  setText(captureStatus, `Saved ${response.title ?? "page"} to SaveMyContext.`);
});

openOptionsButton?.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

runProcessingButton?.addEventListener("click", async () => {
  const response = await sendMessage<{ ok: boolean; error?: string }>({ type: "START_PROCESSING" });
  if (!response.ok) {
    setText(lastError, response.error ?? "AI processing failed.");
  }
  await load();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" && areaName !== "sync") {
    return;
  }

  if (changes["savemycontext.status"]?.newValue && currentSettings) {
    currentStatus = changes["savemycontext.status"].newValue as SyncStatus;
    render(currentSettings, currentStatus, currentSummary);
    return;
  }

  if (changes["savemycontext.settings"] || changes["savemycontext.settings.cache"] || changes["savemycontext.settings.secrets"]) {
    void load();
  }
});

void load();
