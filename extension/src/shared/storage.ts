import type {
  BackendCapabilities,
  ProviderName,
  ExtensionSettings,
  ProviderHistorySyncState,
  SessionSyncState,
  SyncStatus
} from "./types";
import {
  normalizeProviderRefreshIntervalMinutes,
  PROVIDER_REFRESH_DEFAULT_INTERVAL_MINUTES
} from "./provider-refresh";

const SETTINGS_KEY = "savemycontext.settings";
const SECRET_SETTINGS_KEY = "savemycontext.settings.secrets";
const SETTINGS_CACHE_KEY = "savemycontext.settings.cache";
const SYNC_STATE_KEY = "savemycontext.sync-state";
const STATUS_KEY = "savemycontext.status";
const HISTORY_SYNC_KEY = "savemycontext.history-sync";
const PROCESSING_WORKER_KEY = "savemycontext.processing-worker";

export const defaultSettings: ExtensionSettings = {
  backendUrl: "http://127.0.0.1:18888",
  backendToken: "",
  enabledProviders: {
    chatgpt: true,
    gemini: true,
    grok: true
  },
  autoSyncHistory: true,
  scheduledProviderRefreshEnabled: false,
  scheduledProviderRefreshIntervalMinutes: PROVIDER_REFRESH_DEFAULT_INTERVAL_MINUTES,
  indexingMode: "all",
  triggerWords: ["lorem"],
  blacklistWords: [],
  discardWordsEnabled: true,
  discardWords: ["loom"],
  selectionCaptureEnabled: false
};

function mergeSettings(
  current: Partial<ExtensionSettings>,
  secrets: Pick<ExtensionSettings, "backendToken">
): ExtensionSettings {
  return {
    backendUrl: current.backendUrl ?? defaultSettings.backendUrl,
    backendToken: secrets.backendToken ?? defaultSettings.backendToken,
    enabledProviders: {
      ...defaultSettings.enabledProviders,
      ...(current.enabledProviders ?? {})
    },
    autoSyncHistory: current.autoSyncHistory ?? defaultSettings.autoSyncHistory,
    scheduledProviderRefreshEnabled:
      current.scheduledProviderRefreshEnabled ?? defaultSettings.scheduledProviderRefreshEnabled,
    scheduledProviderRefreshIntervalMinutes: normalizeProviderRefreshIntervalMinutes(
      current.scheduledProviderRefreshIntervalMinutes ?? defaultSettings.scheduledProviderRefreshIntervalMinutes
    ),
    indexingMode: current.indexingMode ?? defaultSettings.indexingMode,
    triggerWords: current.triggerWords ?? defaultSettings.triggerWords,
    blacklistWords: current.blacklistWords ?? defaultSettings.blacklistWords,
    discardWordsEnabled: current.discardWordsEnabled ?? defaultSettings.discardWordsEnabled,
    discardWords: current.discardWords ?? defaultSettings.discardWords,
    selectionCaptureEnabled: current.selectionCaptureEnabled ?? defaultSettings.selectionCaptureEnabled
  };
}

function shouldPersistSettings(current: Partial<ExtensionSettings>): boolean {
  if (
    !current.backendUrl ||
    current.autoSyncHistory === undefined ||
    current.scheduledProviderRefreshEnabled === undefined ||
    current.scheduledProviderRefreshIntervalMinutes === undefined ||
    !current.enabledProviders ||
    !current.indexingMode ||
    !current.triggerWords ||
    !current.blacklistWords ||
    current.discardWordsEnabled === undefined ||
    !current.discardWords ||
    current.selectionCaptureEnabled === undefined
  ) {
    return true;
  }

  return (Object.keys(defaultSettings.enabledProviders) as ProviderName[]).some(
    (provider) => current.enabledProviders?.[provider] === undefined
  );
}

