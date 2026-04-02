import type { CapturedNetworkEvent, HistorySyncTriggerPayload, HistorySyncUpdate, RuntimeMessage } from "../shared/types";

const CONTROL_SOURCE = "tsmc-history-control";
const CONTROL_READY_SOURCE = "tsmc-history-control-ready";
const MAIN_WORLD_READY_ATTRIBUTE = "data-tsmc-main-world-ready";

let injectedReady = false;
let pendingHistorySyncPayload: HistorySyncControlPayload | null = null;

type HistorySyncControlPayload = {
  type: "START_HISTORY_SYNC";
  syncedSessionIds?: string[];
  previousTopSessionId?: string;
  refreshSessionIds?: string[];
};

function detectProviderFromUrl(url: string): "chatgpt" | "gemini" | "grok" | null {
  try {
    const hostname = new URL(url).hostname;
    if (/chatgpt\.com|chat\.openai\.com/.test(hostname)) {
      return "chatgpt";
    }
    if (/gemini\.google\.com/.test(hostname)) {
      return "gemini";
    }
    if (/grok\.com|x\.com/.test(hostname)) {
      return "grok";
    }
  } catch {
    return null;
  }
  return null;
}

function isMainWorldReady(): boolean {
  return document.documentElement?.getAttribute(MAIN_WORLD_READY_ATTRIBUTE) === "1";
}

window.addEventListener(
  "message",
  (event: MessageEvent<{ source?: string; payload?: CapturedNetworkEvent | HistorySyncUpdate }>) => {
    if (event.source !== window) {
      return;
    }

    if (event.data?.source === CONTROL_READY_SOURCE) {
      injectedReady = true;
      if (pendingHistorySyncPayload) {
        const payload = pendingHistorySyncPayload;
        pendingHistorySyncPayload = null;
        postControlMessage(payload);
      }
      return;
    }

    if (!event.data?.payload) {
      return;
    }

    if (event.data.source === "tsmc-network-observer") {
      const message: RuntimeMessage = {
        type: "NETWORK_CAPTURE",
        payload: event.data.payload as CapturedNetworkEvent
      };
      void chrome.runtime.sendMessage(message).catch(() => undefined);
    }

    if (event.data.source === "tsmc-history-sync") {
      const message: RuntimeMessage = {
        type: "HISTORY_SYNC_STATUS",
        payload: event.data.payload as HistorySyncUpdate
      };
      void chrome.runtime.sendMessage(message).catch(() => undefined);
    }
  }
);

function postControlMessage(payload: HistorySyncControlPayload): void {
  injectedReady ||= isMainWorldReady();
  if (!injectedReady) {
    pendingHistorySyncPayload = payload;
    return;
  }

  window.postMessage(
    {
      source: CONTROL_SOURCE,
      payload
    },
    window.location.origin
  );
}

function notifyPageVisit(): void {
  const provider = detectProviderFromUrl(window.location.href);
  if (!provider) {
    return;
  }

  const message: RuntimeMessage = {
    type: "PAGE_VISIT",
    payload: {
      provider,
      pageUrl: window.location.href
    }
  };
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

function installNavigationObserver(): void {
  let lastUrl = window.location.href;
  const notifyIfChanged = (): void => {
    if (window.location.href === lastUrl) {
      return;
    }
    lastUrl = window.location.href;
    notifyPageVisit();
  };

  const nativePushState = history.pushState;
  history.pushState = function patchedPushState(...args) {
    nativePushState.apply(this, args);
    notifyIfChanged();
  };

  const nativeReplaceState = history.replaceState;
  history.replaceState = function patchedReplaceState(...args) {
    nativeReplaceState.apply(this, args);
    notifyIfChanged();
  };

  window.addEventListener("popstate", notifyIfChanged);
  window.addEventListener("hashchange", notifyIfChanged);
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type === "TRIGGER_HISTORY_SYNC") {
    const payload: HistorySyncTriggerPayload = message.payload;
    postControlMessage({
      type: "START_HISTORY_SYNC",
      syncedSessionIds: payload.syncedSessionIds,
      previousTopSessionId: payload.previousTopSessionId,
      refreshSessionIds: payload.refreshSessionIds
    });
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

injectedReady = isMainWorldReady();
installNavigationObserver();
notifyPageVisit();
