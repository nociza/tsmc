import "./styles.css";

import type {
  ExtensionSettings,
  ProviderDriftAlert,
  RuntimeMessage,
  SaveKnowledgePathResponse,
  SaveSettingsResponse,
  SyncStatus
} from "../shared/types";
import { describeIndexingMode, normalizeRuleWords } from "../shared/indexing-rules";

const form = document.querySelector<HTMLFormElement>("#settings-form");
const backendUrlInput = document.querySelector<HTMLInputElement>("#backend-url");
const backendTokenInput = document.querySelector<HTMLInputElement>("#backend-token");
const knowledgePathInput = document.querySelector<HTMLInputElement>("#knowledge-path");
const saveKnowledgePathButton = document.querySelector<HTMLButtonElement>("#save-knowledge-path");
const autoSyncHistoryInput = document.querySelector<HTMLInputElement>("#auto-sync-history");
const selectionCaptureEnabledInput = document.querySelector<HTMLInputElement>("#selection-capture-enabled");
const indexingModeInput = document.querySelector<HTMLInputElement>("#indexing-mode-trigger");
const triggerWordsInput = document.querySelector<HTMLInputElement>("#trigger-words");
const blacklistWordsInput = document.querySelector<HTMLInputElement>("#blacklist-words");
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
const knowledgePathStatus = document.querySelector<HTMLParagraphElement>("#knowledge-path-status");
const indexingRulesStatus = document.querySelector<HTMLParagraphElement>("#indexing-rules-status");
const lastIndexing = document.querySelector<HTMLParagraphElement>("#last-indexing");
const openDashboardButton = document.querySelector<HTMLButtonElement>("#open-dashboard");
let currentSettings: ExtensionSettings | null = null;
let currentStatus: SyncStatus | null = null;
let loadPromise: Promise<void> | null = null;
let loadQueued = false;
let formHydrated = false;
let formDirty = false;
let knowledgePathDirty = false;

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

function formatIndexingRules(settings: ExtensionSettings): string {
  const triggerWords = normalizeRuleWords(settings.triggerWords);
  const blacklistWords = normalizeRuleWords(settings.blacklistWords);
  const triggerLabel = triggerWords.length ? triggerWords.join(", ") : "none";
  const blacklistLabel = blacklistWords.length ? blacklistWords.join(", ") : "none";
  return `${describeIndexingMode(settings.indexingMode)}. Trigger words: ${triggerLabel}. Blacklist: ${blacklistLabel}.`;
}

function formatLastIndexing(status: SyncStatus): string {
  if (!status.lastIndexingDecision) {
    return "No decision yet";
  }

  const prefix = status.lastIndexingDecision === "indexed" ? "Indexed" : "Skipped";
  return status.lastIndexingReason ? `${prefix}: ${status.lastIndexingReason}` : prefix;
}

async function sendMessage<TResponse>(message: RuntimeMessage): Promise<TResponse> {
  return chrome.runtime.sendMessage(message) as Promise<TResponse>;
}

function syncFormFromSettings(settings: ExtensionSettings): void {
  if (formDirty) {
    return;
  }

  if (backendUrlInput) {
    backendUrlInput.value = settings.backendUrl;
  }
  if (backendTokenInput) {
    backendTokenInput.value = settings.backendToken ?? "";
  }
  if (autoSyncHistoryInput) {
    autoSyncHistoryInput.checked = settings.autoSyncHistory;
  }
  if (selectionCaptureEnabledInput) {
    selectionCaptureEnabledInput.checked = settings.selectionCaptureEnabled;
  }
  if (indexingModeInput) {
    indexingModeInput.checked = settings.indexingMode === "trigger_word";
  }
  if (triggerWordsInput) {
    triggerWordsInput.value = settings.triggerWords.join(", ");
  }
  if (blacklistWordsInput) {
    blacklistWordsInput.value = settings.blacklistWords.join(", ");
  }

  for (const [provider, input] of Object.entries(providerInputs)) {
    if (input) {
      input.checked = settings.enabledProviders[provider as keyof typeof settings.enabledProviders];
    }
  }

  formHydrated = true;
}

