import {
  buildBackendHeaders,
  completeProcessingTask,
  fetchKnowledgeSearch,
  fetchNextProcessingTask,
  fetchProcessingStatus,
  redeemConnectionBundle,
  saveSourceCaptureToBackend,
  updateKnowledgeStoragePath,
  validateBackendConfiguration
} from "./backend";
import { buildIngestPayload, mergeSeenMessageIds } from "./diff";
import { activeHistoryWatermarks, shouldCommitHistoryWatermark } from "./history-watermark";
import {
  buildProviderRefreshAlarmPlan,
  providerFromRefreshAlarmName,
  providerRefreshAlarmName
} from "./provider-refresh";
import { providerRegistry } from "../providers/registry";
import { detectProviderFromUrl, supportsProactiveHistorySync } from "../shared/provider";
import {
  buildProcessingRepairPrompt,
  normalizePartialProcessingResponseJson,
  normalizeProcessingResponseJson
} from "../injected/proxy-json";
import {
  getInstallationId,
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
import { parseConnectionString } from "../shared/connection";
import { evaluateDiscardWords, evaluateIndexingRules, indexingRulesFingerprint } from "../shared/indexing-rules";
import type {
  ActiveChatContextResponse,
  ActiveChatContextSnapshot,
  BackendSearchResult,
  CapturedNetworkEvent,
  ExtensionSettings,
  HistorySyncUpdate,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
  NormalizedSessionSnapshot,
  PingProviderTabResponse,
  ProcessingTaskItem,
  ProviderDriftAlert,
  ProviderHistorySyncState,
  ProviderName,
  RunProviderPromptResponse,
  RuntimeMessage,
  SourceCapturePayload,
  SourceCaptureResponse,
  SaveConnectionBundleResponse,
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
const activeChatContextsByTabId = new Map<number, ActiveChatContextSnapshot>();
const TAB_MESSAGE_RETRY_MS = 4_000;
const TAB_MESSAGE_RETRY_INTERVAL_MS = 150;
const PROVIDER_TAB_READY_TIMEOUT_MS = 10_000;
const PROVIDER_TAB_READY_INTERVAL_MS = 250;
const PROVIDER_REFRESH_TAB_LOAD_TIMEOUT_MS = 30_000;
const PROCESSING_REPAIR_ATTEMPTS = 3;
const CONTENT_SCRIPT_FILE = "assets/content.js";
const HISTORY_SYNC_PROVIDERS: ProviderName[] = ["chatgpt", "gemini", "grok"];
const scheduledProviderRefreshesInFlight = new Set<ProviderName>();
const ACTION_ICON_PATHS: Record<number, string> = {
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
  48: "icons/icon-48.png",
  128: "icons/icon-128.png"
};
const ACTION_ICON_SIZES = [16, 32, 48, 128] as const;
const syncIconImageData = new Map<number, ImageData>();
let actionIconMode: "default" | "syncing" = "default";

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

function formatProviderName(provider: ProviderName): string {
  if (provider === "chatgpt") {
    return "ChatGPT";
  }
  if (provider === "gemini") {
    return "Gemini";
  }
  return "Grok";
}

function formatProviderList(providers: ProviderName[] | undefined, fallback: ProviderName | undefined): string {
  const names = (providers?.length ? providers : fallback ? [fallback] : []).map(formatProviderName);
  return names.length ? names.join(", ") : "provider";
}

function rememberActiveChatContext(tabId: number, snapshot: NormalizedSessionSnapshot, pageUrl: string): void {
  const messages = snapshot.messages
    .slice(Math.max(snapshot.messages.length - 10, 0))
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content.slice(0, 2_000),
      occurredAt: message.occurredAt
    }));

  activeChatContextsByTabId.set(tabId, {
    provider: snapshot.provider,
    externalSessionId: snapshot.externalSessionId,
    title: snapshot.title,
    sourceUrl: snapshot.sourceUrl,
    pageUrl,
    capturedAt: snapshot.capturedAt,
    messages
  });
}

function clearActiveChatContext(tabId: number | undefined): void {
  if (typeof tabId === "number") {
    activeChatContextsByTabId.delete(tabId);
  }
}

