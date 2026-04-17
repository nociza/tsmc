import {
  buildBackendHeaders,
  completeProcessingTask,
  fetchKnowledgeSearch,
  fetchNextProcessingTask,
  fetchProcessingStatus,
  saveSourceCaptureToBackend,
  updateKnowledgeStoragePath,
  validateBackendConfiguration
} from "./backend";
import { buildIngestPayload, mergeSeenMessageIds } from "./diff";
import { providerRegistry } from "../providers/registry";
import { supportsProactiveHistorySync } from "../shared/provider";
import {
  buildProcessingRepairPrompt,
  normalizePartialProcessingResponseJson,
  normalizeProcessingResponseJson
} from "../injected/proxy-json";
import {
  getProviderHistorySyncState,
  clearProviderHistorySyncStates,
  getProcessingWorkerSessionUrl,
  getProviderSessionSyncStates,
  getSessionSyncState,
  getSettings,
  getStatus,
  initializeStorage,
  saveBackendValidation,
  saveProcessingWorkerSessionUrl,
  saveProviderHistorySyncState,
  saveSessionSyncState,
  saveSettings,
  setStatus
} from "../shared/storage";
import { evaluateIndexingRules, indexingRulesFingerprint } from "../shared/indexing-rules";
import type {
  CapturedNetworkEvent,
  ExtensionSettings,
  HistorySyncUpdate,
  KnowledgeSearchResponse,
  PingProviderTabResponse,
  ProcessingTaskItem,
  ProviderDriftAlert,
  ProviderName,
  RunProviderPromptResponse,
  RuntimeMessage,
  SourceCapturePayload,
  SourceCaptureResponse,
  SaveKnowledgePathResponse,
  SaveSettingsResponse,
  SyncStatus
} from "../shared/types";

let queue = Promise.resolve();
const HISTORY_SYNC_STALE_AFTER_MS = 15 * 60 * 1000;
const BACKEND_VALIDATION_TTL_MS = 30 * 1000;
const historySyncRunErrors = new Map<string, string>();
let backendValidationInFlight: Promise<SyncStatus> | null = null;
let backendValidationInFlightKey = "";
let backendValidationLastCompletedAt = 0;
let backendValidationLastKey = "";
let backendValidationGeneration = 0;
let processingWorkerTabId: number | null = null;
let processingWorkerTabProvider: ProviderName | null = null;
let processingWorkerTabOwned = false;
const TAB_MESSAGE_RETRY_MS = 4_000;
const TAB_MESSAGE_RETRY_INTERVAL_MS = 150;
const PROVIDER_TAB_READY_TIMEOUT_MS = 10_000;
const PROVIDER_TAB_READY_INTERVAL_MS = 250;
const PROCESSING_REPAIR_ATTEMPTS = 3;
const CONTENT_SCRIPT_FILE = "assets/content.js";

function refreshedProcessingLastError(status: SyncStatus, pendingCount: number): string | null {
  if (status.processingInProgress) {
    return status.processingLastError ?? null;
  }
  if (!pendingCount) {
    return null;
  }
  return status.processingLastError ?? null;
}

const PROVIDER_START_URLS: Record<ProviderName, string> = {
  chatgpt: "https://chatgpt.com/",
  gemini: "https://gemini.google.com/app",
  grok: "https://grok.com/"
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

async function syncActionBadge(status: SyncStatus): Promise<void> {
  if (status.providerDriftAlert) {
    await chrome.action.setBadgeBackgroundColor({ color: "#BD5D38" });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setTitle({
      title: `SaveMyContext: Provider drift suspected for ${status.providerDriftAlert.provider}. Open the extension for details.`
    });
    return;
  }

  if (status.historySyncInProgress) {
    await chrome.action.setBadgeBackgroundColor({ color: "#0B8C88" });
    await chrome.action.setBadgeText({ text: "…" });
    await chrome.action.setTitle({
      title: `SaveMyContext: History sync running for ${status.historySyncProvider ?? "provider"}.`
    });
    return;
  }

  if (status.processingInProgress) {
    await chrome.action.setBadgeBackgroundColor({ color: "#16324B" });
    await chrome.action.setBadgeText({ text: "AI" });
    await chrome.action.setTitle({
      title: `SaveMyContext: AI processing running through ${status.processingProvider ?? "provider"}.`
    });
    return;
  }

  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: "SaveMyContext" });
}

async function setExtensionStatus(update: Partial<SyncStatus>): Promise<SyncStatus> {
  const status = await setStatus(update);
  await syncActionBadge(status);
  return status;
}

function clearRecoveredProviderDriftAlert(
  currentAlert: ProviderDriftAlert | null | undefined,
  provider: ProviderName
): ProviderDriftAlert | null | undefined {
  if (!currentAlert || currentAlert.provider !== provider) {
    return currentAlert;
  }

  return null;
}

function enqueueTask<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task);
  queue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function backendValidationCacheKey(settings: ExtensionSettings): string {
  return `${settings.backendUrl.trim()}::${settings.backendToken ?? ""}`;
}

function providerFromWorkerModel(model: string | undefined): ProviderName | null {
  const normalized = model?.trim().toLowerCase() ?? "";
  if (normalized.includes("chatgpt")) {
    return "chatgpt";
  }
  if (normalized.includes("gemini")) {
    return "gemini";
  }
  if (normalized.includes("grok")) {
    return "grok";
  }
  return null;
}

function tabMatchesProviderUrl(url: string | undefined, provider: ProviderName): boolean {
  if (!url) {
    return false;
  }

  try {
    const hostname = new URL(url).hostname;
    if (provider === "chatgpt") {
      return hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com") || hostname === "chat.openai.com";
    }
    if (provider === "gemini") {
      return /gemini\.google\.com/.test(hostname);
    }
    return hostname === "grok.com" || hostname.endsWith(".grok.com");
  } catch {
    return false;
  }
}

