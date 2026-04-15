import type {
  CapturedNetworkEvent,
  HistorySyncTriggerPayload,
  HistorySyncUpdate,
  PingProviderTabResponse,
  RunProviderPromptResponse,
  RuntimeMessage
} from "../shared/types";
import { createQuickSearchPalette } from "./quick-search";
import { createSelectionCaptureController } from "./selection-capture";

const CONTROL_SOURCE = "tsmc-history-control";
const CONTROL_READY_SOURCE = "tsmc-history-control-ready";
const PROXY_RESULT_SOURCE = "tsmc-proxy-result";
const MAIN_WORLD_READY_ATTRIBUTE = "data-tsmc-main-world-ready";

let injectedReady = false;
let pendingControlPayload: MainWorldControlPayload | null = null;
let proxyPromptInProgress = false;
let runtimeDispatchQueue = Promise.resolve();
const quickSearchPalette = createQuickSearchPalette(async <TResponse>(message: RuntimeMessage) => {
  return chrome.runtime.sendMessage(message) as Promise<TResponse>;
});
const selectionCaptureController = createSelectionCaptureController(async <TResponse>(message: RuntimeMessage) => {
  return chrome.runtime.sendMessage(message) as Promise<TResponse>;
});
const pendingProxyRequests = new Map<
  string,
  {
    resolve: (value: ProxyPromptResult) => void;
    reject: (reason?: unknown) => void;
  }
>();

type HistorySyncControlPayload = {
  type: "START_HISTORY_SYNC";
  syncedSessionIds?: string[];
  previousTopSessionId?: string;
  previousTopSessionIds?: string[];
  refreshSessionIds?: string[];
};
type ProxyPromptControlPayload = {
  type: "RUN_PROXY_PROMPT";
  requestId: string;
  promptText: string;
  preferFastMode?: boolean;
  requireCompleteJson?: boolean;
};
type MainWorldControlPayload = HistorySyncControlPayload | ProxyPromptControlPayload;
type ProxyPromptResult = {
  requestId: string;
  ok: boolean;
  provider?: "chatgpt" | "gemini" | "grok";
  responseText?: string;
  pageUrl?: string;
  title?: string;
  error?: string;
};

function enqueueRuntimeMessage(message: RuntimeMessage): void {
  const dispatch = async (): Promise<void> => {
    try {
      await chrome.runtime.sendMessage(message);
    } catch {
      // The background service worker may be restarting; the next message will retry naturally.
    }
  };

  runtimeDispatchQueue = runtimeDispatchQueue.then(dispatch, dispatch);
}

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
  (event: MessageEvent<{ source?: string; payload?: CapturedNetworkEvent | HistorySyncUpdate | ProxyPromptResult }>) => {
    if (event.source !== window) {
      return;
    }

    if (event.data?.source === CONTROL_READY_SOURCE) {
      injectedReady = true;
      if (pendingControlPayload) {
        const payload = pendingControlPayload;
        pendingControlPayload = null;
        postControlMessage(payload);
      }
      return;
    }

    if (!event.data?.payload) {
      return;
    }

    if (event.data.source === "tsmc-network-observer") {
      enqueueRuntimeMessage({
        type: "NETWORK_CAPTURE",
        payload: event.data.payload as CapturedNetworkEvent
      });
    }

    if (event.data.source === "tsmc-history-sync") {
      enqueueRuntimeMessage({
        type: "HISTORY_SYNC_STATUS",
        payload: event.data.payload as HistorySyncUpdate
      });
    }

    if (event.data.source === PROXY_RESULT_SOURCE) {
      const payload = event.data.payload as ProxyPromptResult;
      if (!payload?.requestId) {
        return;
      }
      const pending = pendingProxyRequests.get(payload.requestId);
      if (!pending) {
        return;
      }
      pendingProxyRequests.delete(payload.requestId);
      if (!payload.ok || !payload.responseText || !payload.pageUrl) {
        pending.reject(new Error(payload.error ?? "The provider page did not return a proxy response."));
        return;
      }
      pending.resolve(payload);
    }
  }
);

function postControlMessage(payload: MainWorldControlPayload): void {
  injectedReady ||= isMainWorldReady();
  if (!injectedReady) {
    pendingControlPayload = payload;
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

async function requestProxyPrompt(
  promptText: string,
  preferFastMode = false,
  requireCompleteJson = false
): Promise<ProxyPromptResult> {
  const requestId = `proxy-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const promise = new Promise<ProxyPromptResult>((resolve, reject) => {
    pendingProxyRequests.set(requestId, { resolve, reject });
  });
  postControlMessage({
    type: "RUN_PROXY_PROMPT",
    requestId,
    promptText,
    preferFastMode,
    requireCompleteJson
  });
  return promise;
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
  if (message.type === "TOGGLE_QUICK_SEARCH") {
    quickSearchPalette.toggle();
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "SAVE_CURRENT_PAGE_SOURCE") {
    void selectionCaptureController.handleRuntimeMessage(message).then((response) => {
      sendResponse(response ?? { ok: false, error: "Unsupported page capture message." });
    });
    return true;
  }
  if (message.type === "TRIGGER_HISTORY_SYNC") {
    const payload: HistorySyncTriggerPayload = message.payload;
    postControlMessage({
      type: "START_HISTORY_SYNC",
      syncedSessionIds: payload.syncedSessionIds,
      previousTopSessionId: payload.previousTopSessionId,
      previousTopSessionIds: payload.previousTopSessionIds,
      refreshSessionIds: payload.refreshSessionIds
    });
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "RUN_PROVIDER_PROMPT") {
    if (proxyPromptInProgress) {
      sendResponse({
        ok: false,
        error: "AI processing is already running in this tab."
      } satisfies RunProviderPromptResponse);
      return false;
    }
    proxyPromptInProgress = true;
    void requestProxyPrompt(
      message.payload.promptText,
      message.payload.preferFastMode ?? false,
      message.payload.requireCompleteJson ?? false
    )
      .then((result) => {
        sendResponse({
          ok: true,
          provider: result.provider,
          responseText: result.responseText,
          pageUrl: result.pageUrl,
          title: result.title
        } satisfies RunProviderPromptResponse);
      })
      .catch((error) => {
        console.error("TSMC provider prompt run failed", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies RunProviderPromptResponse);
      })
      .finally(() => {
        proxyPromptInProgress = false;
      });
    return true;
  }
  if (message.type === "PING_PROVIDER_TAB") {
    sendResponse({
      ok: true,
      provider: detectProviderFromUrl(window.location.href) ?? undefined,
      pageUrl: window.location.href,
      mainWorldReady: injectedReady || isMainWorldReady()
    } satisfies PingProviderTabResponse);
    return false;
  }
  return false;
});

window.addEventListener("beforeunload", () => {
  for (const [requestId, pending] of pendingProxyRequests.entries()) {
    pendingProxyRequests.delete(requestId);
    pending.reject(new Error("The provider page was closed before the response completed."));
  }
});

injectedReady = isMainWorldReady();
installNavigationObserver();
notifyPageVisit();
