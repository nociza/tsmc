import "./styles.css";

import type { ExtensionSettings, ProviderDriftAlert, RuntimeMessage, SyncStatus } from "../shared/types";

const backendUrl = document.querySelector<HTMLParagraphElement>("#backend-url");
const backendStatus = document.querySelector<HTMLParagraphElement>("#backend-status");
const lastSuccess = document.querySelector<HTMLParagraphElement>("#last-success");
const lastSession = document.querySelector<HTMLParagraphElement>("#last-session");
const historySync = document.querySelector<HTMLParagraphElement>("#history-sync");
const processingStatus = document.querySelector<HTMLParagraphElement>("#processing-status");
const processingPending = document.querySelector<HTMLParagraphElement>("#processing-pending");
const providers = document.querySelector<HTMLParagraphElement>("#providers");
const lastError = document.querySelector<HTMLParagraphElement>("#last-error");
const providerDriftCard = document.querySelector<HTMLDivElement>("#provider-drift-card");
const providerDrift = document.querySelector<HTMLParagraphElement>("#provider-drift");
const runProcessingButton = document.querySelector<HTMLButtonElement>("#run-processing");
const openQuickSearchButton = document.querySelector<HTMLButtonElement>("#open-quick-search");
const openDashboardButton = document.querySelector<HTMLButtonElement>("#open-dashboard");
const openOptionsButton = document.querySelector<HTMLButtonElement>("#open-options");
let currentSettings: ExtensionSettings | null = null;
let currentStatus: SyncStatus | null = null;
let loadPromise: Promise<void> | null = null;
let loadQueued = false;

