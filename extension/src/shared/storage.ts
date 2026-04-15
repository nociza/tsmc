import type {
  BackendCapabilities,
  ProviderName,
  ExtensionSettings,
  ProviderHistorySyncState,
  SessionSyncState,
  SyncStatus
} from "./types";

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
  indexingMode: "all",
  triggerWords: ["lorem"],
  blacklistWords: [],
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
    indexingMode: current.indexingMode ?? defaultSettings.indexingMode,
    triggerWords: current.triggerWords ?? defaultSettings.triggerWords,
    blacklistWords: current.blacklistWords ?? defaultSettings.blacklistWords,
    selectionCaptureEnabled: current.selectionCaptureEnabled ?? defaultSettings.selectionCaptureEnabled
  };
}

function shouldPersistSettings(current: Partial<ExtensionSettings>): boolean {
  if (
    !current.backendUrl ||
    current.autoSyncHistory === undefined ||
    !current.enabledProviders ||
    !current.indexingMode ||
    !current.triggerWords ||
    !current.blacklistWords ||
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
    indexingMode: settings.indexingMode ?? defaultSettings.indexingMode,
    triggerWords: settings.triggerWords ?? defaultSettings.triggerWords,
    blacklistWords: settings.blacklistWords ?? defaultSettings.blacklistWords,
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
    indexingMode: update.indexingMode ?? current.indexingMode,
    triggerWords: update.triggerWords ?? current.triggerWords,
    blacklistWords: update.blacklistWords ?? current.blacklistWords,
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
