import { buildBackendHeaders, validateBackendConfiguration } from "./backend";
import { buildIngestPayload, mergeSeenMessageIds } from "./diff";
import { providerRegistry } from "../providers/registry";
import { supportsProactiveHistorySync } from "../shared/provider";
import {
  getProviderHistorySyncState,
  getProviderSessionSyncStates,
  getSessionSyncState,
  getSettings,
  getStatus,
  initializeStorage,
  saveBackendValidation,
  saveProviderHistorySyncState,
  saveSessionSyncState,
  saveSettings,
  setStatus
} from "../shared/storage";
import type {
  CapturedNetworkEvent,
  ExtensionSettings,
  HistorySyncUpdate,
  ProviderDriftAlert,
  ProviderName,
  RuntimeMessage,
  SaveSettingsResponse,
  SyncStatus
} from "../shared/types";

let queue = Promise.resolve();
const HISTORY_SYNC_STALE_AFTER_MS = 15 * 60 * 1000;
const historySyncRunErrors = new Map<string, string>();

async function syncActionBadge(status: SyncStatus): Promise<void> {
  if (status.providerDriftAlert) {
    await chrome.action.setBadgeBackgroundColor({ color: "#BD5D38" });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setTitle({
      title: `TSMC: Provider drift suspected for ${status.providerDriftAlert.provider}. Open the extension for details.`
    });
    return;
  }

  if (status.historySyncInProgress) {
    await chrome.action.setBadgeBackgroundColor({ color: "#0B8C88" });
    await chrome.action.setBadgeText({ text: "…" });
    await chrome.action.setTitle({
      title: `TSMC: History sync running for ${status.historySyncProvider ?? "provider"}.`
    });
    return;
  }

  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: "TSMC" });
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

chrome.runtime.onInstalled.addListener(() => {
  void initializeStorage().then(() => getStatus().then(syncActionBadge));
});

chrome.runtime.onStartup.addListener(() => {
  void initializeStorage().then(() => getStatus().then(syncActionBadge));
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type === "NETWORK_CAPTURE") {
    void enqueueTask(() => handleCapture(message.payload))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("TSMC capture failed", error);
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
        console.error("TSMC history sync status update failed", error);
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
        console.error("TSMC settings save failed", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies SaveSettingsResponse);
      });
    return true;
  }

  if (message.type === "GET_STATUS") {
    void getStatus().then(sendResponse);
    return true;
  }

  return false;
});

function findMatchingProvider(event: CapturedNetworkEvent) {
  for (const provider of providerRegistry) {
    try {
      if (provider.matches(event)) {
        return provider;
      }
    } catch (error) {
      console.warn(`TSMC provider matcher failed for ${provider.provider}`, error);
    }
  }

  return null;
}

function extractExternalSessionIds(
  provider: ProviderName,
  sessionStates: Record<string, { seenMessageIds: string[]; lastSyncedAt?: string }>
): string[] {
  const prefix = `${provider}:`;
  return Object.keys(sessionStates)
    .filter((sessionKey) => sessionKey.startsWith(prefix))
    .map((sessionKey) => sessionKey.slice(prefix.length))
    .filter(Boolean);
}

async function handlePageVisit(
  payload: { provider: ProviderName; pageUrl: string },
  tabId: number | undefined
): Promise<{ triggered: boolean; reason?: string }> {
  const settings = await getSettings();
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
    : extractExternalSessionIds(payload.provider, await getProviderSessionSyncStates(payload.provider));
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
  const patch = {
    ...currentState,
    lastPageUrl: update.pageUrl,
    lastTopSessionId: update.topSessionId ?? update.topSessionIds?.[0] ?? currentState.lastTopSessionId,
    lastTopSessionIds: nextTopSessionIds,
    lastDriftAlert: update.providerDriftAlert ?? currentState.lastDriftAlert
  };

  if (update.phase === "started") {
    const startedAt = currentState.lastStartedAt ?? new Date().toISOString();
    await saveProviderHistorySyncState(update.provider, {
      ...patch,
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
        ...patch,
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
      ...patch,
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
      ...patch,
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
    ...patch,
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

async function handleCapture(event: CapturedNetworkEvent): Promise<void> {
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
    throw new Error(`TSMC sync failed: ${response.status}`);
  }

  await saveSessionSyncState(sessionKey, {
    seenMessageIds: mergeSeenMessageIds(syncState.seenMessageIds, snapshot.messages),
    lastSyncedAt: new Date().toISOString()
  });
  await setExtensionStatus({
    backendUrl,
    lastError: null,
    lastProvider: snapshot.provider,
    lastSessionKey: sessionKey,
    lastSuccessAt: new Date().toISOString(),
    lastSyncedMessageCount: payload.messages.length,
    autoSyncHistory: settings.autoSyncHistory
  });
}

async function handleSaveSettings(update: Partial<ExtensionSettings>): Promise<SaveSettingsResponse> {
  const candidateSettings: ExtensionSettings = {
    ...(await getSettings()),
    ...update
  };

  try {
    const { normalizedUrl, capabilities } = await validateBackendConfiguration(candidateSettings);
    const saved = await saveSettings({
      ...update,
      backendUrl: normalizedUrl
    });
    await saveBackendValidation(capabilities, null);
    await setExtensionStatus({
      backendUrl: normalizedUrl,
      autoSyncHistory: saved.autoSyncHistory,
      backendValidatedAt: new Date().toISOString(),
      backendProduct: capabilities.product,
      backendVersion: capabilities.version,
      backendAuthMode: capabilities.auth.mode,
      backendValidationError: null,
      backendVaultRoot: capabilities.storage.vault_root
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
      backendValidationError: message
    });
    return {
      ok: false,
      error: message
    };
  }
}
