import type {
  BackendCapabilities,
  ExtensionSettings,
  ProviderHistorySyncState,
  ProviderName,
  SessionSyncState,
  SyncStatus
} from "./types";

const SETTINGS_KEY = "tsmc.settings";
const SECRET_SETTINGS_KEY = "tsmc.settings.secrets";
const SYNC_STATE_KEY = "tsmc.sync-state";
const STATUS_KEY = "tsmc.status";
const HISTORY_SYNC_KEY = "tsmc.history-sync";

export const defaultSettings: ExtensionSettings = {
  backendUrl: "http://127.0.0.1:8000",
  backendToken: "",
  enabledProviders: {
    chatgpt: true,
    gemini: true,
    grok: true
  },
  autoSyncHistory: true
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
    autoSyncHistory: current.autoSyncHistory ?? defaultSettings.autoSyncHistory
  };
}

function shouldPersistSettings(current: Partial<ExtensionSettings>): boolean {
  if (!current.backendUrl || current.autoSyncHistory === undefined || !current.enabledProviders) {
    return true;
  }

  return (Object.keys(defaultSettings.enabledProviders) as ProviderName[]).some(
    (provider) => current.enabledProviders?.[provider] === undefined
  );
}

export async function initializeStorage(): Promise<void> {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  const current = (stored[SETTINGS_KEY] ?? {}) as Partial<ExtensionSettings>;
  if (shouldPersistSettings(current)) {
    await chrome.storage.sync.set({
      [SETTINGS_KEY]: {
        backendUrl: current.backendUrl ?? defaultSettings.backendUrl,
        enabledProviders: {
          ...defaultSettings.enabledProviders,
          ...(current.enabledProviders ?? {})
        },
        autoSyncHistory: current.autoSyncHistory ?? defaultSettings.autoSyncHistory
      }
    });
  }
  await getSettings();
  await getStatus();
}

export async function getSettings(): Promise<ExtensionSettings> {
  const [stored, secrets] = await Promise.all([
    chrome.storage.sync.get(SETTINGS_KEY),
    chrome.storage.local.get(SECRET_SETTINGS_KEY)
  ]);
  const current = (stored[SETTINGS_KEY] ?? {}) as Partial<ExtensionSettings>;
  const secretSettings = (secrets[SECRET_SETTINGS_KEY] ?? {}) as Pick<ExtensionSettings, "backendToken">;
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
    autoSyncHistory: update.autoSyncHistory ?? current.autoSyncHistory
  };
  await chrome.storage.sync.set({
    [SETTINGS_KEY]: {
      backendUrl: next.backendUrl,
      enabledProviders: next.enabledProviders,
      autoSyncHistory: next.autoSyncHistory
    }
  });
  await chrome.storage.local.set({
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