async function findReusableProviderTab(
  provider: ProviderName,
  targetUrl: string,
  preferExistingConversation: boolean
): Promise<number | null> {
  const tabs = await chrome.tabs.query({});
  const matchingTabs = tabs.filter((tab) => typeof tab.id === "number" && tabMatchesProviderUrl(tab.url, provider));
  if (!matchingTabs.length) {
    return null;
  }

  if (preferExistingConversation) {
    const exactTab = matchingTabs.find((tab) => tab.url === targetUrl);
    if (exactTab?.id) {
      return exactTab.id;
    }
  }

  if (!preferExistingConversation) {
    const activeTab = matchingTabs.find((tab) => tab.active);
    if (activeTab?.id) {
      return activeTab.id;
    }
  }

  return matchingTabs[0]?.id ?? null;
}

async function waitForTabComplete(tabId: number): Promise<void> {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") {
    return;
  }

  await new Promise<void>((resolve) => {
    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") {
        return;
      }
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureProcessingWorkerTab(provider: ProviderName): Promise<number> {
  const savedSessionUrl = await getProcessingWorkerSessionUrl(provider);
  const targetUrl = savedSessionUrl ?? PROVIDER_START_URLS[provider];
  const existingTabId = processingWorkerTabId;

  if (typeof existingTabId === "number") {
    try {
      const existing = await chrome.tabs.get(existingTabId);
      if (existing.id && processingWorkerTabProvider === provider) {
        await chrome.tabs.update(existing.id, { url: targetUrl, active: false });
        await waitForTabComplete(existing.id);
        return existing.id;
      }
    } catch {
      processingWorkerTabId = null;
      processingWorkerTabProvider = null;
      processingWorkerTabOwned = false;
    }
  }

  const reusableTabId = await findReusableProviderTab(provider, targetUrl, Boolean(savedSessionUrl));
  if (typeof reusableTabId === "number") {
    processingWorkerTabId = reusableTabId;
    processingWorkerTabProvider = provider;
    processingWorkerTabOwned = false;
    if (savedSessionUrl) {
      await chrome.tabs.update(reusableTabId, { url: targetUrl, active: false });
      await waitForTabComplete(reusableTabId);
    }
    return reusableTabId;
  }

  throw new Error(`Open a signed-in ${provider} tab and try again.`);
}

async function closeProcessingWorkerTab(): Promise<void> {
  if (typeof processingWorkerTabId !== "number") {
    return;
  }
  try {
    if (processingWorkerTabOwned) {
      await chrome.tabs.remove(processingWorkerTabId);
    }
  } catch {
    // Ignore tabs already closed by the user.
  } finally {
    processingWorkerTabId = null;
    processingWorkerTabProvider = null;
    processingWorkerTabOwned = false;
  }
}

function isRetriableTabMessageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Receiving end does not exist|Could not establish connection/i.test(message);
}

async function sendMessageToTabWithRetry<TResponse>(tabId: number, message: RuntimeMessage): Promise<TResponse> {
  const deadline = Date.now() + TAB_MESSAGE_RETRY_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return (await chrome.tabs.sendMessage(tabId, message)) as TResponse;
    } catch (error) {
      lastError = error;
      if (!isRetriableTabMessageError(error)) {
        throw error;
      }
      await sleep(TAB_MESSAGE_RETRY_INTERVAL_MS);
    }
  }

  throw (lastError instanceof Error ? lastError : new Error(String(lastError ?? "Timed out sending a tab message.")));
}

function tabSupportsInteractivePage(tab: chrome.tabs.Tab | undefined): tab is chrome.tabs.Tab & { id: number; url: string } {
  return Boolean(tab && typeof tab.id === "number" && typeof tab.url === "string" && /^https?:\/\//i.test(tab.url));
}

async function ensureQuickSearchContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [CONTENT_SCRIPT_FILE]
  });
}

