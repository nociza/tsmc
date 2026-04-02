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
    const local = createStorageArea();
    vi.stubGlobal("chrome", {
      storage: {
        sync,
        local
      }
    });

    const { defaultSettings, getSettings } = await import("../src/shared/storage");
    const settings = await getSettings();

    expect(settings).toEqual(defaultSettings);
    expect(sync.get).toHaveBeenCalledOnce();
    expect(sync.set).not.toHaveBeenCalled();
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
        autoSyncHistory: true
      }
    });
  });
});