function publicSettings(settings: ExtensionSettings | Partial<ExtensionSettings>) {
  return {
    backendUrl: settings.backendUrl ?? defaultSettings.backendUrl,
    enabledProviders: {
      ...defaultSettings.enabledProviders,
      ...(settings.enabledProviders ?? {})
    },
    autoSyncHistory: settings.autoSyncHistory ?? defaultSettings.autoSyncHistory,
    scheduledProviderRefreshEnabled:
      settings.scheduledProviderRefreshEnabled ?? defaultSettings.scheduledProviderRefreshEnabled,
    scheduledProviderRefreshIntervalMinutes: normalizeProviderRefreshIntervalMinutes(
      settings.scheduledProviderRefreshIntervalMinutes ?? defaultSettings.scheduledProviderRefreshIntervalMinutes
    ),
    indexingMode: settings.indexingMode ?? defaultSettings.indexingMode,
    triggerWords: settings.triggerWords ?? defaultSettings.triggerWords,
    blacklistWords: settings.blacklistWords ?? defaultSettings.blacklistWords,
    discardWordsEnabled: settings.discardWordsEnabled ?? defaultSettings.discardWordsEnabled,
    discardWords: settings.discardWords ?? defaultSettings.discardWords,
    selectionCaptureEnabled: settings.selectionCaptureEnabled ?? defaultSettings.selectionCaptureEnabled
  };
}

export async function initializeStorage(): Promise<void> {
  const [stored, local] = await Promise.all([
    chrome.storage.sync.get(SETTINGS_KEY),
    chrome.storage.local.get(SECRET_SETTINGS_KEY)
  ]);
  const current = (stored[SETTINGS_KEY] ?? {}) as Partial<ExtensionSettings>;
  if (shouldPersistSettings(current)) {
    await chrome.storage.sync.set({
      [SETTINGS_KEY]: publicSettings(current)
    });
  }
  const merged = mergeSettings(
    current,
    (local[SECRET_SETTINGS_KEY] ?? {}) as Pick<ExtensionSettings, "backendToken">
  );
  await chrome.storage.local.set({
    [SETTINGS_CACHE_KEY]: publicSettings(merged)
  });
  await getSettings();
  await getStatus();
}

export async function getSettings(): Promise<ExtensionSettings> {
  const [stored, local] = await Promise.all([
    chrome.storage.sync.get(SETTINGS_KEY),
    chrome.storage.local.get([SECRET_SETTINGS_KEY, SETTINGS_CACHE_KEY])
  ]);
  const current =
    ((local[SETTINGS_CACHE_KEY] ?? stored[SETTINGS_KEY] ?? {}) as Partial<ExtensionSettings>);
  const secretSettings = (local[SECRET_SETTINGS_KEY] ?? {}) as Pick<ExtensionSettings, "backendToken">;
  return mergeSettings(current, secretSettings);
}

export async function saveSettings(update: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const current = await getSettings();
  const next: ExtensionSettings = {
    backendUrl: update.backendUrl ?? current.backendUrl,
    backendToken: update.backendToken ?? current.backendToken,
    enabledProviders: {
      ...current.enabledProviders,
      ...(update.enabledProviders ?? {})
    },
    autoSyncHistory: update.autoSyncHistory ?? current.autoSyncHistory,
    scheduledProviderRefreshEnabled:
      update.scheduledProviderRefreshEnabled ?? current.scheduledProviderRefreshEnabled,
    scheduledProviderRefreshIntervalMinutes: normalizeProviderRefreshIntervalMinutes(
      update.scheduledProviderRefreshIntervalMinutes ?? current.scheduledProviderRefreshIntervalMinutes
    ),
    indexingMode: update.indexingMode ?? current.indexingMode,
    triggerWords: update.triggerWords ?? current.triggerWords,
    blacklistWords: update.blacklistWords ?? current.blacklistWords,
    discardWordsEnabled: update.discardWordsEnabled ?? current.discardWordsEnabled,
    discardWords: update.discardWords ?? current.discardWords,
    selectionCaptureEnabled: update.selectionCaptureEnabled ?? current.selectionCaptureEnabled
  };
  await chrome.storage.sync.set({
    [SETTINGS_KEY]: publicSettings(next)
  });
  await chrome.storage.local.set({
    [SETTINGS_CACHE_KEY]: publicSettings(next),
    [SECRET_SETTINGS_KEY]: {
      backendToken: next.backendToken ?? ""
    }
  });
  await setStatus({
    backendUrl: next.backendUrl,
    autoSyncHistory: next.autoSyncHistory
  });
  return next;
}

export async function getSessionSyncState(sessionKey: string): Promise<SessionSyncState> {
  const allStates = await getAllSessionSyncStates();
  return allStates[sessionKey] ?? { seenMessageIds: [] };
}

