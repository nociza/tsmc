import type {
  BridgeToExtensionMessage,
  BridgeToPageMessage,
  CapturedBody,
  CapturedNetworkEvent,
  HistorySyncControlPayload,
  HistorySyncUpdate,
  MainWorldControlPayload,
  ProviderDriftAlert,
  ProviderName,
  ProxyPromptResult
} from "../shared/types";
import { BRIDGE_CONNECT_SOURCE, MAIN_WORLD_READY_ATTRIBUTE } from "../shared/bridge";

import { maybeUpdateGeminiRuntimeContext, runGeminiHistorySync } from "./gemini-history";
import { runGrokHistorySync } from "./grok-history";
import { runProxyPrompt, observeProxyCapture } from "./proxy-runner";
import { buildProviderDriftAlert, createProviderDriftError, isProviderDriftError } from "./drift";
import {
  dedupeIds,
  normalizeHistorySessionIds,
  runWithConcurrency
} from "./history-shared";

const OBSERVER_FLAG = "__SAVEMYCONTEXT_NETWORK_OBSERVER__";
const INTERESTING_PATH =
  /backend-api|conversation|conversations|BardFrontendService|StreamGenerate|batchexecute|app-chat|grok|chat/i;
const CHATGPT_HISTORY_PAGE_LIMIT = 100;
const CHATGPT_HISTORY_MAX_OFFSET = 5_000;
const CHATGPT_HISTORY_DETAIL_CONCURRENCY = 4;
const CHATGPT_ORIGIN = "https://chatgpt.com";
const nativeFetch = window.fetch.bind(window);
let bridgePort: MessagePort | null = null;
const pendingBridgeMessages: BridgeToExtensionMessage[] = [];

interface TrackedXHR extends XMLHttpRequest {
  __savemycontextMethod?: string;
  __savemycontextUrl?: string;
}

interface HistoryCandidates {
  topSessionId?: string;
  pendingSessionIds: string[];
  totalCount: number;
  skippedCount: number;
}

type JsonRecord = Record<string, unknown>;

const activeHistorySyncs = new Set<ProviderName>();