function searchResultIdentity(result: BackendSearchResult): string {
  if (result.entity_id) {
    return `entity:${result.entity_id.toLowerCase()}`;
  }
  if (result.source_id) {
    return `source:${result.source_id}`;
  }
  if (result.session_id) {
    return `session:${result.session_id}`;
  }
  if (result.markdown_path) {
    return `${result.kind}:${result.markdown_path}`;
  }
  return `${result.kind}:${result.title.toLowerCase()}`;
}

function mergeSearchResults(results: BackendSearchResult[]): BackendSearchResult[] {
  const merged = new Map<string, BackendSearchResult>();
  for (const result of results) {
    const identity = searchResultIdentity(result);
    if (!merged.has(identity)) {
      merged.set(identity, result);
    }
  }
  return [...merged.values()];
}

function normalizeKnowledgeSearchQueries(payload: KnowledgeSearchRequest): string[] {
  return [...new Set([payload.query ?? "", ...(payload.queries ?? [])].map((value) => value.trim()).filter((value) => value.length >= 2))].slice(
    0,
    8
  );
}

async function extensionClientName(): Promise<string> {
  const platform = await chrome.runtime.getPlatformInfo();
  return `Chrome ${platform.os}`;
}

function isFreshHistorySyncInProgress(state: ProviderHistorySyncState): boolean {
  const lastStartedAt = state.lastStartedAt ? Date.parse(state.lastStartedAt) : Number.NaN;
  const staleInProgress =
    state.inProgress &&
    !Number.isNaN(lastStartedAt) &&
    Date.now() - lastStartedAt >= HISTORY_SYNC_STALE_AFTER_MS;
  return Boolean(state.inProgress && !staleInProgress);
}

function createSyncActionIcon(size: number): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext("2d");
  if (!context) {
    return new ImageData(size, size);
  }

  const center = size / 2;
  const outerRadius = size * 0.45;
  const ringRadius = size * 0.28;
  const lineWidth = Math.max(1.4, size * 0.1);
  const arrowSize = Math.max(2.2, size * 0.14);

  context.clearRect(0, 0, size, size);
  context.fillStyle = "#0f1b2c";
  context.beginPath();
  context.arc(center, center, outerRadius, 0, Math.PI * 2);
  context.fill();

  context.lineWidth = lineWidth;
  context.lineCap = "round";
  context.strokeStyle = "#fbf9f3";
  context.beginPath();
  context.arc(center, center, ringRadius, Math.PI * 0.25, Math.PI * 1.2);
  context.stroke();

  context.strokeStyle = "#0f8a84";
  context.beginPath();
  context.arc(center, center, ringRadius, Math.PI * 1.28, Math.PI * 2.08);
  context.stroke();

  const arrowAngle = Math.PI * 2.08;
  const arrowX = center + Math.cos(arrowAngle) * ringRadius;
  const arrowY = center + Math.sin(arrowAngle) * ringRadius;
  context.fillStyle = "#0f8a84";
  context.beginPath();
  context.moveTo(arrowX, arrowY);
  context.lineTo(arrowX - arrowSize, arrowY - arrowSize * 0.2);
  context.lineTo(arrowX - arrowSize * 0.25, arrowY + arrowSize);
  context.closePath();
  context.fill();

  context.fillStyle = "#fbf9f3";
  context.beginPath();
  context.arc(center, center, Math.max(1.4, size * 0.09), 0, Math.PI * 2);
  context.fill();

  return context.getImageData(0, 0, size, size);
}

function getSyncActionIcon(size: number): ImageData {
  const existing = syncIconImageData.get(size);
  if (existing) {
    return existing;
  }
  const created = createSyncActionIcon(size);
  syncIconImageData.set(size, created);
  return created;
}

