import "./styles.css";

import type { ExtensionSettings, ProviderDriftAlert, RuntimeMessage, SyncStatus } from "../shared/types";

const backendUrl = document.querySelector<HTMLParagraphElement>("#backend-url");
const lastSuccess = document.querySelector<HTMLParagraphElement>("#last-success");
const lastSession = document.querySelector<HTMLParagraphElement>("#last-session");
const historySync = document.querySelector<HTMLParagraphElement>("#history-sync");
const providers = document.querySelector<HTMLParagraphElement>("#providers");
const lastError = document.querySelector<HTMLParagraphElement>("#last-error");
const providerDriftCard = document.querySelector<HTMLDivElement>("#provider-drift-card");
const providerDrift = document.querySelector<HTMLParagraphElement>("#provider-drift");
const openOptionsButton = document.querySelector<HTMLButtonElement>("#open-options");

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

async function sendMessage<TResponse>(message: RuntimeMessage): Promise<TResponse> {
  return chrome.runtime.sendMessage(message) as Promise<TResponse>;
}

async function load(): Promise<void> {
  const [settings, status] = await Promise.all([
    sendMessage<ExtensionSettings>({ type: "GET_SETTINGS" }),
    sendMessage<SyncStatus>({ type: "GET_STATUS" })
  ]);

  if (backendUrl) {
    backendUrl.textContent = settings.backendUrl;
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
  if (providers) {
    providers.textContent = Object.entries(settings.enabledProviders)
      .filter(([, enabled]) => enabled)
      .map(([provider]) => provider)
      .join(", ");
  }
  if (lastError) {
    lastError.textContent = status.historySyncLastError ?? status.lastError ?? "None";
  }
  if (providerDriftCard && providerDrift) {
    providerDriftCard.hidden = !status.providerDriftAlert;
    providerDrift.textContent = formatProviderDriftAlert(status.providerDriftAlert);
  }
}

openOptionsButton?.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" && areaName !== "sync") {
    return;
  }

  if (changes["tsmc.status"] || changes["tsmc.settings"]) {
    void load();
  }
});

void load();
