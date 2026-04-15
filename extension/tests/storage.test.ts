import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StorageState = Record<string, unknown>;

function createStorageArea(initial: StorageState = {}) {
  const state: StorageState = { ...initial };

  return {
    state,
    get: vi.fn(async (keys?: string | string[] | Record<string, unknown>) => {
      if (typeof keys === "string") {
        return { [keys]: state[keys] };
      }

      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, state[key]]));
      }

      if (keys && typeof keys === "object") {
        return Object.fromEntries(Object.keys(keys).map((key) => [key, state[key] ?? keys[key]]));
      }

      return { ...state };
    }),
    set: vi.fn(async (items: StorageState) => {
      Object.assign(state, items);
    })
  };
}

describe("storage", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not write to chrome.storage.sync when reading settings", async () => {
    const sync = createStorageArea();
    const local = createStorageArea({
      "tsmc.settings.secrets": {
        backendToken: "secret-token"
      }
    });
    vi.stubGlobal("chrome", {
      storage: {
        sync,
        local
      }
    });

    const { defaultSettings, getSettings } = await import("../src/shared/storage");
    const settings = await getSettings();

    expect(settings).toEqual({
      ...defaultSettings,
      backendToken: "secret-token"
    });
    expect(sync.get).toHaveBeenCalledOnce();
    expect(sync.set).not.toHaveBeenCalled();
  });

  it("prefers the local settings cache for live reads when sync is stale", async () => {
    const sync = createStorageArea({
      "tsmc.settings": {
        backendUrl: "http://127.0.0.1:18888",
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
      }
    });
    const local = createStorageArea({
      "tsmc.settings.cache": {
        backendUrl: "http://127.0.0.1:9999",
        enabledProviders: {
          chatgpt: true,
          gemini: true,
          grok: true
        },
        autoSyncHistory: false,
        indexingMode: "trigger_word",
        triggerWords: ["lorem", "alpha"],
        blacklistWords: ["ignore"],
        selectionCaptureEnabled: true
      },
      "tsmc.settings.secrets": {
        backendToken: "secret-token"
      }
    });
    vi.stubGlobal("chrome", {
      storage: {
        sync,
        local
      }
    });

    const { getSettings } = await import("../src/shared/storage");
    const settings = await getSettings();

    expect(settings.backendUrl).toBe("http://127.0.0.1:9999");
    expect(settings.autoSyncHistory).toBe(false);
    expect(settings.backendToken).toBe("secret-token");
    expect(settings.indexingMode).toBe("trigger_word");
    expect(settings.triggerWords).toEqual(["lorem", "alpha"]);
    expect(settings.blacklistWords).toEqual(["ignore"]);
  });

  it("persists merged defaults once during initialization when settings are incomplete", async () => {
    const sync = createStorageArea({
      "tsmc.settings": {
        backendUrl: "http://127.0.0.1:9000"
      }
    });
    const local = createStorageArea();
    vi.stubGlobal("chrome", {
      storage: {
        sync,
        local
      }
    });

    const { initializeStorage } = await import("../src/shared/storage");
    await initializeStorage();

    expect(sync.set).toHaveBeenCalledTimes(1);
    expect(sync.set).toHaveBeenCalledWith({
      "tsmc.settings": {
        backendUrl: "http://127.0.0.1:9000",
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
      }
    });
    expect(local.set).toHaveBeenCalledWith({
      "tsmc.settings.cache": {
        backendUrl: "http://127.0.0.1:9000",
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
      }
    });
  });
});