async function syncActionIcon(status: SyncStatus): Promise<void> {
  if (status.historySyncInProgress) {
    if (actionIconMode === "syncing") {
      return;
    }
    const imageData = Object.fromEntries(
      ACTION_ICON_SIZES.map((size) => [size, getSyncActionIcon(size)])
    ) as Record<number, ImageData>;
    await chrome.action.setIcon({ imageData });
    actionIconMode = "syncing";
    return;
  }

  if (actionIconMode === "default") {
    return;
  }
  await chrome.action.setIcon({ path: ACTION_ICON_PATHS });
  actionIconMode = "default";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

async function syncActionBadge(status: SyncStatus): Promise<void> {
  await syncActionIcon(status);

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
      title: `SaveMyContext: History sync running for ${formatProviderList(
        status.historySyncActiveProviders,
        status.historySyncProvider
      )}.`
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

async function getActiveHistorySyncProviders(
  overrides: Partial<Record<ProviderName, boolean>> = {}
): Promise<ProviderName[]> {
  const states = await Promise.all(
    HISTORY_SYNC_PROVIDERS.map(async (provider) => {
      const inProgress = overrides[provider] ?? (await getProviderHistorySyncState(provider)).inProgress ?? false;
      return [provider, inProgress] as const;
    })
  );
  return states.filter(([, inProgress]) => inProgress).map(([provider]) => provider);
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

async function findProviderRefreshTab(provider: ProviderName): Promise<number | null> {
  const tabs = await chrome.tabs.query({});
  const matchingTabs = tabs.filter((tab) => typeof tab.id === "number" && tabMatchesProviderUrl(tab.url, provider));
  return matchingTabs.find((tab) => !tab.active)?.id ?? matchingTabs[0]?.id ?? null;
}

async function reloadTabAndWaitForComplete(tabId: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      chrome.tabs.onUpdated.removeListener(listener);
      globalThis.clearTimeout(timeout);
    };
    const finish = (error?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };
    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };
    const timeout = globalThis.setTimeout(() => {
      finish(new Error("Timed out waiting for the provider refresh tab to load."));
    }, PROVIDER_REFRESH_TAB_LOAD_TIMEOUT_MS);

    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.reload(tabId).catch(finish);
  });
}