function render(settings: ExtensionSettings, status: SyncStatus): void {
  syncFormFromSettings(settings);

  if (knowledgePathInput && !knowledgePathDirty && status.backendMarkdownRoot) {
    knowledgePathInput.value = status.backendMarkdownRoot;
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
  if (indexingRulesStatus) {
    indexingRulesStatus.textContent = formatIndexingRules(settings);
  }
  if (lastIndexing) {
    lastIndexing.textContent = formatLastIndexing(status);
  }
  if (backendValidation) {
    if (status.backendValidationError) {
      backendValidation.textContent = status.backendValidationError;
    } else if (status.backendValidatedAt && status.backendVersion) {
      backendValidation.textContent = `${status.backendProduct ?? "savemycontext"} ${status.backendVersion} (${status.backendAuthMode ?? "unknown"})`;
    } else {
      backendValidation.textContent = "Not validated yet";
    }
  }
  if (knowledgePathStatus) {
    if (status.backendValidationError) {
      knowledgePathStatus.textContent = "Validate the backend before changing the knowledge path.";
    } else if (status.backendMarkdownRoot && status.backendVaultRoot) {
      knowledgePathStatus.textContent = `Current root: ${status.backendMarkdownRoot}. Vault: ${status.backendVaultRoot}.`;
    } else {
      knowledgePathStatus.textContent =
        "This path lives on the backend machine. SaveMyContext writes the vault into SaveMyContext/ under this folder.";
    }
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

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!backendUrlInput) {
    return;
  }

  const nextSettings: Partial<ExtensionSettings> = {
    backendUrl: backendUrlInput.value.trim(),
    backendToken: backendTokenInput?.value.trim() ?? "",
    autoSyncHistory: autoSyncHistoryInput?.checked ?? true,
    selectionCaptureEnabled: selectionCaptureEnabledInput?.checked ?? false,
    indexingMode: indexingModeInput?.checked ? "trigger_word" : "all",
    triggerWords: [],
    blacklistWords: normalizeRuleWords(blacklistWordsInput?.value ?? ""),
    enabledProviders: {
      chatgpt: providerInputs.chatgpt?.checked ?? true,
      gemini: providerInputs.gemini?.checked ?? true,
      grok: providerInputs.grok?.checked ?? true
    }
  };
  const triggerWords = normalizeRuleWords(triggerWordsInput?.value ?? "");
  nextSettings.triggerWords =
    nextSettings.indexingMode === "trigger_word" && triggerWords.length === 0 ? ["lorem"] : triggerWords;

  const response = await sendMessage<SaveSettingsResponse>({
    type: "SAVE_SETTINGS",
    payload: nextSettings
  });
  if (!response.ok) {
    if (saveStatus) {
      saveStatus.textContent = response.error ?? "Could not validate the backend.";
    }
    if (backendValidation) {
      backendValidation.textContent = response.error ?? "Could not validate the backend.";
    }
    return;
  }

  formDirty = false;
  if (saveStatus) {
    saveStatus.textContent = "Settings saved.";
  }
  await load();
});

backendUrlInput?.addEventListener("input", () => {
  formDirty = true;
});

backendTokenInput?.addEventListener("input", () => {
  formDirty = true;
});

knowledgePathInput?.addEventListener("input", () => {
  knowledgePathDirty = true;
});

autoSyncHistoryInput?.addEventListener("change", () => {
  formDirty = true;
});

selectionCaptureEnabledInput?.addEventListener("change", () => {
  formDirty = true;
});

indexingModeInput?.addEventListener("change", () => {
  formDirty = true;
});

triggerWordsInput?.addEventListener("input", () => {
  formDirty = true;
});

blacklistWordsInput?.addEventListener("input", () => {
  formDirty = true;
});

for (const input of Object.values(providerInputs)) {
  input?.addEventListener("change", () => {
    formDirty = true;
  });
}

openDashboardButton?.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

saveKnowledgePathButton?.addEventListener("click", async () => {
  const markdownRoot = knowledgePathInput?.value.trim() ?? "";
  const response = await sendMessage<SaveKnowledgePathResponse>({
    type: "SAVE_KNOWLEDGE_PATH",
    payload: {
      markdownRoot
    }
  });
  if (!response.ok) {
    if (knowledgePathStatus) {
      knowledgePathStatus.textContent = response.error ?? "Could not update the knowledge path.";
    }
    return;
  }
  knowledgePathDirty = false;
  if (knowledgePathInput && response.storage?.markdown_root) {
    knowledgePathInput.value = response.storage.markdown_root;
  }
  if (knowledgePathStatus && response.storage) {
    const persistedTo = response.storage.persisted_to ? ` Persisted to ${response.storage.persisted_to}.` : "";
    knowledgePathStatus.textContent =
      `Vault moved to ${response.storage.vault_root}. Rebuilt ${response.storage.regenerated_session_count} sessions.${persistedTo}`;
  }
  await load();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" && areaName !== "sync") {
    return;
  }

  if (changes["savemycontext.status"]?.newValue && currentSettings) {
    currentStatus = changes["savemycontext.status"].newValue as SyncStatus;
    render(currentSettings, currentStatus);
    return;
  }

  if (changes["savemycontext.settings"] || changes["savemycontext.settings.cache"] || changes["savemycontext.settings.secrets"]) {
    void load();
  }
});

void load();