export async function getAllSessionSyncStates(): Promise<Record<string, SessionSyncState>> {
  const stored = await chrome.storage.local.get(SYNC_STATE_KEY);
  return (stored[SYNC_STATE_KEY] ?? {}) as Record<string, SessionSyncState>;
}

export async function saveSessionSyncState(sessionKey: string, state: SessionSyncState): Promise<void> {
  const allStates = await getAllSessionSyncStates();
  allStates[sessionKey] = state;
  await chrome.storage.local.set({ [SYNC_STATE_KEY]: allStates });
}

export async function getProviderSessionSyncStates(
  provider: ProviderName
): Promise<Record<string, SessionSyncState>> {
  const prefix = `${provider}:`;
  const allStates = await getAllSessionSyncStates();
  return Object.fromEntries(Object.entries(allStates).filter(([sessionKey]) => sessionKey.startsWith(prefix)));
}

export async function getStatus(): Promise<SyncStatus> {
  const stored = await chrome.storage.local.get(STATUS_KEY);
  const current = (stored[STATUS_KEY] ?? {}) as SyncStatus;
  if (!current.backendUrl || current.autoSyncHistory === undefined) {
    const settings = await getSettings();
    current.backendUrl = settings.backendUrl;
    current.autoSyncHistory = settings.autoSyncHistory;
    await chrome.storage.local.set({ [STATUS_KEY]: current });
  }
  return current;
}

export async function setStatus(update: Partial<SyncStatus>): Promise<SyncStatus> {
  const current = await getStatus();
  const next = {
    ...current,
    ...update
  } satisfies SyncStatus;
  await chrome.storage.local.set({ [STATUS_KEY]: next });
  return next;
}

export async function saveBackendValidation(
  capabilities: BackendCapabilities | null,
  error: string | null
): Promise<SyncStatus> {
  return setStatus({
    backendValidatedAt: capabilities ? new Date().toISOString() : undefined,
    backendProduct: capabilities?.product,
    backendVersion: capabilities?.version,
    backendAuthMode: capabilities?.auth.mode,
    backendMarkdownRoot: capabilities?.storage.markdown_root,
    backendVaultRoot: capabilities?.storage.vault_root,
    backendValidationError: error
  });
}

export async function getProviderHistorySyncState(provider: ProviderName): Promise<ProviderHistorySyncState> {
  const stored = await chrome.storage.local.get(HISTORY_SYNC_KEY);
  const states = (stored[HISTORY_SYNC_KEY] ?? {}) as Record<ProviderName, ProviderHistorySyncState>;
  return states[provider] ?? {};
}

export async function saveProviderHistorySyncState(
  provider: ProviderName,
  state: ProviderHistorySyncState
): Promise<void> {
  const stored = await chrome.storage.local.get(HISTORY_SYNC_KEY);
  const states = (stored[HISTORY_SYNC_KEY] ?? {}) as Record<ProviderName, ProviderHistorySyncState>;
  states[provider] = state;
  await chrome.storage.local.set({ [HISTORY_SYNC_KEY]: states });
}

export async function clearProviderHistorySyncStates(): Promise<void> {
  await chrome.storage.local.set({ [HISTORY_SYNC_KEY]: {} });
}

export async function getProcessingWorkerSessionUrl(provider: ProviderName): Promise<string | undefined> {
  const stored = await chrome.storage.local.get(PROCESSING_WORKER_KEY);
  const state = (stored[PROCESSING_WORKER_KEY] ?? {}) as {
    sessionUrls?: Partial<Record<ProviderName, string>>;
  };
  const value = state.sessionUrls?.[provider]?.trim();
  return value || undefined;
}

export async function saveProcessingWorkerSessionUrl(provider: ProviderName, sessionUrl: string): Promise<void> {
  const stored = await chrome.storage.local.get(PROCESSING_WORKER_KEY);
  const state = (stored[PROCESSING_WORKER_KEY] ?? {}) as {
    sessionUrls?: Partial<Record<ProviderName, string>>;
  };
  await chrome.storage.local.set({
    [PROCESSING_WORKER_KEY]: {
      sessionUrls: {
        ...(state.sessionUrls ?? {}),
        [provider]: sessionUrl
      }
    }
  });
}