function formatDate(value?: string): string {
  if (!value) {
    return "No sync yet";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatHistorySync(settings: ExtensionSettings, status: SyncStatus): string {
  if (!settings.autoSyncHistory) {
    return "Disabled";
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
        ? `, ${status.historySyncLastConversationCount} conversations`
        : "";
    return `${status.historySyncLastResult ?? "success"} ${formatDate(status.historySyncLastCompletedAt)}${count}`;
  }

  return "Idle";
}

function formatProviderDriftAlert(alert?: ProviderDriftAlert | null): string {
  if (!alert) {
    return "None";
  }

  const headline = `${alert.provider}: ${alert.message}`;
  const evidence = alert.evidence ? ` Evidence: ${alert.evidence}` : "";
  return `${headline} ${formatDate(alert.detectedAt)}.${evidence}`.trim();
}

function formatBackendStatus(status: SyncStatus): string {
  if (status.backendValidationError) {
    return status.backendValidationError;
  }

  if (status.backendValidatedAt && status.backendVersion) {
    return `${status.backendProduct ?? "tsmc-server"} ${status.backendVersion} (${status.backendAuthMode ?? "unknown"})`;
  }

  return "Checking…";
}

function formatProcessing(status: SyncStatus): string {
  if (status.processingInProgress) {
    const provider = status.processingProvider ?? "provider";
    const processed = typeof status.processingProcessedCount === "number" ? `, ${status.processingProcessedCount} done` : "";
    return `Running ${provider}${processed}`;
  }

  if (status.processingLastError) {
    return `Failed: ${status.processingLastError}`;
  }

  if (status.processingMode === "immediate") {
    return status.processingWorkerModel
      ? `Immediate backend processing (${status.processingWorkerModel})`
      : "Immediate backend processing";
  }

  if (status.processingMode === "disabled") {
    return "Experimental browser automation is disabled";
  }

  if (status.processingWorkerModel) {
    return `Manual browser worker (${status.processingWorkerModel})`;
  }

  return "Unavailable";
}

function processingButtonState(status: SyncStatus): {
  disabled: boolean;
  label: string;
  title: string;
} {
  if (status.processingInProgress) {
    return {
      disabled: true,
      label: "Running AI Processing…",
      title: "AI processing is already running."
    };
  }

  if (status.backendValidationError) {
    return {
      disabled: true,
      label: "Run AI Processing",
      title: status.backendValidationError
    };
  }

  if (status.processingMode === "immediate") {
    return {
      disabled: true,
      label: "Run AI Processing",
      title: "This backend is using immediate server-side processing instead of the extension worker."
    };
  }

  if (status.processingMode === "disabled") {
    return {
      disabled: true,
      label: "Run AI Processing",
      title: "Experimental browser automation is disabled on this backend."
    };
  }

  if (!status.processingPendingCount) {
    return {
      disabled: true,
      label: "Run AI Processing",
      title: "There are no pending AI jobs right now."
    };
  }

  return {
    disabled: false,
    label: "Run AI Processing",
    title: "Use your current signed-in browser session to process queued TSMC jobs."
  };
}

async function sendMessage<TResponse>(message: RuntimeMessage): Promise<TResponse> {
  return chrome.runtime.sendMessage(message) as Promise<TResponse>;
}

function render(settings: ExtensionSettings, status: SyncStatus): void {
  if (backendUrl) {
    const suffix = status.backendVersion ? ` (${status.backendVersion})` : "";
    backendUrl.textContent = `${settings.backendUrl}${suffix}`;
  }
  if (backendStatus) {
    backendStatus.textContent = formatBackendStatus(status);
  }
  if (lastSuccess) {
    lastSuccess.textContent = formatDate(status.lastSuccessAt);
  }
  if (lastSession) {
    lastSession.textContent = status.lastSessionKey ?? "n/a";
  }
  if (historySync) {
    historySync.textContent = formatHistorySync(settings, status);
  }
  if (processingStatus) {
    processingStatus.textContent = formatProcessing(status);
  }
  if (processingPending) {
    processingPending.textContent =
      typeof status.processingPendingCount === "number" ? String(status.processingPendingCount) : "n/a";
  }
  if (providers) {
    providers.textContent = Object.entries(settings.enabledProviders)
      .filter(([, enabled]) => enabled)
      .map(([provider]) => provider)
      .join(", ");
  }
  if (lastError) {
    lastError.textContent = status.processingLastError ?? status.historySyncLastError ?? status.lastError ?? "None";
  }
  if (providerDriftCard && providerDrift) {
    providerDriftCard.hidden = !status.providerDriftAlert;
    providerDrift.textContent = formatProviderDriftAlert(status.providerDriftAlert);
  }
  if (runProcessingButton) {
    runProcessingButton.hidden = status.processingMode !== "extension_browser";
    const buttonState = processingButtonState(status);
    runProcessingButton.disabled = buttonState.disabled;
    runProcessingButton.textContent = buttonState.label;
    runProcessingButton.title = buttonState.title;
  }
}

async function load(): Promise<void> {
  if (loadPromise) {
    loadQueued = true;
    return loadPromise;
  }

  loadPromise = (async () => {
    do {
      loadQueued = false;
      const [settings, status] = await Promise.all([
        sendMessage<ExtensionSettings>({ type: "GET_SETTINGS" }),
        sendMessage<SyncStatus>({ type: "GET_STATUS" })
      ]);
      currentSettings = settings;
      currentStatus = status;
      render(settings, status);
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
    if (lastError) {
      lastError.textContent = response.error ?? "Could not open quick search on the current page.";
    }
    return;
  }
  window.close();
});

openOptionsButton?.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

runProcessingButton?.addEventListener("click", async () => {
  const response = await sendMessage<{ ok: boolean; error?: string }>({ type: "START_PROCESSING" });
  if (!response.ok && lastError) {
    lastError.textContent = response.error ?? "AI processing failed.";
  }
  await load();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" && areaName !== "sync") {
    return;
  }

  if (changes["tsmc.status"]?.newValue && currentSettings) {
    currentStatus = changes["tsmc.status"].newValue as SyncStatus;
    render(currentSettings, currentStatus);
    return;
  }

  if (changes["tsmc.settings"] || changes["tsmc.settings.cache"]) {
    void load();
  }
});

void load();