function createHistorySyncRunId(provider: ProviderName): string {
  return `${provider}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeJsonParse(text?: string): unknown {
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function isChatGPTHostname(hostname: string): boolean {
  return hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com") || hostname === "chat.openai.com";
}

function providerHintFromUrl(url: string): ProviderName | undefined {
  try {
    const hostname = new URL(url, location.href).hostname;
    if (isChatGPTHostname(hostname)) {
      return "chatgpt";
    }
    if (/gemini\.google\.com/.test(hostname)) {
      return "gemini";
    }
    if (hostname === "grok.com" || hostname.endsWith(".grok.com")) {
      return "grok";
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function currentProvider(): ProviderName | null {
  return providerHintFromUrl(location.href) ?? null;
}

function shouldCapture(url: string): boolean {
  try {
    const resolved = new URL(url, location.href);
    return INTERESTING_PATH.test(resolved.pathname + resolved.search);
  } catch {
    return false;
  }
}

function flushPendingBridgeMessages(): void {
  if (!bridgePort || !pendingBridgeMessages.length) {
    return;
  }
  while (pendingBridgeMessages.length) {
    bridgePort.postMessage(pendingBridgeMessages.shift()!);
  }
}

function postToExtension(message: BridgeToExtensionMessage): void {
  if (!bridgePort) {
    pendingBridgeMessages.push(message);
    return;
  }
  bridgePort.postMessage(message);
}

function handleControlPayload(payload: MainWorldControlPayload): void {
  if (payload.type === "START_HISTORY_SYNC") {
    void runHistorySync(payload);
    return;
  }

  const provider = currentProvider();
  if (!provider) {
    postToExtension({
      type: "PROXY_RESULT",
      payload: {
        requestId: payload.requestId,
        ok: false,
        error: "SaveMyContext proxy prompt can only run on a supported provider page."
      }
    });
    return;
  }

  void runProxyPrompt(provider, payload.promptText, {
    preferFastMode: payload.preferFastMode ?? false,
    requireCompleteJson: payload.requireCompleteJson ?? false
  })
    .then((result) => {
      postToExtension({
        type: "PROXY_RESULT",
        payload: {
          requestId: payload.requestId,
          ok: true,
          provider: result.provider,
          responseText: result.responseText,
          pageUrl: result.pageUrl,
          title: result.title
        }
      });
    })
    .catch((error) => {
      postToExtension({
        type: "PROXY_RESULT",
        payload: {
          requestId: payload.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    });
}

function attachBridgePort(port: MessagePort): void {
  bridgePort = port;
  bridgePort.onmessage = (event: MessageEvent<BridgeToPageMessage>) => {
    if (event.data?.type !== "CONTROL") {
      return;
    }
    handleControlPayload(event.data.payload);
  };
  bridgePort.start();
  document.documentElement?.setAttribute(MAIN_WORLD_READY_ATTRIBUTE, "1");
  bridgePort.postMessage({ type: "BRIDGE_READY" });
  flushPendingBridgeMessages();
}

function postCapture(capture: Omit<CapturedNetworkEvent, "source">): void {
  const payload = {
    ...capture,
    source: "savemycontext-network-observer"
  } satisfies CapturedNetworkEvent;
  observeProxyCapture(payload);
  postToExtension({
    type: "NETWORK_CAPTURE",
    payload
  });
}

function postHistorySyncStatus(update: HistorySyncUpdate): void {
  postToExtension({
    type: "HISTORY_SYNC_STATUS",
    payload: update
  });
}

function postHistorySyncProgress(
  provider: ProviderName,
  runId: string,
  processedCount: number,
  totalCount: number,
  skippedCount: number,
  topSessionId?: string,
  message?: string
): void {
  postHistorySyncStatus({
    provider,
    phase: "started",
    runId,
    processedCount,
    totalCount,
    skippedCount,
    topSessionId,
    pageUrl: location.href,
    message
  });
}

async function serializeBody(body: unknown): Promise<CapturedBody | undefined> {
  if (!body) {
    return undefined;
  }

  if (typeof body === "string") {
    return {
      text: body,
      json: safeJsonParse(body)
    };
  }

  if (body instanceof URLSearchParams) {
    return serializeBody(body.toString());
  }

  if (body instanceof Blob) {
    return serializeBody(await body.text());
  }

  if (body instanceof FormData) {
    const json: Record<string, string[]> = {};
    body.forEach((value, key) => {
      const nextValue = typeof value === "string" ? value : value.name;
      json[key] = [...(json[key] ?? []), nextValue];
    });
    return {
      text: JSON.stringify(json),
      json
    };
  }

  if (body instanceof ArrayBuffer) {
    return serializeBody(new TextDecoder().decode(new Uint8Array(body)));
  }

  if (ArrayBuffer.isView(body)) {
    return serializeBody(new TextDecoder().decode(body));
  }

  return undefined;
}

async function readFetchRequestBody(input: RequestInfo | URL, init?: RequestInit): Promise<CapturedBody | undefined> {
  if (init?.body) {
    return serializeBody(init.body);
  }

  if (input instanceof Request) {
    try {
      return serializeBody(await input.clone().text());
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function patchFetch(): void {
  window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = request.url;
    if (!shouldCapture(url)) {
      return nativeFetch(input, init);
    }

    const requestBody = await readFetchRequestBody(input, init);
    maybeUpdateGeminiRuntimeContext(url, requestBody);

    const response = await nativeFetch(input, init);

    try {
      const clone = response.clone();
      const text = await clone.text();
      postCapture({
        providerHint: providerHintFromUrl(url),
        pageUrl: location.href,
        requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        method: request.method,
        url,
        capturedAt: new Date().toISOString(),
        requestBody,
        response: {
          status: response.status,
          ok: response.ok,
          contentType: clone.headers.get("content-type") ?? undefined,
          text,
          json: safeJsonParse(text)
        }
      });
    } catch {
      // Streaming and opaque responses can fail to clone or decode.
    }

    return response;
  };
}

function patchXHR(): void {
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(
    this: TrackedXHR,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ): void {
    this.__savemycontextMethod = method;
    this.__savemycontextUrl = String(url);
    return nativeOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
  };

  XMLHttpRequest.prototype.send = function patchedSend(
    this: TrackedXHR,
    body?: Document | XMLHttpRequestBodyInit | null
  ): void {
    const url = this.__savemycontextUrl;
    const method = this.__savemycontextMethod ?? "GET";
    const requestBodyPromise = serializeBody(body);

    if (url && shouldCapture(url)) {
      this.addEventListener(
        "loadend",
        () => {
          void requestBodyPromise.then((requestBody) => {
            maybeUpdateGeminiRuntimeContext(url, requestBody);

            const text = this.responseType === "" || this.responseType === "text" ? this.responseText : "";
            postCapture({
              providerHint: providerHintFromUrl(url),
              pageUrl: location.href,
              requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              method,
              url,
              capturedAt: new Date().toISOString(),
              requestBody,
              response: {
                status: this.status,
                ok: this.status >= 200 && this.status < 300,
                contentType: this.getResponseHeader("content-type") ?? undefined,
                text,
                json: safeJsonParse(text)
              }
            });
          });
        },
        { once: true }
      );
    }

    return nativeSend.call(this, body);
  };
}

async function fetchJsonWithText(
  url: string,
  init?: RequestInit
): Promise<{
  response: Response;
  text: string;
  json: unknown;
}> {
  const response = await nativeFetch(url, init);
  const text = await response.text();
  return {
    response,
    text,
    json: safeJsonParse(text)
  };
}

function assertChatGPTPageOrigin(): void {
  if (!isChatGPTHostname(location.hostname)) {
    throw new Error(`ChatGPT history sync must run on chatgpt.com, not ${location.hostname || "an unknown host"}.`);
  }
}

function buildChatGPTUrl(path: string): URL {
  return new URL(path, CHATGPT_ORIGIN);
}

function normalizeChatGPTConversationIds(payload: unknown, evidence?: string): string[] {
  const record = asRecord(payload);
  if (!record || !Array.isArray(record.items)) {
    throw createProviderDriftError(
      "chatgpt",
      "ChatGPT history list no longer exposes the expected items array.",
      evidence
    );
  }

  return [
    ...new Set(
      record.items
        .map((item) => {
          const itemRecord = asRecord(item);
          return typeof itemRecord?.id === "string" ? itemRecord.id : null;
        })
        .filter((value): value is string => Boolean(value))
    )
  ];
}

function buildChatGPTHistoryPageUrl(conversationId: string): string {
  return buildChatGPTUrl(`/c/${conversationId}`).toString();
}

function hasChatGPTConversationPayload(payload: unknown): boolean {
  const record = asRecord(payload);
  return Boolean(record && (asRecord(record.mapping) || Array.isArray(record.messages) || asRecord(record.message)));
}

async function collectChatGPTHistoryCandidates(
  headers: HeadersInit,
  previousTopSessionId: string | undefined,
  syncedSessionIds: Set<string>,
  refreshSessionIds: Set<string>
): Promise<HistoryCandidates> {
  const discoveredIds: string[] = [];
  let topSessionId: string | undefined;

  for (let offset = 0; offset < CHATGPT_HISTORY_MAX_OFFSET; offset += CHATGPT_HISTORY_PAGE_LIMIT) {
    const listUrl = buildChatGPTUrl("/backend-api/conversations");
    listUrl.searchParams.set("offset", String(offset));
    listUrl.searchParams.set("limit", String(CHATGPT_HISTORY_PAGE_LIMIT));
    listUrl.searchParams.set("order", "updated");

    const listResult = await fetchJsonWithText(listUrl.toString(), {
      method: "GET",
      credentials: "include",
      headers
    });
    if (!listResult.response.ok) {
      throw new Error(`ChatGPT list request failed with ${listResult.response.status}.`);
    }

    const pageConversationIds = normalizeChatGPTConversationIds(listResult.json, `offset=${offset}`);
    if (!pageConversationIds.length) {
      break;
    }

    topSessionId ??= pageConversationIds[0];

    if (previousTopSessionId) {
      const stopIndex = pageConversationIds.indexOf(previousTopSessionId);
      if (stopIndex >= 0) {
        discoveredIds.push(...pageConversationIds.slice(0, stopIndex));
        break;
      }
      discoveredIds.push(...pageConversationIds);
    } else {
      discoveredIds.push(...pageConversationIds);
    }

    if (pageConversationIds.length < CHATGPT_HISTORY_PAGE_LIMIT) {
      break;
    }
  }

  const allConversationIds = dedupeIds(discoveredIds);
  if (previousTopSessionId) {
    return {
      topSessionId,
      pendingSessionIds: allConversationIds,
      totalCount: allConversationIds.length,
      skippedCount: 0
    };
  }

  const pendingSessionIds = allConversationIds.filter(
    (conversationId) => refreshSessionIds.has(conversationId) || !syncedSessionIds.has(conversationId)
  );
  return {
    topSessionId,
    pendingSessionIds,
    totalCount: allConversationIds.length,
    skippedCount: allConversationIds.length - pendingSessionIds.length
  };
}

async function withHistorySyncGuard(
  provider: ProviderName,
  runner: (runId: string) => Promise<void>
): Promise<void> {
  if (activeHistorySyncs.has(provider)) {
    return;
  }

  activeHistorySyncs.add(provider);
  const runId = createHistorySyncRunId(provider);
  try {
    await runner(runId);
  } finally {
    activeHistorySyncs.delete(provider);
  }
}

async function runChatGPTHistorySync(control?: HistorySyncControlPayload): Promise<void> {
  await withHistorySyncGuard("chatgpt", async (runId) => {
    postHistorySyncStatus({
      provider: "chatgpt",
      phase: "started",
      runId,
      pageUrl: location.href
    });

    try {
      assertChatGPTPageOrigin();

      const sessionResult = await fetchJsonWithText(buildChatGPTUrl("/api/auth/session").toString(), {
        method: "GET",
        credentials: "include",
        headers: {
          Accept: "application/json"
        }
      });
      const sessionJson = (sessionResult.json ?? {}) as JsonRecord;
      const accessToken =
        typeof sessionJson.accessToken === "string" && sessionJson.accessToken.trim()
          ? sessionJson.accessToken.trim()
          : null;

      const headers: HeadersInit = {
        Accept: "application/json"
      };
      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
      }

      const previousTopSessionId =
        typeof control?.previousTopSessionId === "string" && control.previousTopSessionId.trim()
          ? control.previousTopSessionId.trim()
          : undefined;
      const syncedSessionIds = normalizeHistorySessionIds("chatgpt", control?.syncedSessionIds);
      const refreshSessionIds = normalizeHistorySessionIds("chatgpt", control?.refreshSessionIds);
      const { topSessionId, pendingSessionIds, totalCount, skippedCount } = await collectChatGPTHistoryCandidates(
        headers,
        previousTopSessionId,
        syncedSessionIds,
        refreshSessionIds
      );

      let processedCount = skippedCount;
      let syncedConversationCount = 0;
      let driftFailureCount = 0;
      let firstDriftFailure: ProviderDriftAlert | null = null;
      postHistorySyncProgress("chatgpt", runId, processedCount, totalCount, skippedCount, topSessionId);

      await runWithConcurrency(pendingSessionIds, CHATGPT_HISTORY_DETAIL_CONCURRENCY, async (conversationId) => {
        try {
          const detailUrl = buildChatGPTUrl(`/backend-api/conversation/${conversationId}`);
          const detailResult = await fetchJsonWithText(detailUrl.toString(), {
            method: "GET",
            credentials: "include",
            headers
          });
          if (!detailResult.response.ok) {
            return;
          }
          if (!hasChatGPTConversationPayload(detailResult.json)) {
            throw createProviderDriftError(
              "chatgpt",
              "ChatGPT conversation detail no longer exposes a mapping or messages payload.",
              `conversationId=${conversationId}`
            );
          }

          postCapture({
            providerHint: "chatgpt",
            captureMode: "full_snapshot",
            historySyncRunId: runId,
            pageUrl: buildChatGPTHistoryPageUrl(conversationId),
            requestId: `history-chatgpt-${conversationId}-${Date.now()}`,
            method: "GET",
            url: detailUrl.toString(),
            capturedAt: new Date().toISOString(),
            response: {
              status: detailResult.response.status,
              ok: detailResult.response.ok,
              contentType: detailResult.response.headers.get("content-type") ?? undefined,
              text: detailResult.text,
              json: detailResult.json
            }
          });
          syncedConversationCount += 1;
        } catch (error) {
          if (isProviderDriftError(error)) {
            driftFailureCount += 1;
            firstDriftFailure ??= buildProviderDriftAlert("chatgpt", location.href, error.message, error.evidence);
          }
          // Skip malformed individual conversations without aborting the whole run.
        } finally {
          processedCount += 1;
          postHistorySyncProgress("chatgpt", runId, processedCount, totalCount, skippedCount, topSessionId);
        }
      });

      const attemptedConversationCount = pendingSessionIds.length;
      let providerDriftAlert: ProviderDriftAlert | null = null;
      if (
        firstDriftFailure &&
        driftFailureCount > 0 &&
        (syncedConversationCount === 0 || driftFailureCount >= Math.max(2, Math.ceil(attemptedConversationCount / 2)))
      ) {
        const driftFailure = firstDriftFailure as ProviderDriftAlert;
        providerDriftAlert = buildProviderDriftAlert(
          "chatgpt",
          location.href,
          `ChatGPT history sync encountered provider drift symptoms in ${driftFailureCount} of ${attemptedConversationCount} conversations.`,
          driftFailure.evidence ?? driftFailure.message
        );
      }

      postHistorySyncStatus({
        provider: "chatgpt",
        phase: "completed",
        runId,
        conversationCount: syncedConversationCount,
        processedCount: totalCount,
        totalCount,
        skippedCount,
        topSessionId,
        pageUrl: location.href,
        providerDriftAlert
      });
    } catch (error) {
      postHistorySyncStatus({
        provider: "chatgpt",
        phase: "failed",
        runId,
        pageUrl: location.href,
        message: error instanceof Error ? error.message : String(error),
        providerDriftAlert: isProviderDriftError(error)
          ? buildProviderDriftAlert("chatgpt", location.href, error.message, error.evidence)
          : null
      });
    }
  });
}

async function runManagedGeminiHistorySync(control?: HistorySyncControlPayload): Promise<void> {
  await withHistorySyncGuard("gemini", async (runId) => {
    await runGeminiHistorySync(control, {
      runId,
      postCapture,
      postStatus: postHistorySyncStatus
    });
  });
}

async function runManagedGrokHistorySync(control?: HistorySyncControlPayload): Promise<void> {
  await withHistorySyncGuard("grok", async (runId) => {
    await runGrokHistorySync(control, {
      runId,
      postCapture,
      postStatus: postHistorySyncStatus
    });
  });
}

async function runHistorySync(control?: HistorySyncControlPayload): Promise<void> {
  const provider = currentProvider();
  if (!provider) {
    return;
  }

  if (provider === "chatgpt") {
    await runChatGPTHistorySync(control);
    return;
  }

  if (provider === "gemini") {
    await runManagedGeminiHistorySync(control);
    return;
  }

  if (provider === "grok") {
    await runManagedGrokHistorySync(control);
  }
}

window.addEventListener("message", (event: MessageEvent<{ source?: string }>) => {
  if (event.source !== window) {
    return;
  }
  if (event.data?.source !== BRIDGE_CONNECT_SOURCE) {
    return;
  }
  const [port] = event.ports;
  if (!port) {
    return;
  }
  if (bridgePort) {
    port.close();
    return;
  }
  attachBridgePort(port);
});

const windowFlags = window as unknown as Record<string, unknown>;

if (!windowFlags[OBSERVER_FLAG]) {
  windowFlags[OBSERVER_FLAG] = true;
  patchFetch();
  patchXHR();
}
