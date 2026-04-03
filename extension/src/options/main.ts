import "./styles.css";

import type {
  ExtensionSettings,
  ProviderDriftAlert,
  RuntimeMessage,
  SaveSettingsResponse,
  SyncStatus
} from "../shared/types";

const form = document.querySelector<HTMLFormElement>("#settings-form");
const backendUrlInput = document.querySelector<HTMLInputElement>("#backend-url");
const backendTokenInput = document.querySelector<HTMLInputElement>("#backend-token");
const autoSyncHistoryInput = document.querySelector<HTMLInputElement>("#auto-sync-history");
const providerInputs = {
  chatgpt: document.querySelector<HTMLInputElement>("#provider-chatgpt"),
  gemini: document.querySelector<HTMLInputElement>("#provider-gemini"),
  grok: document.querySelector<HTMLInputElement>("#provider-grok")
};
const saveStatus = document.querySelector<HTMLParagraphElement>("#save-status");
const lastSuccess = document.querySelector<HTMLParagraphElement>("#last-success");
const lastSession = document.querySelector<HTMLParagraphElement>("#last-session");
const lastError = document.querySelector<HTMLParagraphElement>("#last-error");
const historySync = document.querySelector<HTMLParagraphElement>("#history-sync");
const providerDriftCard = document.querySelector<HTMLDivElement>("#provider-drift-card");
const providerDrift = document.querySelector<HTMLParagraphElement>("#provider-drift");
const backendValidation = document.querySelector<HTMLParagraphElement>("#backend-validation");

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

  if (backendUrlInput) {
    backendUrlInput.value = settings.backendUrl;
  }
  if (backendTokenInput) {
    backendTokenInput.value = settings.backendToken ?? "";
  }
  if (autoSyncHistoryInput) {
    autoSyncHistoryInput.checked = settings.autoSyncHistory;
  }

  for (const [provider, input] of Object.entries(providerInputs)) {
    if (input) {
      input.checked = settings.enabledProviders[provider as keyof typeof settings.enabledProviders];
    }
  }

  if (lastSuccess) {
    lastSuccess.textContent = formatDate(status.lastSuccessAt);
  }
  if (lastSession) {
    lastSession.textContent = status.lastSessionKey ?? "n/a";
  }
  if (lastError) {
    lastError.textContent = status.historySyncLastError ?? status.lastError ?? "None";
  }
  if (historySync) {
    historySync.textContent = formatHistorySync(settings, status);
  }
  if (providerDriftCard && providerDrift) {
    providerDriftCard.hidden = !status.providerDriftAlert;
    providerDrift.textContent = formatProviderDriftAlert(status.providerDriftAlert);
  }
  if (backendValidation) {
    if (status.backendValidationError) {
      backendValidation.textContent = status.backendValidationError;
    } else if (status.backendValidatedAt && status.backendVersion) {
      backendValidation.textContent = `${status.backendProduct ?? "tsmc-server"} ${status.backendVersion} (${status.backendAuthMode ?? "unknown"})`;
    } else {
      backendValidation.textContent = "Not validated yet";
    }
  }
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!backendUrlInput) {
    return;
  }

  const nextSettings: Partial<ExtensionSettings> = {
    backendUrl: backendUrlInput.value.trim(),
    backendToken: backendTokenInput?.value.trim() ?? "",
    autoSyncHistory: autoSyncHistoryInput?.checked ?? true,
    enabledProviders: {
      chatgpt: providerInputs.chatgpt?.checked ?? true,
      gemini: providerInputs.gemini?.checked ?? true,
      grok: providerInputs.grok?.checked ?? true
    }
  };

  const response = await sendMessage<SaveSettingsResponse>({
    type: "SAVE_SETTINGS",
    payload: nextSettings
  });
  if (!response.ok) {
    if (saveStatus) {
      saveStatus.textContent = response.error ?? "Could not validate the backend.";
    }
    await load();
    return;
  }

  if (saveStatus) {
    saveStatus.textContent = "Settings saved.";
  }
  await load();
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