async function ensureProviderRefreshTab(provider: ProviderName): Promise<chrome.tabs.Tab & { id: number }> {
  const existingTabId = await findProviderRefreshTab(provider);
  if (typeof existingTabId === "number") {
    await reloadTabAndWaitForComplete(existingTabId);
    const tab = await chrome.tabs.get(existingTabId);
    if (typeof tab.id === "number") {
      return tab as chrome.tabs.Tab & { id: number };
    }
  }

  const tab = await chrome.tabs.create({
    url: PROVIDER_START_URLS[provider],
    active: false
  });
  if (typeof tab.id !== "number") {
    throw new Error(`Could not open a ${provider} refresh tab.`);
  }
  await waitForTabComplete(tab.id);
  return (await chrome.tabs.get(tab.id)) as chrome.tabs.Tab & { id: number };
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

async function handleKnowledgeSearch(payload: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse> {
  const queries = normalizeKnowledgeSearchQueries(payload);
  const queryLabel = queries.join(" | ");
  if (!queries.length) {
    return {
      ok: true,
      query: queryLabel,
      count: 0,
      results: []
    };
  }

  const settings = await getSettings();
  const status = await refreshBackendStatus(false);
  if (status.backendValidationError) {
    return {
      ok: false,
      query: queryLabel,
      count: 0,
      results: [],
      error: status.backendValidationError
    };
  }

  try {
    const perQueryLimit = queries.length > 1 ? Math.min(Math.max(payload.limit ?? 8, 6), 10) : payload.limit ?? 8;
    const responses = await Promise.all(
      queries.map((query) =>
        fetchKnowledgeSearch(
          {
            ...settings,
            backendUrl: status.backendUrl ?? settings.backendUrl
          },
          query,
          perQueryLimit,
          {
            provider: payload.provider,
            kinds: payload.kinds
          }
        )
      )
    );
    const results = mergeSearchResults(responses.flatMap((response) => response.results)).slice(0, payload.limit ?? 8);
    return {
      ok: true,
      query: queryLabel,
      count: results.length,
      results
    };
  } catch (error) {
    return {
      ok: false,
      query: queryLabel,
      count: 0,
      results: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function handleGetActiveChatContext(
  sender: chrome.runtime.MessageSender,
  payload?: { pageUrl?: string }
): ActiveChatContextResponse {
  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") {
    return {
      ok: true
    };
  }

  const snapshot = activeChatContextsByTabId.get(tabId);
  if (!snapshot) {
    return {
      ok: true
    };
  }

  const expectedProvider = detectProviderFromUrl(payload?.pageUrl ?? sender.tab?.url ?? "");
  if (expectedProvider && expectedProvider !== snapshot.provider) {
    return {
      ok: true
    };
  }

  return {
    ok: true,
    snapshot
  };
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

async function handleSaveCurrentPageSource(saveMode: "raw" | "ai" = "raw"): Promise<SourceCaptureResponse> {
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
        backendMarkdownRoot: capabilities.storage.markdown_root ?? undefined,
        backendVaultRoot: capabilities.storage.vault_root ?? undefined,
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

async function syncProviderRefreshAlarms(settings?: ExtensionSettings): Promise<void> {
  const resolvedSettings = settings ?? (await getSettings());
  const plan = buildProviderRefreshAlarmPlan(resolvedSettings);
  const plannedNames = new Set(plan.map((item) => item.alarmName));

  await Promise.all(
    (["chatgpt", "gemini", "grok"] as ProviderName[]).map(async (provider) => {
      const alarmName = providerRefreshAlarmName(provider);
      if (!plannedNames.has(alarmName)) {
        await chrome.alarms.clear(alarmName);
      }
    })
  );

  await Promise.all(
    plan.map(async (item) => {
      await chrome.alarms.create(item.alarmName, {
        delayInMinutes: item.delayInMinutes,
        periodInMinutes: item.periodInMinutes
      });
    })
  );
}

async function handleScheduledProviderRefresh(provider: ProviderName): Promise<void> {
  if (scheduledProviderRefreshesInFlight.has(provider)) {
    return;
  }

  scheduledProviderRefreshesInFlight.add(provider);
  try {
    const settings = await getSettings();
    if (!buildProviderRefreshAlarmPlan(settings).some((item) => item.provider === provider)) {
      await chrome.alarms.clear(providerRefreshAlarmName(provider));
      return;
    }

    if (isFreshHistorySyncInProgress(await getProviderHistorySyncState(provider))) {
      return;
    }

    const tab = await ensureProviderRefreshTab(provider);
    await handlePageVisit(
      {
        provider,
        pageUrl: tab.url ?? PROVIDER_START_URLS[provider]
      },
      tab.id
    );
  } catch (error) {
    console.warn(`SaveMyContext scheduled ${provider} refresh failed`, error);
  } finally {
    scheduledProviderRefreshesInFlight.delete(provider);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void initializeStorage().then(async () => {
    await syncProviderRefreshAlarms();
    await refreshBackendStatus(true);
  });
});

chrome.runtime.onStartup.addListener(() => {
  void initializeStorage().then(async () => {
    await syncProviderRefreshAlarms();
    await refreshBackendStatus(true);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearActiveChatContext(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || typeof changeInfo.url === "string") {
    clearActiveChatContext(tabId);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  const provider = providerFromRefreshAlarmName(alarm.name);
  if (!provider) {
    return;
  }
  void handleScheduledProviderRefresh(provider);
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

  if (message.type === "SAVE_CONNECTION_BUNDLE") {
    void enqueueTask(() => handleSaveConnectionBundle(message.payload))
      .then(sendResponse)
      .catch((error) => {
        console.error("SaveMyContext connection enrollment failed", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies SaveConnectionBundleResponse);
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
    void enqueueTask(() => handleSaveCurrentPageSource(message.payload?.saveMode ?? "raw"))
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

  if (message.type === "GET_ACTIVE_CHAT_CONTEXT") {
    sendResponse(handleGetActiveChatContext(_sender, message.payload));
    return false;
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
      indexingRuleDecision?: "indexed" | "skipped" | "discarded";
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
  clearActiveChatContext(tabId);
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
    const activeProviders = await getActiveHistorySyncProviders({ [payload.provider]: false });
    await setExtensionStatus({
      autoSyncHistory: settings.autoSyncHistory,
      historySyncInProgress: activeProviders.length > 0,
      historySyncActiveProviders: activeProviders,
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
  if (isFreshHistorySyncInProgress(currentState)) {
    return { triggered: false, reason: "already-in-progress" };
  }

  const activeWatermarks = activeHistoryWatermarks(payload.provider, currentState, backendStatus.providerDriftAlert);
  const hasExistingHistoryWatermark = Boolean(activeWatermarks?.length);
  const syncedSessionIds = hasExistingHistoryWatermark
    ? undefined
    : extractExternalSessionIds(payload.provider, await getProviderSessionSyncStates(payload.provider), settings);
  const previousTopSessionIds = activeWatermarks;
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
  const activeProviders = await getActiveHistorySyncProviders({ [payload.provider]: true });
  await setExtensionStatus({
    autoSyncHistory: settings.autoSyncHistory,
    historySyncInProgress: activeProviders.length > 0,
    historySyncActiveProviders: activeProviders,
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
        previousTopSessionId: previousTopSessionIds?.[0],
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
    const activeProviders = await getActiveHistorySyncProviders({ [payload.provider]: false });
    await setExtensionStatus({
      historySyncInProgress: activeProviders.length > 0,
      historySyncActiveProviders: activeProviders,
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
    const activeProviders = await getActiveHistorySyncProviders({ [update.provider]: true });
    await setExtensionStatus({
      historySyncInProgress: activeProviders.length > 0,
      historySyncActiveProviders: activeProviders,
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
      const activeProviders = await getActiveHistorySyncProviders({ [update.provider]: false });
      await setExtensionStatus({
        historySyncInProgress: activeProviders.length > 0,
        historySyncActiveProviders: activeProviders,
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
      ...(shouldCommitHistoryWatermark(update, runError) ? watermarkPatch : {}),
      inProgress: false,
      lastCompletedAt: completedAt,
      lastConversationCount: update.conversationCount ?? currentState.lastConversationCount,
      processedCount,
      totalCount,
      skippedCount,
      lastDriftAlert: providerStateDriftAlert
    });
    const activeProviders = await getActiveHistorySyncProviders({ [update.provider]: false });
    await setExtensionStatus({
      historySyncInProgress: activeProviders.length > 0,
      historySyncActiveProviders: activeProviders,
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
    const activeProviders = await getActiveHistorySyncProviders({ [update.provider]: false });
    await setExtensionStatus({
      historySyncInProgress: activeProviders.length > 0,
      historySyncActiveProviders: activeProviders,
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
  const activeProviders = await getActiveHistorySyncProviders({ [update.provider]: false });
  await setExtensionStatus({
    historySyncInProgress: activeProviders.length > 0,
    historySyncActiveProviders: activeProviders,
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
  if (typeof tabId === "number") {
    rememberActiveChatContext(tabId, snapshot, event.pageUrl);
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

  const discardDecision = evaluateDiscardWords(settings, snapshot);
  if (discardDecision.matched) {
    payload.route_to_discard = true;
    payload.discard_word_match = discardDecision.matchedWord;
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

  const finalDecision: "indexed" | "discarded" = discardDecision.matched ? "discarded" : "indexed";
  const finalReason = discardDecision.matched ? discardDecision.reason : indexingDecision.reason;
  await saveSessionSyncState(sessionKey, {
    seenMessageIds: mergeSeenMessageIds(syncState.seenMessageIds, snapshot.messages),
    lastSyncedAt: new Date().toISOString(),
    indexingRuleDecision: finalDecision,
    indexingRuleFingerprint: indexingFingerprint,
    indexingRuleReason: finalReason,
    discardWordMatch: discardDecision.matchedWord
  });
  await setExtensionStatus({
    backendUrl,
    lastError: null,
    lastProvider: snapshot.provider,
    lastSessionKey: sessionKey,
    lastSuccessAt: new Date().toISOString(),
    lastSyncedMessageCount: payload.messages.length,
    autoSyncHistory: settings.autoSyncHistory,
    lastIndexingDecision: finalDecision,
    lastIndexingReason: finalReason
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
    await syncProviderRefreshAlarms(saved);
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
      backendMarkdownRoot: capabilities.storage.markdown_root ?? undefined,
      backendVaultRoot: capabilities.storage.vault_root ?? undefined,
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

async function handleSaveConnectionBundle(payload: {
  connectionString: string;
  verificationCode?: string;
  settings: Partial<ExtensionSettings>;
}): Promise<SaveConnectionBundleResponse> {
  const bundle = parseConnectionString(payload.connectionString);
  const redeemed = await redeemConnectionBundle(bundle, {
    installationId: await getInstallationId(),
    clientName: await extensionClientName(),
    verificationCode: payload.verificationCode
  });
  const response = await handleSaveSettings({
    ...payload.settings,
    backendUrl: bundle.baseUrl,
    backendToken: redeemed.token
  });
  return {
    ...response,
    redeemed
  };
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
