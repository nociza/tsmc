import { useCallback, useEffect, useMemo, useState } from "react";

import type { ExtensionSettings, RuntimeMessage, SyncStatus } from "../../shared/types";

export async function sendRuntimeMessage<TResponse>(message: RuntimeMessage): Promise<TResponse> {
  return chrome.runtime.sendMessage(message) as Promise<TResponse>;
}

async function loadRuntimeSnapshot(): Promise<{
  settings: ExtensionSettings;
  status: SyncStatus;
}> {
  const [settings, status] = await Promise.all([
    sendRuntimeMessage<ExtensionSettings>({ type: "GET_SETTINGS" }),
    sendRuntimeMessage<SyncStatus>({ type: "GET_STATUS" })
  ]);

  return { settings, status };
}

export function useExtensionBootstrap(): {
  settings: ExtensionSettings | null;
  status: SyncStatus | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
} {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSnapshot = useCallback(async (quiet = false) => {
    if (!quiet) {
      setLoading(true);
    }
    setError(null);
    try {
      const snapshot = await loadRuntimeSnapshot();
      setSettings(snapshot.settings);
      setStatus(snapshot.status);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load extension state.");
    } finally {
      if (!quiet) {
        setLoading(false);
      }
    }
  }, []);

  const reload = useCallback(async () => {
    await loadSnapshot(false);
  }, [loadSnapshot]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!status?.historySyncInProgress && !status?.processingInProgress) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void loadSnapshot(true);
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [loadSnapshot, status?.historySyncInProgress, status?.processingInProgress]);

  useEffect(() => {
    function handleStorageChange(changes: Record<string, chrome.storage.StorageChange>, areaName: string): void {
      if (areaName !== "local" && areaName !== "sync") {
        return;
      }

      if (changes["savemycontext.status"]?.newValue) {
        setStatus(changes["savemycontext.status"].newValue as SyncStatus);
      }

      if (
        changes["savemycontext.settings"] ||
        changes["savemycontext.settings.cache"] ||
        changes["savemycontext.settings.secrets"]
      ) {
        void reload();
      }
    }

    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange);
    };
  }, [reload]);

  return {
    settings,
    status,
    loading,
    error,
    reload
  };
}

export function useDebouncedValue<TValue>(value: TValue, delayMs = 220): TValue {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebounced(value);
    }, delayMs);

    return () => {
      window.clearTimeout(id);
    };
  }, [value, delayMs]);

  return debounced;
}

export function useSearchParamsState(): URLSearchParams {
  const [search, setSearch] = useState(() => window.location.search);

  useEffect(() => {
    const onPopState = (): void => {
      setSearch(window.location.search);
    };

    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  return useMemo(() => new URLSearchParams(search), [search]);
}
