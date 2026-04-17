import type { CapturedNetworkEvent, HistorySyncUpdate, ProviderDriftAlert } from "../shared/types";

import { buildProviderDriftAlert, createProviderDriftError, isProviderDriftError } from "./drift";
import type { HistorySyncControlPayload } from "./history-shared";
import { countRetryableHistoryFailures, normalizeHistorySessionIds, runWithConcurrency } from "./history-shared";

const GROK_HISTORY_PAGE_SIZE = 100;
const GROK_HISTORY_DETAIL_CONCURRENCY = 4;
const GROK_ORIGIN = "https://grok.com";
const nativeFetch = window.fetch.bind(window);

interface GrokHistoryHooks {
  runId: string;
  postCapture: (capture: Omit<CapturedNetworkEvent, "source">) => void;
  postStatus: (update: HistorySyncUpdate) => void;
}

interface GrokConversationEntry {
  conversationId: string;
  title?: string;
  starred?: boolean;
}

interface GrokResponseNode {
  responseId: string;
}

interface GrokResponseRecord {
  responseId: string;
  sender?: string;
  message?: string;
  query?: string;
  createTime?: string;
  parentResponseId?: string;
  threadParentId?: string;
  partial?: boolean;
  isControl?: boolean;
}

interface GrokSyntheticMessage {
  id: string;
  parentId?: string;
  role: "user" | "assistant" | "system" | "tool" | "unknown";
  content: string;
  occurredAt?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isGrokHostname(hostname: string): boolean {
  return hostname === "grok.com" || hostname.endsWith(".grok.com");
}

function assertGrokPageOrigin(): void {
  if (!isGrokHostname(location.hostname)) {
    throw new Error(`Grok history sync must run on grok.com, not ${location.hostname || "an unknown host"}.`);
  }
}

function buildGrokUrl(path: string): URL {
  return new URL(path, GROK_ORIGIN);
}

function normalizeGrokConversationId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function parseGrokConversationEntry(value: unknown): GrokConversationEntry | null {
  const record = asRecord(value);
  const conversationId = normalizeGrokConversationId(record?.conversationId);
  if (!record || !conversationId) {
    return null;
  }

  return {
    conversationId,
    title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : undefined,
    starred: Boolean(record.starred)
  };
}

function parseGrokResponseNode(value: unknown): GrokResponseNode | null {
  const record = asRecord(value);
  const responseId = typeof record?.responseId === "string" && record.responseId.trim() ? record.responseId.trim() : null;
  if (!record || !responseId) {
    return null;
  }

  return { responseId };
}

function parseGrokResponse(value: unknown): GrokResponseRecord | null {
  const record = asRecord(value);
  const responseId = typeof record?.responseId === "string" && record.responseId.trim() ? record.responseId.trim() : null;
  if (!record || !responseId) {
    return null;
  }

  return {
    responseId,
    sender: typeof record.sender === "string" ? record.sender : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
    query: typeof record.query === "string" ? record.query : undefined,
    createTime: typeof record.createTime === "string" ? record.createTime : undefined,
    parentResponseId: typeof record.parentResponseId === "string" ? record.parentResponseId : undefined,
    threadParentId: typeof record.threadParentId === "string" ? record.threadParentId : undefined,
    partial: Boolean(record.partial),
    isControl: Boolean(record.isControl)
  };
}

function normalizeGrokRole(value: string | undefined): "user" | "assistant" | "system" | "tool" | "unknown" {
  const role = value?.toLowerCase() ?? "";
  if (role.includes("user") || role === "human") {
    return "user";
  }
  if (role.includes("assistant") || role.includes("model") || role.includes("bot")) {
    return "assistant";
  }
  if (role.includes("system")) {
    return "system";
  }
  if (role.includes("tool")) {
    return "tool";
  }
  return "unknown";
}

function normalizeGrokMessageContent(response: GrokResponseRecord): string {
  const role = normalizeGrokRole(response.sender);
  const content = role === "user" ? response.query ?? response.message ?? "" : response.message ?? response.query ?? "";
  return content.trim();
}

function sortGrokMessages(messages: GrokSyntheticMessage[]): GrokSyntheticMessage[] {
  return [...messages].sort((left, right) => {
    const leftTime = left.occurredAt ? Date.parse(left.occurredAt) : Number.MAX_SAFE_INTEGER;
    const rightTime = right.occurredAt ? Date.parse(right.occurredAt) : Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.id.localeCompare(right.id);
  });
}

function buildGrokSyntheticMessages(responses: GrokResponseRecord[]): GrokSyntheticMessage[] {
  const messages: GrokSyntheticMessage[] = [];

  for (const response of responses) {
    if (response.partial || response.isControl) {
      continue;
    }

    const content = normalizeGrokMessageContent(response);
    if (!content) {
      continue;
    }

    messages.push({
      id: response.responseId,
      parentId: response.parentResponseId ?? response.threadParentId,
      role: normalizeGrokRole(response.sender),
      content,
      occurredAt: response.createTime
    });
  }

  return sortGrokMessages(messages);
}

async function fetchJson(url: string, init?: RequestInit): Promise<{
  response: Response;
  json: unknown;
}> {
  const response = await nativeFetch(url, init);
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }

  return { response, json };
}

async function listGrokConversationEntries(
  previousTopSessionId?: string
): Promise<GrokConversationEntry[]> {
  const entries: GrokConversationEntry[] = [];
  const seenIds = new Set<string>();
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;

  while (true) {
    const url = buildGrokUrl("/rest/app-chat/conversations");
    url.searchParams.set("pageSize", String(GROK_HISTORY_PAGE_SIZE));
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const { response, json } = await fetchJson(url.toString(), {
      method: "GET",
      credentials: "include",
      headers: {
        accept: "application/json"
      }
    });
    if (!response.ok) {
      throw new Error(`Grok list request failed with ${response.status}.`);
    }

    const record = asRecord(json);
    if (!record || !Array.isArray(record.conversations)) {
      throw createProviderDriftError(
        "grok",
        "Grok history list no longer exposes the expected conversations array.",
        `pageToken=${pageToken ?? "none"}`
      );
    }
    const pageEntries = Array.isArray(record?.conversations)
      ? record.conversations.map(parseGrokConversationEntry).filter((entry): entry is GrokConversationEntry => Boolean(entry))
      : [];
    for (const entry of pageEntries) {
      if (seenIds.has(entry.conversationId)) {
        continue;
      }
      seenIds.add(entry.conversationId);
      entries.push(entry);
    }

    if (previousTopSessionId && pageEntries.some((entry) => entry.conversationId === previousTopSessionId)) {
      break;
    }

    const nextPageToken =
      typeof record?.nextPageToken === "string" && record.nextPageToken.trim() ? record.nextPageToken.trim() : undefined;
    if (!nextPageToken || seenTokens.has(nextPageToken)) {
      break;
    }

    seenTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  return entries;
}

function pickGrokWatermarkConversationId(entries: GrokConversationEntry[]): string | undefined {
  return entries.find((entry) => !entry.starred)?.conversationId ?? entries[0]?.conversationId;
}

async function collectGrokHistoryCandidates(
  previousTopSessionId: string | undefined,
  syncedSessionIds: Set<string>,
  refreshSessionIds: Set<string>
): Promise<{
  topSessionId?: string;
  pendingEntries: GrokConversationEntry[];
  totalCount: number;
  skippedCount: number;
}> {
  const orderedEntries = await listGrokConversationEntries(previousTopSessionId);
  const topSessionId = pickGrokWatermarkConversationId(orderedEntries);

  if (previousTopSessionId) {
    const stopIndex = orderedEntries.findIndex((entry) => entry.conversationId === previousTopSessionId);
    const pendingEntries = stopIndex >= 0 ? orderedEntries.slice(0, stopIndex) : orderedEntries;
    return {
      topSessionId,
      pendingEntries,
      totalCount: pendingEntries.length,
      skippedCount: 0
    };
  }

  const pendingEntries = orderedEntries.filter((entry) => {
    return refreshSessionIds.has(entry.conversationId) || !syncedSessionIds.has(entry.conversationId);
  });
  return {
    topSessionId,
    pendingEntries,
    totalCount: orderedEntries.length,
    skippedCount: orderedEntries.length - pendingEntries.length
  };
}

async function fetchGrokConversationResponsesDirect(conversationId: string): Promise<GrokResponseRecord[]> {
  const url = buildGrokUrl(`/rest/app-chat/conversations/${conversationId}/responses`);
  url.searchParams.set("includeThreads", "true");

  const { response, json } = await fetchJson(url.toString(), {
    method: "GET",
    credentials: "include",
    headers: {
      accept: "application/json"
    }
  });
  if (!response.ok) {
    throw new Error(`Grok responses request failed with ${response.status}.`);
  }

  const record = asRecord(json);
  if (!record || !Array.isArray(record.responses)) {
    throw createProviderDriftError(
      "grok",
      "Grok conversation response list no longer exposes the expected responses array.",
      `conversationId=${conversationId}`
    );
  }
  return Array.isArray(record?.responses)
    ? record.responses.map(parseGrokResponse).filter((item): item is GrokResponseRecord => Boolean(item))
    : [];
}

async function fetchGrokConversationResponsesViaNodes(conversationId: string): Promise<GrokResponseRecord[]> {
  const nodeUrl = buildGrokUrl(`/rest/app-chat/conversations/${conversationId}/response-node`);
  nodeUrl.searchParams.set("includeThreads", "true");

  const nodeResult = await fetchJson(nodeUrl.toString(), {
    method: "GET",
    credentials: "include",
    headers: {
      accept: "application/json"
    }
  });
  if (!nodeResult.response.ok) {
    throw new Error(`Grok response-node request failed with ${nodeResult.response.status}.`);
  }

  const nodeRecord = asRecord(nodeResult.json);
  if (!nodeRecord || !Array.isArray(nodeRecord.responseNodes)) {
    throw createProviderDriftError(
      "grok",
      "Grok response-node payload no longer exposes the expected responseNodes array.",
      `conversationId=${conversationId}`
    );
  }
  const responseIds = Array.isArray(nodeRecord?.responseNodes)
    ? nodeRecord.responseNodes
        .map(parseGrokResponseNode)
        .filter((item): item is GrokResponseNode => Boolean(item))
        .map((node) => node.responseId)
    : [];
  if (!responseIds.length) {
    return [];
  }

  const loadUrl = buildGrokUrl(`/rest/app-chat/conversations/${conversationId}/load-responses`);
  const loadResult = await fetchJson(loadUrl.toString(), {
    method: "POST",
    credentials: "include",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify({ responseIds })
  });
  if (!loadResult.response.ok) {
    throw new Error(`Grok load-responses request failed with ${loadResult.response.status}.`);
  }

  const loadRecord = asRecord(loadResult.json);
  if (!loadRecord || !Array.isArray(loadRecord.responses)) {
    throw createProviderDriftError(
      "grok",
      "Grok load-responses payload no longer exposes the expected responses array.",
      `conversationId=${conversationId}`
    );
  }
  return Array.isArray(loadRecord?.responses)
    ? loadRecord.responses.map(parseGrokResponse).filter((item): item is GrokResponseRecord => Boolean(item))
    : [];
}

async function fetchGrokConversationCapture(entry: GrokConversationEntry): Promise<{
  requestBody: {
    text: string;
    json: unknown;
  };
  response: {
    status: number;
    ok: boolean;
    contentType?: string;
    text: string;
    json: unknown;
  };
  url: string;
}> {
  const conversationId = entry.conversationId;
  let responses = await fetchGrokConversationResponsesDirect(conversationId);
  let url = buildGrokUrl(`/rest/app-chat/conversations/${conversationId}/responses?includeThreads=true`).toString();

  if (!responses.length) {
    responses = await fetchGrokConversationResponsesViaNodes(conversationId);
    url = buildGrokUrl(`/rest/app-chat/conversations/${conversationId}/load-responses`).toString();
  }

  const messages = buildGrokSyntheticMessages(responses);
  if (!messages.length) {
    throw createProviderDriftError(
      "grok",
      "Grok conversation payload no longer matches the expected response shape.",
      `conversationId=${conversationId}`
    );
  }

  const responseJson = {
    conversationId,
    title: entry.title,
    messages
  };
  const requestJson = {
    conversationId,
    route: url.includes("/responses?") ? "responses" : "load-responses"
  };

  return {
    requestBody: {
      text: JSON.stringify(requestJson),
      json: requestJson
    },
    response: {
      status: 200,
      ok: true,
      contentType: "application/json",
      text: JSON.stringify(responseJson),
      json: responseJson
    },
    url
  };
}

function buildGrokHistoryPageUrl(conversationId: string): string {
  return buildGrokUrl(`/c/${conversationId}`).toString();
}

function postHistorySyncProgress(
  hooks: GrokHistoryHooks,
  processedCount: number,
  totalCount: number,
  skippedCount: number,
  topSessionId?: string,
  message?: string
): void {
  hooks.postStatus({
    provider: "grok",
    phase: "started",
    runId: hooks.runId,
    processedCount,
    totalCount,
    skippedCount,
    topSessionId,
    pageUrl: location.href,
    message
  });
}

export async function runGrokHistorySync(
  control: HistorySyncControlPayload | undefined,
  hooks: GrokHistoryHooks
): Promise<void> {
  hooks.postStatus({
    provider: "grok",
    phase: "started",
    runId: hooks.runId,
    pageUrl: location.href
  });

  try {
    assertGrokPageOrigin();

    const previousTopSessionId = normalizeGrokConversationId(control?.previousTopSessionId) ?? undefined;
    const syncedSessionIds = normalizeHistorySessionIds("grok", control?.syncedSessionIds);
    const refreshSessionIds = normalizeHistorySessionIds("grok", control?.refreshSessionIds);
    const { topSessionId, pendingEntries, totalCount, skippedCount } = await collectGrokHistoryCandidates(
      previousTopSessionId,
      syncedSessionIds,
      refreshSessionIds
    );

    let processedCount = skippedCount;
    let syncedConversationCount = 0;
    let driftFailureCount = 0;
    let firstDriftFailure: ProviderDriftAlert | null = null;
    postHistorySyncProgress(hooks, processedCount, totalCount, skippedCount, topSessionId);

    await runWithConcurrency(pendingEntries, GROK_HISTORY_DETAIL_CONCURRENCY, async (entry) => {
      try {
        const capture = await fetchGrokConversationCapture(entry);
        hooks.postCapture({
          providerHint: "grok",
          captureMode: "full_snapshot",
          historySyncRunId: hooks.runId,
          pageUrl: buildGrokHistoryPageUrl(entry.conversationId),
          requestId: `history-grok-${entry.conversationId}-${Date.now()}`,
          method: "GET",
          url: capture.url,
          capturedAt: new Date().toISOString(),
          requestBody: capture.requestBody,
          response: capture.response
        });
        syncedConversationCount += 1;
      } catch (error) {
        if (isProviderDriftError(error)) {
          driftFailureCount += 1;
          firstDriftFailure ??= buildProviderDriftAlert("grok", location.href, error.message, error.evidence);
        }
        // Skip malformed individual conversations without aborting the run.
      } finally {
        processedCount += 1;
        postHistorySyncProgress(hooks, processedCount, totalCount, skippedCount, topSessionId);
      }
    });

    const attemptedConversationCount = pendingEntries.length;
    const retryableFailureCount = countRetryableHistoryFailures(attemptedConversationCount, syncedConversationCount);
    let providerDriftAlert: ProviderDriftAlert | null = null;
    if (
      firstDriftFailure &&
      driftFailureCount > 0 &&
      (syncedConversationCount === 0 || driftFailureCount >= Math.max(2, Math.ceil(attemptedConversationCount / 2)))
    ) {
      const driftFailure = firstDriftFailure as ProviderDriftAlert;
      providerDriftAlert = buildProviderDriftAlert(
        "grok",
        location.href,
        `Grok history sync encountered provider drift symptoms in ${driftFailureCount} of ${attemptedConversationCount} conversations.`,
        driftFailure.evidence ?? driftFailure.message
      );
    }

    hooks.postStatus({
      provider: "grok",
      phase: "completed",
      runId: hooks.runId,
      conversationCount: syncedConversationCount,
      retryableFailureCount,
      processedCount: totalCount,
      totalCount,
      skippedCount,
      topSessionId,
      pageUrl: location.href,
      providerDriftAlert
    });
  } catch (error) {
    hooks.postStatus({
      provider: "grok",
      phase: "failed",
      runId: hooks.runId,
      pageUrl: location.href,
      message: error instanceof Error ? error.message : String(error),
      providerDriftAlert: isProviderDriftError(error)
        ? buildProviderDriftAlert("grok", location.href, error.message, error.evidence)
        : null
    });
  }
}