async function openQuickSearchInActiveTab(): Promise<{ ok: boolean; error?: string }> {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabSupportsInteractivePage(activeTab)) {
    return {
      ok: false,
      error: "SaveMyContext quick search only works on regular http or https pages."
    };
  }

  try {
    await chrome.tabs.sendMessage(activeTab.id, {
      type: "TOGGLE_QUICK_SEARCH"
    } satisfies RuntimeMessage);
    return { ok: true };
  } catch (error) {
    if (!isRetriableTabMessageError(error)) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  try {
    await ensureQuickSearchContentScript(activeTab.id);
    await sendMessageToTabWithRetry(activeTab.id, {
      type: "TOGGLE_QUICK_SEARCH"
    } satisfies RuntimeMessage);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function sendMessageToActivePage<TResponse>(message: RuntimeMessage): Promise<TResponse> {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabSupportsInteractivePage(activeTab)) {
    throw new Error("SaveMyContext page actions only work on regular http or https pages.");
  }

  try {
    return await chrome.tabs.sendMessage(activeTab.id, message);
  } catch (error) {
    if (!isRetriableTabMessageError(error)) {
      throw error;
    }
  }

  await ensureQuickSearchContentScript(activeTab.id);
  return await sendMessageToTabWithRetry<TResponse>(activeTab.id, message);
}

async function handleKnowledgeSearch(payload: { query: string; limit?: number }): Promise<KnowledgeSearchResponse> {
  const query = payload.query.trim();
  if (query.length < 2) {
    return {
      ok: true,
      query,
      count: 0,
      results: []
    };
  }

  const settings = await getSettings();
  const status = await refreshBackendStatus(false);
  if (status.backendValidationError) {
    return {
      ok: false,
      query,
      count: 0,
      results: [],
      error: status.backendValidationError
    };
  }

  try {
    const response = await fetchKnowledgeSearch(
      {
        ...settings,
        backendUrl: status.backendUrl ?? settings.backendUrl
      },
      query,
      payload.limit ?? 8
    );
    return {
      ok: true,
      query: response.query,
      count: response.count,
      results: response.results
    };
  } catch (error) {
    return {
      ok: false,
      query,
      count: 0,
      results: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function handleSaveSourceCapture(payload: SourceCapturePayload): Promise<SourceCaptureResponse> {
  const settings = await getSettings();
  const status = await refreshBackendStatus(false);
  if (status.backendValidationError) {
    return {
      ok: false,
      error: status.backendValidationError
    };
  }

  try {
    const response = await saveSourceCaptureToBackend(
      {
        ...settings,
        backendUrl: status.backendUrl ?? settings.backendUrl
      },
      payload
    );
    await setExtensionStatus({
      lastError: null
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setExtensionStatus({
      lastError: message
    });
    return {
      ok: false,
      error: message
    };
  }
}

async function handleSaveCurrentPageSource(saveMode: "raw" | "ai" = "ai"): Promise<SourceCaptureResponse> {
  try {
    return await sendMessageToActivePage<SourceCaptureResponse>({
      type: "SAVE_CURRENT_PAGE_SOURCE",
      payload: {
        saveMode
      }
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function waitForProviderTabReady(tabId: number, provider: ProviderName): Promise<void> {
  const deadline = Date.now() + PROVIDER_TAB_READY_TIMEOUT_MS;
  let lastError: string | null = null;

  while (Date.now() < deadline) {
    try {
      const response = await sendMessageToTabWithRetry<PingProviderTabResponse>(tabId, {
        type: "PING_PROVIDER_TAB"
      } satisfies RuntimeMessage);
      if (response?.ok && response.provider === provider) {
        return;
      }
      lastError = response?.error ?? `The provider tab is not ready for ${provider}.`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(PROVIDER_TAB_READY_INTERVAL_MS);
  }

  throw new Error(lastError ?? `Timed out waiting for the ${provider} tab to become ready.`);
}

async function refreshProcessingFields(
  settings: ExtensionSettings,
  status: SyncStatus
): Promise<SyncStatus> {
  if (status.backendValidationError) {
    return status;
  }

  try {
    const processing = await fetchProcessingStatus({
      ...settings,
      backendUrl: status.backendUrl ?? settings.backendUrl
    });
    return await setExtensionStatus({
      backendUrl: status.backendUrl ?? settings.backendUrl,
      processingMode: processing.mode,
      processingWorkerModel: processing.worker_model,
      processingPendingCount: processing.pending_count,
      processingLastError: refreshedProcessingLastError(status, processing.pending_count)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return await setExtensionStatus({
      backendUrl: status.backendUrl ?? settings.backendUrl,
      backendValidationError: message,
      processingPendingCount: undefined,
      processingMode: undefined,
      processingWorkerModel: undefined,
      processingLastError: message
    });
  }
}

async function refreshBackendStatus(force = false): Promise<SyncStatus> {
  const settings = await getSettings();
  const validationKey = backendValidationCacheKey(settings);
  const now = Date.now();

  if (!force) {
    if (backendValidationInFlight && backendValidationInFlightKey === validationKey) {
      return backendValidationInFlight;
    }

    if (
      validationKey === backendValidationLastKey &&
      now - backendValidationLastCompletedAt < BACKEND_VALIDATION_TTL_MS
    ) {
      return refreshProcessingFields(settings, await getStatus());
    }
  }

  const validationGeneration = ++backendValidationGeneration;
  backendValidationInFlight = (async () => {
    const candidateBackendUrl = settings.backendUrl.trim().replace(/\/$/, "");

    try {
      const { normalizedUrl, capabilities } = await validateBackendConfiguration(settings);
      const processing = await fetchProcessingStatus(
        {
          ...settings,
          backendUrl: normalizedUrl
        },
        capabilities
      );
      const latestSettings = await getSettings();
      if (
        validationGeneration !== backendValidationGeneration ||
        backendValidationCacheKey(latestSettings) !== validationKey
      ) {
        return await getStatus();
      }
      await saveBackendValidation(capabilities, null);
      const nextStatus = await setExtensionStatus({
        backendUrl: normalizedUrl,
        autoSyncHistory: settings.autoSyncHistory,
        backendValidatedAt: new Date().toISOString(),
        backendProduct: capabilities.product,
        backendVersion: capabilities.version,
        backendAuthMode: capabilities.auth.mode,
        backendValidationError: null,
        backendMarkdownRoot: capabilities.storage.markdown_root,
        backendVaultRoot: capabilities.storage.vault_root,
        processingMode: processing.mode,
        processingWorkerModel: processing.worker_model,
        processingPendingCount: processing.pending_count,
        processingLastError: refreshedProcessingLastError(await getStatus(), processing.pending_count)
      });
      backendValidationLastKey = validationKey;
      backendValidationLastCompletedAt = Date.now();
      return nextStatus;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const latestSettings = await getSettings();
      if (
        validationGeneration !== backendValidationGeneration ||
        backendValidationCacheKey(latestSettings) !== validationKey
      ) {
        return await getStatus();
      }
      await saveBackendValidation(null, message);
      const nextStatus = await setExtensionStatus({
        backendUrl: candidateBackendUrl || settings.backendUrl,
        autoSyncHistory: settings.autoSyncHistory,
        backendValidationError: message,
        backendMarkdownRoot: undefined,
        backendVaultRoot: undefined,
        processingPendingCount: undefined,
        processingMode: undefined,
        processingWorkerModel: undefined
      });
      backendValidationLastKey = validationKey;
      backendValidationLastCompletedAt = Date.now();
      return nextStatus;
    } finally {
      if (backendValidationInFlightKey === validationKey && validationGeneration === backendValidationGeneration) {
        backendValidationInFlight = null;
        backendValidationInFlightKey = "";
      }
    }
  })();
  backendValidationInFlightKey = validationKey;

  return backendValidationInFlight;
}

chrome.runtime.onInstalled.addListener(() => {
  void initializeStorage().then(() => refreshBackendStatus(true));
});

chrome.runtime.onStartup.addListener(() => {
  void initializeStorage().then(() => refreshBackendStatus(true));
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "open-quick-search") {
    return;
  }
  void openQuickSearchInActiveTab();
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type === "NETWORK_CAPTURE") {
    void enqueueTask(() => handleCapture(message.payload, _sender.tab?.id))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("SaveMyContext capture failed", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    return true;
  }

  if (message.type === "PAGE_VISIT") {
    void handlePageVisit(message.payload, _sender.tab?.id).then(sendResponse);
    return true;
  }

  if (message.type === "HISTORY_SYNC_STATUS") {
    void enqueueTask(() => handleHistorySyncStatus(message.payload))
      .then(sendResponse)
      .catch((error) => {
        console.error("SaveMyContext history sync status update failed", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    return true;
  }

  if (message.type === "GET_SETTINGS") {
    void getSettings().then(sendResponse);
    return true;
  }

  if (message.type === "SAVE_SETTINGS") {
    void enqueueTask(() => handleSaveSettings(message.payload))
      .then(sendResponse)
      .catch((error) => {
        console.error("SaveMyContext settings save failed", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies SaveSettingsResponse);
      });
    return true;
  }

  if (message.type === "GET_STATUS") {
    void refreshBackendStatus(false).then(sendResponse);
    return true;
  }

  if (message.type === "SAVE_KNOWLEDGE_PATH") {
    void enqueueTask(() => handleSaveKnowledgePath(message.payload.markdownRoot))
      .then(sendResponse)
      .catch((error) => {
        console.error("SaveMyContext knowledge path save failed", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies SaveKnowledgePathResponse);
      });
    return true;
  }

  if (message.type === "SAVE_SOURCE_CAPTURE") {
    void enqueueTask(() => handleSaveSourceCapture(message.payload))
      .then(sendResponse)
      .catch((error) => {
        console.error("SaveMyContext source capture failed", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies SourceCaptureResponse);
      });
    return true;
  }

  if (message.type === "SAVE_CURRENT_PAGE_SOURCE") {
    void enqueueTask(() => handleSaveCurrentPageSource(message.payload?.saveMode ?? "ai"))
      .then(sendResponse)
      .catch((error) => {
        console.error("SaveMyContext page capture failed", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies SourceCaptureResponse);
      });
    return true;
  }

  if (message.type === "OPEN_QUICK_SEARCH") {
    void openQuickSearchInActiveTab().then(sendResponse);
    return true;
  }

  if (message.type === "SEARCH_KNOWLEDGE") {
    void handleKnowledgeSearch(message.payload).then(sendResponse);
    return true;
  }

  if (message.type === "START_PROCESSING") {
    void enqueueTask(() => startProcessingWorker())
      .then(sendResponse)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error("SaveMyContext processing start failed", error);
        void setExtensionStatus({
          processingInProgress: false,
          processingLastError: message,
          processingLastRunAt: new Date().toISOString()
        }).finally(() => {
          sendResponse({ ok: false, error: message });
        });
      });
    return true;
  }

  return false;
});

async function runProviderPromptInTab(
  tabId: number,
  promptText: string,
  preferFastMode = false,
  requireCompleteJson = false
): Promise<Required<Pick<RunProviderPromptResponse, "responseText" | "pageUrl">> & RunProviderPromptResponse> {
  const response = await sendMessageToTabWithRetry<RunProviderPromptResponse>(tabId, {
    type: "RUN_PROVIDER_PROMPT",
    payload: {
      promptText,
      preferFastMode,
      requireCompleteJson
    }
  } satisfies RuntimeMessage);

  if (!response || !response.ok || !response.responseText || !response.pageUrl) {
    throw new Error(response?.error ?? "The provider tab did not return a response.");
  }

  return response as Required<Pick<RunProviderPromptResponse, "responseText" | "pageUrl">> & RunProviderPromptResponse;
}

function isRecoverableProcessingCompletionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Processing completion failed with 400:/i.test(message);
}

async function submitProcessingCompletion(
  settings: ExtensionSettings,
  taskRefs: Array<{ sessionId: string; taskKey?: string }>,
  responseText: string
): Promise<number> {
  await completeProcessingTask(settings, {
    sessionIds: taskRefs.map((task) => task.sessionId),
    responseText
  });
  return taskRefs.length;
}

async function completeProcessingTaskWithRecovery(
  settings: ExtensionSettings,
  provider: ProviderName,
  tabId: number,
  tasks: ProcessingTaskItem[],
  initialResponseText: string
): Promise<number> {
  const taskRefs = tasks.map((task) => ({
    sessionId: task.session_id,
    taskKey: task.task_key
  }));
  let candidate = initialResponseText;
  let lastError = "The provider did not return valid JSON.";

  for (let attempt = 0; attempt < PROCESSING_REPAIR_ATTEMPTS; attempt += 1) {
    const normalized = normalizeProcessingResponseJson(candidate, taskRefs);
    if (normalized.ok) {
      try {
        return await submitProcessingCompletion(settings, taskRefs, normalized.jsonText);
      } catch (error) {
        if (!isRecoverableProcessingCompletionError(error)) {
          throw error;
        }
        lastError = error instanceof Error ? error.message : String(error);
      }
    } else {
      lastError = normalized.error;
      if (taskRefs.length > 1) {
        const partial = normalizePartialProcessingResponseJson(candidate, taskRefs);
        if (partial.ok && partial.tasks.length < taskRefs.length) {
          try {
            return await submitProcessingCompletion(settings, partial.tasks, partial.jsonText);
          } catch (error) {
            if (!isRecoverableProcessingCompletionError(error)) {
              throw error;
            }
            lastError = error instanceof Error ? error.message : String(error);
          }
        }
      }
    }

    if (attempt >= PROCESSING_REPAIR_ATTEMPTS - 1) {
      throw new Error(lastError);
    }

    const repaired = await runProviderPromptInTab(
      tabId,
      buildProcessingRepairPrompt(candidate, lastError, taskRefs),
      true,
      true
    );
    if (repaired.provider && repaired.provider !== provider) {
      throw new Error(
        `The repair response came from ${repaired.provider} while ${provider} was expected.`
      );
    }
    await saveProcessingWorkerSessionUrl(provider, repaired.pageUrl);
    candidate = repaired.responseText;
  }

  throw new Error(lastError);
}

async function runProcessingWorkerLoop(
  settings: ExtensionSettings,
  provider: ProviderName,
  workerModel: string,
  tabId: number
): Promise<void> {
  let processedCount = 0;

  try {
    while (true) {
      const task = await fetchNextProcessingTask(settings);
      const sessionIds = task.tasks.map((item) => item.session_id);
      if (!task.available || !task.prompt || !task.tasks.length || !sessionIds.length) {
        const finalStatus = await fetchProcessingStatus(settings);
        await setExtensionStatus({
          processingInProgress: false,
          processingProvider: provider,
          processingWorkerModel: workerModel,
          processingProcessedCount: processedCount,
          processingPendingCount: finalStatus.pending_count,
          processingLastError: null,
          processingLastRunAt: new Date().toISOString()
        });
        await closeProcessingWorkerTab();
        return;
      }

      const proxyResult = await runProviderPromptInTab(tabId, task.prompt, true, true);
      if (proxyResult.provider && proxyResult.provider !== provider) {
        throw new Error(
          `The processing tab returned a ${proxyResult.provider} response while ${provider} was expected.`
        );
      }
      await saveProcessingWorkerSessionUrl(provider, proxyResult.pageUrl);
      const completedCount = await completeProcessingTaskWithRecovery(
        settings,
        provider,
        tabId,
        task.tasks,
        proxyResult.responseText
      );

      processedCount += completedCount;
      const processingStatus = await fetchProcessingStatus(settings);
      await setExtensionStatus({
        processingInProgress: true,
        processingProvider: provider,
        processingWorkerModel: workerModel,
        processingProcessedCount: processedCount,
        processingPendingCount: processingStatus.pending_count,
        processingLastError: null,
        processingLastRunAt: new Date().toISOString()
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let pendingCount: number | undefined;
    try {
      const processingStatus = await fetchProcessingStatus(settings);
      pendingCount = processingStatus.pending_count;
    } catch {
      pendingCount = undefined;
    }
    await setExtensionStatus({
      processingInProgress: false,
      processingProvider: provider,
      processingWorkerModel: workerModel,
      processingProcessedCount: processedCount,
      processingPendingCount: pendingCount,
      processingLastError: message,
      processingLastRunAt: new Date().toISOString()
    });
    await closeProcessingWorkerTab();
  }
}

async function startProcessingWorker(): Promise<{ ok: boolean; error?: string }> {
  const settings = await getSettings();
  const status = await refreshBackendStatus(false);
  if (status.backendValidationError) {
    return { ok: false, error: status.backendValidationError };
  }
  if (status.processingInProgress) {
    return { ok: false, error: "AI processing is already running." };
  }

  const resolvedSettings = {
    ...settings,
    backendUrl: status.backendUrl ?? settings.backendUrl
  };
  const processingStatus = await fetchProcessingStatus(resolvedSettings);
  await setExtensionStatus({
    processingMode: processingStatus.mode,
    processingWorkerModel: processingStatus.worker_model,
    processingPendingCount: processingStatus.pending_count,
    processingLastError: null
  });

  if (!processingStatus.enabled) {
    return { ok: false, error: "Backend-side browser processing is not enabled." };
  }
  if (!processingStatus.pending_count) {
    return { ok: true };
  }
  const provider = providerFromWorkerModel(processingStatus.worker_model);
  if (!provider || !processingStatus.worker_model) {
    return { ok: false, error: "Backend did not provide a supported browser worker model." };
  }

  const tabId = await ensureProcessingWorkerTab(provider);
  await waitForProviderTabReady(tabId, provider);
  await setExtensionStatus({
    processingInProgress: true,
    processingProvider: provider,
    processingWorkerModel: processingStatus.worker_model,
    processingPendingCount: processingStatus.pending_count,
    processingProcessedCount: 0,
    processingLastError: null
  });

  try {
    void runProcessingWorkerLoop(resolvedSettings, provider, processingStatus.worker_model, tabId);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setExtensionStatus({
      processingInProgress: false,
      processingProvider: provider,
      processingLastError: `Could not reach the provider tab: ${message}`
    });
    await closeProcessingWorkerTab();
    return { ok: false, error: `Could not reach the provider tab: ${message}` };
  }
}

function findMatchingProvider(event: CapturedNetworkEvent) {
  for (const provider of providerRegistry) {
    try {
      if (provider.matches(event)) {
        return provider;
      }
    } catch (error) {
      console.warn(`SaveMyContext provider matcher failed for ${provider.provider}`, error);
    }
  }

  return null;
}

function extractExternalSessionIds(
  provider: ProviderName,
  sessionStates: Record<
    string,
    {
      seenMessageIds: string[];
      lastSyncedAt?: string;
      indexingRuleDecision?: "indexed" | "skipped";
      indexingRuleFingerprint?: string;
    }
  >,
  settings: ExtensionSettings
): string[] {
  const prefix = `${provider}:`;
  const fingerprint = indexingRulesFingerprint(settings);
  return Object.keys(sessionStates)
    .filter((sessionKey) => {
      if (!sessionKey.startsWith(prefix)) {
        return false;
      }
      const state = sessionStates[sessionKey];
      if (state?.lastSyncedAt) {
        return true;
      }
      return state?.indexingRuleDecision === "skipped" && state?.indexingRuleFingerprint === fingerprint;
    })
    .map((sessionKey) => sessionKey.slice(prefix.length))
    .filter(Boolean);
}

async function handlePageVisit(
  payload: { provider: ProviderName; pageUrl: string },
  tabId: number | undefined
): Promise<{ triggered: boolean; reason?: string }> {
  if (typeof tabId === "number" && tabId === processingWorkerTabId) {
    return { triggered: false, reason: "processing-worker-tab" };
  }
  const settings = await getSettings();
  const backendStatus = await refreshBackendStatus(false);
  if (backendStatus.backendValidationError) {
    return { triggered: false, reason: "backend-unavailable" };
  }
  if (!settings.enabledProviders[payload.provider]) {
    return { triggered: false, reason: "provider-disabled" };
  }
  if (!settings.autoSyncHistory) {
    return { triggered: false, reason: "auto-sync-disabled" };
  }
  if (!supportsProactiveHistorySync(payload.provider)) {
    await setExtensionStatus({
      autoSyncHistory: settings.autoSyncHistory,
      historySyncInProgress: false,
      historySyncProvider: payload.provider,
      historySyncLastPageUrl: payload.pageUrl,
      historySyncLastResult: "unsupported"
    });
    return { triggered: false, reason: "provider-unsupported" };
  }
  if (typeof tabId !== "number") {
    return { triggered: false, reason: "missing-tab-id" };
  }

  const currentState = await getProviderHistorySyncState(payload.provider);
  const lastStartedAt = currentState.lastStartedAt ? Date.parse(currentState.lastStartedAt) : Number.NaN;
  const staleInProgress =
    currentState.inProgress &&
    !Number.isNaN(lastStartedAt) &&
    Date.now() - lastStartedAt >= HISTORY_SYNC_STALE_AFTER_MS;

  if (currentState.inProgress && !staleInProgress) {
    return { triggered: false, reason: "already-in-progress" };
  }

  const hasExistingHistoryWatermark =
    Boolean(currentState.lastTopSessionId) || Boolean(currentState.lastTopSessionIds?.length);
  const syncedSessionIds = hasExistingHistoryWatermark
    ? undefined
    : extractExternalSessionIds(payload.provider, await getProviderSessionSyncStates(payload.provider), settings);
  const previousTopSessionIds =
    currentState.lastTopSessionIds ??
    (currentState.lastTopSessionId ? [currentState.lastTopSessionId] : undefined);
  const now = new Date().toISOString();
  await saveProviderHistorySyncState(payload.provider, {
    ...currentState,
    inProgress: true,
    lastStartedAt: now,
    lastPageUrl: payload.pageUrl,
    processedCount: 0,
    totalCount: undefined,
    skippedCount: 0
  });
  await setExtensionStatus({
    autoSyncHistory: settings.autoSyncHistory,
    historySyncInProgress: true,
    historySyncProvider: payload.provider,
    historySyncLastStartedAt: now,
    historySyncLastPageUrl: payload.pageUrl,
    historySyncLastResult: undefined,
    historySyncLastError: null,
    historySyncProcessedCount: 0,
    historySyncTotalCount: undefined,
    historySyncSkippedCount: 0
  });

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "TRIGGER_HISTORY_SYNC",
      payload: {
        provider: payload.provider,
        syncedSessionIds,
        previousTopSessionId: currentState.lastTopSessionId,
        previousTopSessionIds
      }
    } satisfies RuntimeMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await saveProviderHistorySyncState(payload.provider, {
      ...currentState,
      inProgress: false,
      lastPageUrl: payload.pageUrl
    });
    await setExtensionStatus({
      historySyncInProgress: false,
      historySyncProvider: payload.provider,
      historySyncLastPageUrl: payload.pageUrl,
      historySyncLastResult: "failed",
      historySyncLastError: `Could not reach the page context: ${message}`
    });
    return { triggered: false, reason: "message-delivery-failed" };
  }

  return { triggered: true };
}

async function handleHistorySyncStatus(update: HistorySyncUpdate): Promise<{ ok: true }> {
  if (update.phase === "started" && update.runId) {
    historySyncRunErrors.delete(update.runId);
  }

  const currentState = await getProviderHistorySyncState(update.provider);
  const currentStatus = await getStatus();
  const existingTopSessionIds =
    currentState.lastTopSessionIds ??
    (currentState.lastTopSessionId ? [currentState.lastTopSessionId] : undefined);
  const nextTopSessionIds = update.topSessionIds ?? (update.topSessionId ? [update.topSessionId] : existingTopSessionIds);
  const basePatch = {
    ...currentState,
    lastPageUrl: update.pageUrl,
    lastDriftAlert: update.providerDriftAlert ?? currentState.lastDriftAlert
  };
  const watermarkPatch = {
    lastTopSessionId: update.topSessionId ?? update.topSessionIds?.[0] ?? currentState.lastTopSessionId,
    lastTopSessionIds: nextTopSessionIds
  };

  if (update.phase === "started") {
    const startedAt = currentState.lastStartedAt ?? new Date().toISOString();
    await saveProviderHistorySyncState(update.provider, {
      ...basePatch,
      inProgress: true,
      lastStartedAt: startedAt,
      processedCount: update.processedCount ?? currentState.processedCount,
      totalCount: update.totalCount ?? currentState.totalCount,
      skippedCount: update.skippedCount ?? currentState.skippedCount
    });
    await setExtensionStatus({
      historySyncInProgress: true,
      historySyncProvider: update.provider,
      historySyncLastStartedAt: startedAt,
      historySyncLastPageUrl: update.pageUrl,
      historySyncLastResult: undefined,
      historySyncLastError: null,
      historySyncProcessedCount: update.processedCount ?? currentState.processedCount,
      historySyncTotalCount: update.totalCount ?? currentState.totalCount,
      historySyncSkippedCount: update.skippedCount ?? currentState.skippedCount
    });
    return { ok: true };
  }

  const completedAt = new Date().toISOString();
  const runError = update.runId ? historySyncRunErrors.get(update.runId) : undefined;
  if (update.runId) {
    historySyncRunErrors.delete(update.runId);
  }

  if (update.phase === "completed") {
    if (runError) {
      await saveProviderHistorySyncState(update.provider, {
        ...basePatch,
        inProgress: false,
        lastCompletedAt: completedAt
      });
      await setExtensionStatus({
        historySyncInProgress: false,
        historySyncProvider: update.provider,
        historySyncLastCompletedAt: completedAt,
        historySyncLastPageUrl: update.pageUrl,
        historySyncLastResult: "failed",
        historySyncLastError: runError,
        providerDriftAlert: update.providerDriftAlert ?? currentStatus.providerDriftAlert
      });
      return { ok: true };
    }

    const processedCount = update.processedCount ?? update.totalCount ?? currentState.processedCount;
    const totalCount = update.totalCount ?? currentState.totalCount;
    const skippedCount = update.skippedCount ?? currentState.skippedCount;
    const providerDriftAlert =
      update.providerDriftAlert ?? clearRecoveredProviderDriftAlert(currentStatus.providerDriftAlert, update.provider);
    const providerStateDriftAlert =
      update.providerDriftAlert ?? clearRecoveredProviderDriftAlert(currentState.lastDriftAlert, update.provider);
    await saveProviderHistorySyncState(update.provider, {
      ...basePatch,
      ...(update.providerDriftAlert ? {} : watermarkPatch),
      inProgress: false,
      lastCompletedAt: completedAt,
      lastConversationCount: update.conversationCount ?? currentState.lastConversationCount,
      processedCount,
      totalCount,
      skippedCount,
      lastDriftAlert: providerStateDriftAlert
    });
    await setExtensionStatus({
      historySyncInProgress: false,
      historySyncProvider: update.provider,
      historySyncLastCompletedAt: completedAt,
      historySyncLastConversationCount: update.conversationCount,
      historySyncLastPageUrl: update.pageUrl,
      historySyncLastResult: "success",
      historySyncLastError: null,
      historySyncProcessedCount: processedCount,
      historySyncTotalCount: totalCount,
      historySyncSkippedCount: skippedCount,
      providerDriftAlert
    });
    return { ok: true };
  }

  if (update.phase === "unsupported") {
    const processedCount = update.processedCount ?? currentState.processedCount;
    const totalCount = update.totalCount ?? currentState.totalCount;
    const skippedCount = update.skippedCount ?? currentState.skippedCount;
    const providerStateDriftAlert = clearRecoveredProviderDriftAlert(currentState.lastDriftAlert, update.provider);
    await saveProviderHistorySyncState(update.provider, {
      ...basePatch,
      inProgress: false,
      lastCompletedAt: completedAt,
      processedCount,
      totalCount,
      skippedCount,
      lastDriftAlert: providerStateDriftAlert
    });
    await setExtensionStatus({
      historySyncInProgress: false,
      historySyncProvider: update.provider,
      historySyncLastCompletedAt: completedAt,
      historySyncLastPageUrl: update.pageUrl,
      historySyncLastResult: "unsupported",
      historySyncLastError: update.message ?? null,
      historySyncProcessedCount: processedCount,
      historySyncTotalCount: totalCount,
      historySyncSkippedCount: skippedCount,
      providerDriftAlert: clearRecoveredProviderDriftAlert(currentStatus.providerDriftAlert, update.provider)
    });
    return { ok: true };
  }

  const processedCount = update.processedCount ?? currentState.processedCount;
  const totalCount = update.totalCount ?? currentState.totalCount;
  const skippedCount = update.skippedCount ?? currentState.skippedCount;
  const providerDriftAlert = update.providerDriftAlert ?? currentStatus.providerDriftAlert;
  const providerStateDriftAlert = update.providerDriftAlert ?? currentState.lastDriftAlert;
  await saveProviderHistorySyncState(update.provider, {
    ...basePatch,
    inProgress: false,
    lastCompletedAt: completedAt,
    processedCount,
    totalCount,
    skippedCount,
    lastDriftAlert: providerStateDriftAlert
  });
  await setExtensionStatus({
    historySyncInProgress: false,
    historySyncProvider: update.provider,
    historySyncLastCompletedAt: completedAt,
    historySyncLastPageUrl: update.pageUrl,
    historySyncLastResult: "failed",
    historySyncLastError: update.message ?? "History sync failed.",
    historySyncProcessedCount: processedCount,
    historySyncTotalCount: totalCount,
    historySyncSkippedCount: skippedCount,
    providerDriftAlert
  });
  return { ok: true };
}

async function handleCapture(event: CapturedNetworkEvent, tabId?: number): Promise<void> {
  if (typeof tabId === "number" && tabId === processingWorkerTabId) {
    return;
  }

  const settings = await getSettings();
  const scraper = findMatchingProvider(event);
  if (!scraper || !settings.enabledProviders[scraper.provider]) {
    return;
  }

  const snapshot = scraper.parse(event);
  if (!snapshot || !snapshot.messages.length) {
    return;
  }

  const sessionKey = `${snapshot.provider}:${snapshot.externalSessionId}`;
  const syncState = await getSessionSyncState(sessionKey);
  const indexingDecision = evaluateIndexingRules(settings, snapshot);
  const indexingFingerprint = indexingRulesFingerprint(settings);
  if (!indexingDecision.shouldIndex) {
    await saveSessionSyncState(sessionKey, {
      ...syncState,
      indexingRuleDecision: "skipped",
      indexingRuleFingerprint: indexingFingerprint,
      indexingRuleReason: indexingDecision.reason
    });
    await setExtensionStatus({
      backendUrl: settings.backendUrl.replace(/\/$/, ""),
      lastProvider: snapshot.provider,
      lastSessionKey: sessionKey,
      lastIndexingDecision: "skipped",
      lastIndexingReason: indexingDecision.reason,
      lastError: null,
      autoSyncHistory: settings.autoSyncHistory
    });
    return;
  }
  const payload = buildIngestPayload(snapshot, event, syncState);
  if (!payload) {
    return;
  }

  const backendUrl = settings.backendUrl.replace(/\/$/, "");
  const markHistorySyncFailure = (message: string): void => {
    if (event.captureMode === "full_snapshot" && event.historySyncRunId) {
      historySyncRunErrors.set(event.historySyncRunId, message);
    }
  };

  let response: Response;
  try {
    response = await fetch(`${backendUrl}/api/v1/ingest/diff`, {
      method: "POST",
      headers: buildBackendHeaders(settings),
      body: JSON.stringify(payload)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setExtensionStatus({
      backendUrl,
      lastError: `Backend request failed: ${message}`
    });
    markHistorySyncFailure(`Backend request failed: ${message}`);
    throw error;
  }

  if (!response.ok) {
    const details = (await response.text()).slice(0, 400);
    await setExtensionStatus({
      backendUrl,
      lastError: `Backend responded ${response.status}: ${details}`
    });
    markHistorySyncFailure(`Backend responded ${response.status}: ${details}`);
    throw new Error(`SaveMyContext sync failed: ${response.status}`);
  }

  await saveSessionSyncState(sessionKey, {
    seenMessageIds: mergeSeenMessageIds(syncState.seenMessageIds, snapshot.messages),
    lastSyncedAt: new Date().toISOString(),
    indexingRuleDecision: "indexed",
    indexingRuleFingerprint: indexingFingerprint,
    indexingRuleReason: indexingDecision.reason
  });
  await setExtensionStatus({
    backendUrl,
    lastError: null,
    lastProvider: snapshot.provider,
    lastSessionKey: sessionKey,
    lastSuccessAt: new Date().toISOString(),
    lastSyncedMessageCount: payload.messages.length,
    autoSyncHistory: settings.autoSyncHistory,
    lastIndexingDecision: "indexed",
    lastIndexingReason: indexingDecision.reason
  });
}

async function handleSaveSettings(update: Partial<ExtensionSettings>): Promise<SaveSettingsResponse> {
  const currentSettings = await getSettings();
  const candidateSettings: ExtensionSettings = {
    ...currentSettings,
    ...update
  };
  backendValidationGeneration += 1;
  backendValidationInFlight = null;
  backendValidationInFlightKey = "";

  try {
    const { normalizedUrl, capabilities } = await validateBackendConfiguration(candidateSettings);
    const processing = await fetchProcessingStatus(
      {
        ...candidateSettings,
        backendUrl: normalizedUrl
      },
      capabilities
    );
    const saved = await saveSettings({
      ...update,
      backendUrl: normalizedUrl
    });
    if (indexingRulesFingerprint(currentSettings) !== indexingRulesFingerprint(saved)) {
      await clearProviderHistorySyncStates();
    }
    await saveBackendValidation(capabilities, null);
    backendValidationLastKey = backendValidationCacheKey(saved);
    backendValidationLastCompletedAt = Date.now();
    await setExtensionStatus({
      backendUrl: normalizedUrl,
      autoSyncHistory: saved.autoSyncHistory,
      backendValidatedAt: new Date().toISOString(),
      backendProduct: capabilities.product,
      backendVersion: capabilities.version,
      backendAuthMode: capabilities.auth.mode,
      backendValidationError: null,
      backendMarkdownRoot: capabilities.storage.markdown_root,
      backendVaultRoot: capabilities.storage.vault_root,
      processingMode: processing.mode,
      processingWorkerModel: processing.worker_model,
      processingPendingCount: processing.pending_count,
      processingLastError: null
    });
    return {
      ok: true,
      settings: saved,
      capabilities
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await saveBackendValidation(null, message);
    await setExtensionStatus({
      backendUrl: candidateSettings.backendUrl.trim().replace(/\/$/, "") || candidateSettings.backendUrl,
      autoSyncHistory: candidateSettings.autoSyncHistory,
      backendValidationError: message,
      backendMarkdownRoot: undefined,
      backendVaultRoot: undefined,
      processingPendingCount: undefined,
      processingMode: undefined,
      processingWorkerModel: undefined
    });
    return {
      ok: false,
      error: message
    };
  }
}

async function handleSaveKnowledgePath(markdownRoot: string): Promise<SaveKnowledgePathResponse> {
  const nextPath = markdownRoot.trim();
  if (!nextPath) {
    return {
      ok: false,
      error: "Enter an absolute knowledge storage path."
    };
  }

  const settings = await getSettings();
  const status = await refreshBackendStatus(false);
  if (status.backendValidationError) {
    return {
      ok: false,
      error: status.backendValidationError
    };
  }

  try {
    const storage = await updateKnowledgeStoragePath(
      {
        ...settings,
        backendUrl: status.backendUrl ?? settings.backendUrl
      },
      nextPath
    );
    await refreshBackendStatus(true);
    return {
      ok: true,
      storage
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
