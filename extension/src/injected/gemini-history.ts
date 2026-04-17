import type { CapturedBody, CapturedNetworkEvent, HistorySyncUpdate, ProviderDriftAlert } from "../shared/types";

import { decodeGeminiConversationBlocks, formatGeminiDecodeDiagnostics } from "./gemini-decoder";
import { buildProviderDriftAlert, createProviderDriftError, isProviderDriftError } from "./drift";
import type { HistorySyncControlPayload } from "./history-shared";
import {
  countRetryableHistoryFailures,
  dedupeIds,
  normalizeHistorySessionIds,
  runWithConcurrency
} from "./history-shared";

const GEMINI_BATCH_PATH = "/_/BardChatUi/data/batchexecute";
const GEMINI_LIST_RPC_ID = "MaZiqc";
const GEMINI_READ_RPC_ID = "hNvQHb";
const GEMINI_HISTORY_LIST_PAGE_SIZE = 200;
const GEMINI_HISTORY_READ_PAGE_SIZE = 1_000;
const GEMINI_HISTORY_READ_CONCURRENCY = 4;
const GEMINI_CONTEXT_WAIT_TIMEOUT_MS = 10_000;
const GEMINI_CONTEXT_WAIT_POLL_MS = 200;
const GEMINI_ACCOUNT_DISCOVERY_MAX_INDEX = 10;
const GEMINI_ACCOUNT_DISCOVERY_MISS_LIMIT = 2;
const nativeFetch = window.fetch.bind(window);

interface GeminiRuntimeContext {
  at?: string;
  hl?: string;
  bl?: string;
  fSid?: string;
  sourcePath?: string;
  basePrefix?: string;
}

interface GeminiAccountContext extends GeminiRuntimeContext {
  accountIndex: number;
  accountKey: string;
  sourcePath: string;
  basePrefix: string;
}

interface GeminiConversationEntry {
  conversationId: string;
  scopedSessionId: string;
  accountIndex: number;
  accountKey: string;
  basePrefix: string;
  title?: string;
  pinned?: boolean;
  hidden?: boolean;
}

interface GeminiHistoryHooks {
  runId: string;
  postCapture: (capture: Omit<CapturedNetworkEvent, "source">) => void;
  postStatus: (update: HistorySyncUpdate) => void;
}

type GeminiConversationSyncOutcome =
  | {
      status: "captured";
      entry: GeminiConversationEntry;
    }
  | {
      status: "provider_drift";
      entry: GeminiConversationEntry;
      alert: ProviderDriftAlert;
    }
  | {
      status: "failed";
      entry: GeminiConversationEntry;
      message: string;
    };

type JsonRecord = Record<string, unknown>;

const geminiRuntimeContext: GeminiRuntimeContext = {};
let geminiReqIdCounter = Math.floor(Math.random() * 10_000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function normalizeGeminiConversationId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.startsWith("c_") ? trimmed.slice(2) : trimmed;
}

function normalizeGeminiBasePrefix(value?: string | null): string {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }

  const match = trimmed.match(/^\/u\/(\d+)$/);
  return match ? `/u/${match[1]}` : "";
}

function geminiAccountIndexFromBasePrefix(value?: string | null): number {
  const match = normalizeGeminiBasePrefix(value).match(/^\/u\/(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function buildGeminiAppSourcePath(basePrefix?: string | null): string {
  return `${normalizeGeminiBasePrefix(basePrefix)}/app`;
}

function parseGeminiRoute(
  url = location.href,
  fallbackBaseUrl = "https://gemini.google.com/app"
): {
  accountIndex: number;
  accountKey: string;
  basePrefix: string;
  sourcePath: string;
  currentConversationId?: string;
} {
  try {
    const parsed = new URL(url, fallbackBaseUrl);
    const segments = parsed.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    let basePrefix = "";
    let index = 0;

    if (segments[0] === "u" && /^\d+$/.test(segments[1] ?? "")) {
      basePrefix = `/u/${segments[1]}`;
      index = 2;
    }

    const accountIndex = geminiAccountIndexFromBasePrefix(basePrefix);
    const accountKey = `u${accountIndex}`;

    if (segments[index] === "app") {
      const currentConversationId = normalizeGeminiConversationId(segments[index + 1]) ?? undefined;
      return {
        accountIndex,
        accountKey,
        basePrefix,
        sourcePath: currentConversationId ? `${basePrefix}/app/${currentConversationId}` : `${basePrefix}/app`,
        currentConversationId
      };
    }

    if (segments[index] === "gem" && segments[index + 1]) {
      const gemId = segments[index + 1];
      const currentConversationId = normalizeGeminiConversationId(segments[index + 2]) ?? undefined;
      return {
        accountIndex,
        accountKey,
        basePrefix,
        sourcePath: currentConversationId
          ? `${basePrefix}/gem/${gemId}/${currentConversationId}`
          : `${basePrefix}/gem/${gemId}`,
        currentConversationId
      };
    }

    return {
      accountIndex,
      accountKey,
      basePrefix,
      sourcePath: `${basePrefix}/app`
    };
  } catch {
    return {
      accountIndex: 0,
      accountKey: "u0",
      basePrefix: "",
      sourcePath: "/app"
    };
  }
}

function buildGeminiScopedSessionId(accountKey: string, conversationId: unknown): string | null {
  const normalizedConversationId = normalizeGeminiConversationId(conversationId);
  if (!normalizedConversationId) {
    return null;
  }

  return `${accountKey}__${normalizedConversationId}`;
}

function parseGeminiScopedSessionId(
  value: unknown
): {
  accountKey: string;
  conversationId: string;
} | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const scopedMatch = trimmed.match(/^(u\d+)__(.+)$/);
  if (scopedMatch) {
    const conversationId = normalizeGeminiConversationId(scopedMatch[2]);
    if (!conversationId) {
      return null;
    }

    return {
      accountKey: scopedMatch[1],
      conversationId
    };
  }

  const conversationId = normalizeGeminiConversationId(trimmed);
  if (!conversationId) {
    return null;
  }

  return {
    accountKey: "u0",
    conversationId
  };
}

function normalizeGeminiExternalSessionId(value: string): string | null {
  const parsed = parseGeminiScopedSessionId(value);
  return parsed ? buildGeminiScopedSessionId(parsed.accountKey, parsed.conversationId) : null;
}

function buildGeminiHistoryPageUrl(
  conversationId: string,
  options?: {
    basePrefix?: string;
    origin?: string;
  }
): string {
  const normalizedConversationId = normalizeGeminiConversationId(conversationId) ?? conversationId;
  return new URL(
    `${normalizeGeminiBasePrefix(options?.basePrefix)}/app/${normalizedConversationId}`,
    options?.origin ?? location.origin
  ).toString();
}

function toGeminiApiConversationId(conversationId: string): string {
  return conversationId.startsWith("c_") ? conversationId : `c_${conversationId}`;
}

function sourcePathToBasePrefix(sourcePath?: string): string {
  if (!sourcePath) {
    return "";
  }

  return parseGeminiRoute(new URL(sourcePath, location.origin).toString(), location.href).basePrefix;
}

function decodeGeminiToken(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

function readGeminiAtTokenFromDom(): string | null {
  const input = document.querySelector<HTMLInputElement>('input[name="at"]');
  if (input?.value.trim()) {
    return input.value.trim();
  }

  const windowRecord = window as unknown as Record<string, unknown>;
  const wizGlobalData = asRecord(windowRecord.WIZ_global_data);
  if (typeof wizGlobalData?.SNlM0e === "string" && wizGlobalData.SNlM0e.trim()) {
    return wizGlobalData.SNlM0e.trim();
  }

  const html = document.documentElement?.innerHTML;
  const match = html?.match(/"SNlM0e":"([^"]+)"/);
  if (match?.[1]) {
    return decodeGeminiToken(match[1]).trim();
  }

  return null;
}

function parseGeminiRuntimeContextFromHtml(
  html: string,
  options?: {
    defaultBasePrefix?: string;
    defaultSourcePath?: string;
  }
): GeminiRuntimeContext {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const input = doc.querySelector('input[name="at"]');
  const inputValue = input?.getAttribute("value")?.trim();
  const htmlText = doc.documentElement?.outerHTML || html;
  const tokenMatch = htmlText.match(/"SNlM0e":"([^"]+)"/);

  return {
    at: inputValue || (tokenMatch?.[1] ? decodeGeminiToken(tokenMatch[1]).trim() : undefined),
    hl: doc.documentElement?.lang?.trim() || undefined,
    sourcePath: options?.defaultSourcePath,
    basePrefix: normalizeGeminiBasePrefix(options?.defaultBasePrefix)
  };
}

function toGeminiAccountContext(context: GeminiRuntimeContext, options?: { defaultBasePrefix?: string }): GeminiAccountContext {
  const basePrefix = normalizeGeminiBasePrefix(
    context.basePrefix ?? sourcePathToBasePrefix(context.sourcePath) ?? options?.defaultBasePrefix
  );
  const accountIndex = geminiAccountIndexFromBasePrefix(basePrefix);
  const accountKey = `u${accountIndex}`;
  const sourcePath = buildGeminiAppSourcePath(basePrefix);

  return {
    ...context,
    accountIndex,
    accountKey,
    sourcePath,
    basePrefix
  };
}

function collectGeminiRuntimeContext(): GeminiAccountContext {
  const route = parseGeminiRoute(location.href);
  const hl = document.documentElement?.lang?.trim() || geminiRuntimeContext.hl || "en";
  const at = readGeminiAtTokenFromDom() ?? geminiRuntimeContext.at;
  return toGeminiAccountContext({
    at: at ?? undefined,
    hl,
    bl: geminiRuntimeContext.bl,
    fSid: geminiRuntimeContext.fSid,
    sourcePath: buildGeminiAppSourcePath(geminiRuntimeContext.basePrefix ?? route.basePrefix),
    basePrefix: geminiRuntimeContext.basePrefix ?? route.basePrefix
  });
}

async function waitForGeminiRuntimeContext(): Promise<GeminiAccountContext> {
  const deadline = Date.now() + GEMINI_CONTEXT_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const context = collectGeminiRuntimeContext();
    if (context.at && context.sourcePath) {
      Object.assign(geminiRuntimeContext, context);
      return context;
    }

    await sleep(GEMINI_CONTEXT_WAIT_POLL_MS);
  }

  const finalContext = collectGeminiRuntimeContext();
  if (!finalContext.at) {
    throw new Error('Could not find Gemini session token "at" on the page.');
  }
  if (!finalContext.sourcePath) {
    throw new Error("Could not determine Gemini source-path.");
  }

  Object.assign(geminiRuntimeContext, finalContext);
  return finalContext;
}

export function maybeUpdateGeminiRuntimeContext(url: string, requestBody?: CapturedBody): void {
  let resolved: URL;
  try {
    resolved = new URL(url, location.href);
  } catch {
    return;
  }

  if (!/gemini\.google\.com/.test(resolved.hostname)) {
    return;
  }

  const searchParams = resolved.searchParams;
  let requestParams: URLSearchParams | null = null;
  if (typeof requestBody?.text === "string" && requestBody.text.includes("=")) {
    try {
      requestParams = new URLSearchParams(
        requestBody.text.endsWith("&") ? requestBody.text.slice(0, -1) : requestBody.text
      );
    } catch {
      requestParams = null;
    }
  }

  const nextContext: GeminiRuntimeContext = {
    at: requestParams?.get("at")?.trim() || undefined,
    hl: searchParams.get("hl")?.trim() || undefined,
    bl: searchParams.get("bl")?.trim() || undefined,
    fSid: searchParams.get("f.sid")?.trim() || undefined,
    sourcePath: searchParams.get("source-path")?.trim() || undefined
  };

  nextContext.basePrefix = normalizeGeminiBasePrefix(sourcePathToBasePrefix(nextContext.sourcePath));
  Object.assign(
    geminiRuntimeContext,
    Object.fromEntries(Object.entries(nextContext).filter(([, value]) => Boolean(value)))
  );
}

function extractGeminiAccountIndicesFromHtml(html: string): number[] {
  const indices = new Set<number>();

  for (const match of html.matchAll(/\/u\/(\d+)(?=\/(?:app|gem|$))/g)) {
    const accountIndex = Number.parseInt(match[1], 10);
    if (Number.isFinite(accountIndex)) {
      indices.add(accountIndex);
    }
  }

  return [...indices.values()].sort((left, right) => left - right);
}

function collectGeminiAccountHintsFromDocument(): number[] {
  const indices = new Set<number>();
  const route = parseGeminiRoute(location.href);
  indices.add(route.accountIndex);

  const html = document.documentElement?.innerHTML ?? "";
  for (const accountIndex of extractGeminiAccountIndicesFromHtml(html)) {
    indices.add(accountIndex);
  }

  for (const element of document.querySelectorAll<HTMLElement>("[href], [action]")) {
    const attributeValue = element.getAttribute("href") ?? element.getAttribute("action");
    if (!attributeValue) {
      continue;
    }

    try {
      const candidate = new URL(attributeValue, location.href);
      if (candidate.hostname !== location.hostname) {
        continue;
      }

      indices.add(parseGeminiRoute(candidate.toString(), location.href).accountIndex);
    } catch {
      // Ignore malformed account hints.
    }
  }

  return [...indices.values()].sort((left, right) => left - right);
}

async function loadGeminiAccountContext(
  accountIndex: number,
  activeContext: GeminiAccountContext
): Promise<GeminiAccountContext | null> {
  if (accountIndex === activeContext.accountIndex) {
    return activeContext;
  }

  const requestedBasePrefix = accountIndex === 0 ? "/u/0" : `/u/${accountIndex}`;
  const requestedUrl = new URL(buildGeminiAppSourcePath(requestedBasePrefix), location.origin).toString();

  try {
    const response = await nativeFetch(requestedUrl, {
      credentials: "include",
      redirect: "follow"
    });
    if (!response.ok) {
      return null;
    }

    const finalUrl = response.url || requestedUrl;
    const finalRoute = parseGeminiRoute(finalUrl, requestedUrl);
    if (finalRoute.accountIndex !== accountIndex) {
      return null;
    }

    const html = await response.text();
    const htmlContext = parseGeminiRuntimeContextFromHtml(html, {
      defaultBasePrefix: finalRoute.basePrefix,
      defaultSourcePath: buildGeminiAppSourcePath(finalRoute.basePrefix)
    });
    if (!htmlContext.at) {
      return null;
    }

    return toGeminiAccountContext(
      {
        ...activeContext,
        ...htmlContext,
        basePrefix: finalRoute.basePrefix,
        sourcePath: buildGeminiAppSourcePath(finalRoute.basePrefix)
      },
      {
        defaultBasePrefix: finalRoute.basePrefix
      }
    );
  } catch {
    return null;
  }
}

async function discoverGeminiAccountContexts(activeContext: GeminiAccountContext): Promise<GeminiAccountContext[]> {
  const contexts = new Map<string, GeminiAccountContext>();
  contexts.set(activeContext.accountKey, activeContext);

  const hintedIndices = collectGeminiAccountHintsFromDocument();
  let highestRequiredIndex = Math.max(activeContext.accountIndex, ...hintedIndices, 0);
  let missesBeyondRequired = 0;

  for (let accountIndex = 0; accountIndex <= GEMINI_ACCOUNT_DISCOVERY_MAX_INDEX; accountIndex += 1) {
    if (accountIndex === activeContext.accountIndex) {
      continue;
    }

    const accountContext = await loadGeminiAccountContext(accountIndex, activeContext);
    const duplicateTokenContext =
      accountContext?.at &&
      [...contexts.values()].find((context) => context.at && context.at === accountContext.at && context.accountKey !== accountContext.accountKey);

    if (accountContext && !duplicateTokenContext) {
      contexts.set(accountContext.accountKey, accountContext);
      highestRequiredIndex = Math.max(highestRequiredIndex, accountContext.accountIndex);
      missesBeyondRequired = 0;
      continue;
    }

    if (accountIndex >= highestRequiredIndex) {
      missesBeyondRequired += 1;
      if (missesBeyondRequired >= GEMINI_ACCOUNT_DISCOVERY_MISS_LIMIT) {
        break;
      }
    }
  }

  return [...contexts.values()].sort((left, right) => left.accountIndex - right.accountIndex);
}

function nextGeminiReqId(): string {
  geminiReqIdCounter += 1;
  return String(geminiReqIdCounter);
}

function parseBatchExecute(text: string, targetRpcId: string): unknown[] {
  let currentText = text;
  if (currentText.startsWith(")]}'\n")) {
    currentText = currentText.slice(5);
  }

  const lines = currentText.split("\n").filter((line) => line.trim().length > 0);
  const payloads: unknown[] = [];

  for (let index = 0; index < lines.length; ) {
    const lengthLine = lines[index++];
    if (!lengthLine || !Number.isFinite(Number.parseInt(lengthLine, 10))) {
      break;
    }

    const segmentLine = lines[index++] ?? "";
    let segment: unknown;
    try {
      segment = JSON.parse(segmentLine);
    } catch {
      continue;
    }

    if (!Array.isArray(segment)) {
      continue;
    }

    for (const entry of segment) {
      if (!Array.isArray(entry) || entry[0] !== "wrb.fr" || entry[1] !== targetRpcId) {
        continue;
      }

      const payload = entry[2];
      if (typeof payload !== "string") {
        continue;
      }

      try {
        payloads.push(JSON.parse(payload));
      } catch {
        // Ignore malformed inner payloads and continue scanning.
      }
    }
  }

  return payloads;
}

async function executeGeminiBatchCall(
  context: GeminiRuntimeContext,
  rpcId: string,
  innerArgs: unknown,
  sourcePath: string
): Promise<{
  url: string;
  requestBody: string;
  response: Response;
  text: string;
  payloads: unknown[];
}> {
  if (!context.at) {
    throw new Error("Gemini request context is missing the at token.");
  }

  const basePrefix = context.basePrefix ?? sourcePathToBasePrefix(sourcePath);
  const url = new URL(`${basePrefix}${GEMINI_BATCH_PATH}`, location.origin);
  url.searchParams.set("rpcids", rpcId);
  url.searchParams.set("source-path", sourcePath);
  url.searchParams.set("hl", context.hl ?? "en");
  url.searchParams.set("rt", "c");
  url.searchParams.set("_reqid", nextGeminiReqId());
  if (context.bl) {
    url.searchParams.set("bl", context.bl);
  }
  if (context.fSid) {
    url.searchParams.set("f.sid", context.fSid);
  }

  const fReq = JSON.stringify([[[rpcId, innerArgs == null ? null : JSON.stringify(innerArgs), null, "generic"]]]);
  const bodyParams = new URLSearchParams({
    "f.req": fReq,
    at: context.at
  });
  const requestBody = `${bodyParams.toString()}&`;

  const response = await nativeFetch(url.toString(), {
    method: "POST",
    credentials: "include",
    headers: {
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "x-same-domain": "1"
    },
    body: requestBody
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini ${rpcId} request failed with ${response.status}.`);
  }

  return {
    url: url.toString(),
    requestBody,
    response,
    text,
    payloads: parseBatchExecute(text, rpcId)
  };
}

function readGeminiNextPageToken(payloads: unknown[]): string | undefined {
  for (const payload of payloads) {
    if (!Array.isArray(payload)) {
      continue;
    }

    const nextPageToken = payload[1];
    if (typeof nextPageToken === "string" && nextPageToken.trim()) {
      return nextPageToken.trim();
    }
  }

  return undefined;
}

function parseGeminiConversationEntry(context: GeminiAccountContext, value: unknown): GeminiConversationEntry | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const conversationId = normalizeGeminiConversationId(value[0]);
  if (!conversationId) {
    return null;
  }

  const scopedSessionId = buildGeminiScopedSessionId(context.accountKey, conversationId);
  if (!scopedSessionId) {
    return null;
  }

  const title = typeof value[1] === "string" && value[1].trim() ? value[1].trim() : undefined;
  return {
    conversationId,
    scopedSessionId,
    accountIndex: context.accountIndex,
    accountKey: context.accountKey,
    basePrefix: context.basePrefix,
    title,
    pinned: value[2] === true || value[2] === 1,
    hidden: value[3] === true || value[3] === 1
  };
}

function extractGeminiConversationEntries(context: GeminiAccountContext, payloads: unknown[]): GeminiConversationEntry[] {
  const entries: GeminiConversationEntry[] = [];

  for (const payload of payloads) {
    if (!Array.isArray(payload) || !Array.isArray(payload[2])) {
      continue;
    }

    for (const item of payload[2]) {
      const entry = parseGeminiConversationEntry(context, item);
      if (entry) {
        entries.push(entry);
      }
    }
  }

  return entries;
}

function buildGeminiListArgs(pageToken: string | undefined, pinned: boolean): unknown[] {
  return [GEMINI_HISTORY_LIST_PAGE_SIZE, pageToken ?? null, [pinned ? 1 : 0, null, 1]];
}

function buildGeminiReadArgs(conversationId: string, pageToken: string | undefined): unknown[] {
  return [toGeminiApiConversationId(conversationId), GEMINI_HISTORY_READ_PAGE_SIZE, pageToken ?? null, 1, [1], [4], null, 1];
}

async function listGeminiConversationEntries(
  context: GeminiAccountContext,
  pinned: boolean,
  stopConversationId?: string
): Promise<GeminiConversationEntry[]> {
  const sourcePath = buildGeminiAppSourcePath(context.basePrefix);
  const entries = new Map<string, GeminiConversationEntry>();
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;

  while (true) {
    const result = await executeGeminiBatchCall(context, GEMINI_LIST_RPC_ID, buildGeminiListArgs(pageToken, pinned), sourcePath);
    if (!result.payloads.length) {
      throw createProviderDriftError(
        "gemini",
        "Gemini history list returned an unexpected empty batchexecute payload.",
        `rpc=${GEMINI_LIST_RPC_ID} pinned=${pinned} pageToken=${pageToken ?? "none"}`
      );
    }

    for (const entry of extractGeminiConversationEntries(context, result.payloads)) {
      const current = entries.get(entry.scopedSessionId);
      entries.set(entry.scopedSessionId, {
        ...current,
        ...entry,
        title: entry.title || current?.title
      });
    }

    if (stopConversationId && entries.has(stopConversationId)) {
      break;
    }

    const nextPageToken = readGeminiNextPageToken(result.payloads);
    if (!nextPageToken || seenTokens.has(nextPageToken)) {
      break;
    }

    seenTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  return [...entries.values()];
}

function pickGeminiWatermarkConversationId(entries: GeminiConversationEntry[]): string | undefined {
  return (
    entries.find((entry) => !entry.hidden && !entry.pinned)?.scopedSessionId ??
    entries.find((entry) => !entry.hidden)?.scopedSessionId ??
    entries[0]?.scopedSessionId
  );
}

async function collectGeminiHistoryCandidates(
  contexts: GeminiAccountContext[],
  previousTopSessionIds: Set<string>,
  syncedSessionIds: Set<string>,
  refreshSessionIds: Set<string>
): Promise<{
  topSessionIds: string[];
  pendingEntries: GeminiConversationEntry[];
  totalCount: number;
  skippedCount: number;
}> {
  const previousTopByAccount = new Map<string, string>();
  for (const sessionId of previousTopSessionIds) {
    const parsed = parseGeminiScopedSessionId(sessionId);
    if (parsed) {
      previousTopByAccount.set(parsed.accountKey, sessionId);
    }
  }

  const topSessionIds: string[] = [];
  const pendingEntries: GeminiConversationEntry[] = [];
  let totalCount = 0;
  let skippedCount = 0;

  for (const context of contexts) {
    const previousTopSessionId = previousTopByAccount.get(context.accountKey);
    const pinnedEntries = await listGeminiConversationEntries(context, true);
    const unpinnedEntries = await listGeminiConversationEntries(context, false, previousTopSessionId);
    const combinedEntries = [...pinnedEntries, ...unpinnedEntries];
    const orderedEntries = dedupeIds(combinedEntries.map((entry) => entry.scopedSessionId)).map((scopedSessionId) => {
      return combinedEntries.find((entry) => entry.scopedSessionId === scopedSessionId)!;
    });

    const topSessionId = pickGeminiWatermarkConversationId(orderedEntries);
    if (topSessionId) {
      topSessionIds.push(topSessionId);
    }

    if (previousTopSessionId) {
      const stopIndex = orderedEntries.findIndex((entry) => entry.scopedSessionId === previousTopSessionId);
      const nextPendingEntries = stopIndex >= 0 ? orderedEntries.slice(0, stopIndex) : orderedEntries;
      pendingEntries.push(...nextPendingEntries);
      totalCount += nextPendingEntries.length;
      continue;
    }

    totalCount += orderedEntries.length;
    for (const entry of orderedEntries) {
      if (refreshSessionIds.has(entry.scopedSessionId) || !syncedSessionIds.has(entry.scopedSessionId)) {
        pendingEntries.push(entry);
        continue;
      }

      skippedCount += 1;
    }
  }

  return {
    topSessionIds,
    pendingEntries,
    totalCount,
    skippedCount
  };
}

function offsetIsoTimestamp(value: string, milliseconds: number): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }

  return new Date(timestamp + milliseconds).toISOString();
}

function buildGeminiSyntheticMessages(
  scopedSessionId: string,
  blocks: Array<{
    userText: string;
    assistantText: string;
    occurredAt?: string;
  }>,
  capturedAt: string
): Array<{
  id: string;
  parentId?: string;
  role: "user" | "assistant";
  content: string;
  occurredAt: string;
}> {
  const messages: Array<{
    id: string;
    parentId?: string;
    role: "user" | "assistant";
    content: string;
    occurredAt: string;
  }> = [];

  let previousAssistantId: string | undefined;
  for (const [index, block] of blocks.entries()) {
    const occurredAt = block.occurredAt ?? capturedAt;
    const userId = `gemini-${scopedSessionId}-user-${index}`;
    messages.push({
      id: userId,
      parentId: previousAssistantId,
      role: "user",
      content: block.userText,
      occurredAt
    });

    const assistantId = `gemini-${scopedSessionId}-assistant-${index}`;
    messages.push({
      id: assistantId,
      parentId: userId,
      role: "assistant",
      content: block.assistantText,
      occurredAt: offsetIsoTimestamp(occurredAt, 1)
    });
    previousAssistantId = assistantId;
  }

  return messages;
}

async function fetchGeminiConversationCapture(
  context: GeminiAccountContext,
  entry: GeminiConversationEntry
): Promise<{
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
  const sourcePath = `${context.basePrefix}/app/${conversationId}`;
  const payloads: unknown[] = [];
  const requestBodies: string[] = [];
  let pageToken: string | undefined;
  let lastUrl = "";

  const seenTokens = new Set<string>();
  while (true) {
    const result = await executeGeminiBatchCall(
      context,
      GEMINI_READ_RPC_ID,
      buildGeminiReadArgs(conversationId, pageToken),
      sourcePath
    );
    if (!result.payloads.length) {
      throw createProviderDriftError(
        "gemini",
        "Gemini conversation read returned an unexpected empty batchexecute payload.",
        `rpc=${GEMINI_READ_RPC_ID} conversationId=${conversationId} pageToken=${pageToken ?? "none"}`
      );
    }
    payloads.push(...result.payloads);
    requestBodies.push(result.requestBody);
    lastUrl = result.url;

    const nextPageToken = readGeminiNextPageToken(result.payloads);
    if (!nextPageToken || seenTokens.has(nextPageToken)) {
      break;
    }

    seenTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  const capturedAt = new Date().toISOString();
  const decodeResult = decodeGeminiConversationBlocks(payloads);
  const blocks = decodeResult.blocks;
  if (!blocks.length) {
    throw createProviderDriftError(
      "gemini",
      "Gemini conversation payload no longer matches the expected turn structure.",
      `conversationId=${conversationId} ${formatGeminiDecodeDiagnostics(decodeResult.diagnostics)}`
    );
  }

  const responseJson = {
    conversationId,
    externalSessionId: entry.scopedSessionId,
    accountKey: entry.accountKey,
    title: entry.title,
    messages: buildGeminiSyntheticMessages(entry.scopedSessionId, blocks, capturedAt)
  };
  const requestJson = {
    rpcId: GEMINI_READ_RPC_ID,
    conversationId,
    externalSessionId: entry.scopedSessionId,
    pageCount: requestBodies.length
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
    url: lastUrl
  };
}

function postHistorySyncProgress(
  hooks: GeminiHistoryHooks,
  processedCount: number,
  totalCount: number,
  skippedCount: number,
  topSessionId?: string,
  topSessionIds?: string[],
  message?: string
): void {
  hooks.postStatus({
    provider: "gemini",
    phase: "started",
    runId: hooks.runId,
    processedCount,
    totalCount,
    skippedCount,
    topSessionId,
    topSessionIds,
    pageUrl: location.href,
    message
  });
}

export async function runGeminiHistorySync(
  control: HistorySyncControlPayload | undefined,
  hooks: GeminiHistoryHooks
): Promise<void> {
  hooks.postStatus({
    provider: "gemini",
    phase: "started",
    runId: hooks.runId,
    pageUrl: location.href
  });

  try {
    const activeContext = await waitForGeminiRuntimeContext();
    const accountContexts = await discoverGeminiAccountContexts(activeContext);
    const previousTopSessionIds = normalizeHistorySessionIds(
      "gemini",
      [
        ...(control?.previousTopSessionIds ?? []),
        ...(control?.previousTopSessionId ? [control.previousTopSessionId] : [])
      ],
      normalizeGeminiExternalSessionId
    );
    const syncedSessionIds = normalizeHistorySessionIds(
      "gemini",
      control?.syncedSessionIds,
      normalizeGeminiExternalSessionId
    );
    const refreshSessionIds = normalizeHistorySessionIds(
      "gemini",
      control?.refreshSessionIds,
      normalizeGeminiExternalSessionId
    );
    const { topSessionIds, pendingEntries, totalCount, skippedCount } = await collectGeminiHistoryCandidates(
      accountContexts,
      previousTopSessionIds,
      syncedSessionIds,
      refreshSessionIds
    );
    const topSessionId = topSessionIds[0];

    let processedCount = skippedCount;
    const outcomes: GeminiConversationSyncOutcome[] = [];
    postHistorySyncProgress(hooks, processedCount, totalCount, skippedCount, topSessionId, topSessionIds);

    await runWithConcurrency(pendingEntries, GEMINI_HISTORY_READ_CONCURRENCY, async (entry) => {
      try {
        const accountContext = accountContexts.find((context) => context.accountKey === entry.accountKey);
        if (!accountContext) {
          throw new Error(`Missing Gemini account context for ${entry.accountKey}.`);
        }

        const capture = await fetchGeminiConversationCapture(accountContext, entry);
        hooks.postCapture({
          providerHint: "gemini",
          captureMode: "full_snapshot",
          historySyncRunId: hooks.runId,
          pageUrl: buildGeminiHistoryPageUrl(entry.conversationId, {
            basePrefix: entry.basePrefix,
            origin: location.origin
          }),
          requestId: `history-gemini-${entry.accountKey}-${entry.conversationId}-${Date.now()}`,
          method: "POST",
          url: capture.url,
          capturedAt: new Date().toISOString(),
          requestBody: capture.requestBody,
          response: capture.response
        });
        outcomes.push({ status: "captured", entry });
      } catch (error) {
        if (isProviderDriftError(error)) {
          outcomes.push({
            status: "provider_drift",
            entry,
            alert: buildProviderDriftAlert("gemini", location.href, error.message, error.evidence)
          });
        } else {
          outcomes.push({
            status: "failed",
            entry,
            message: error instanceof Error ? error.message : String(error)
          });
        }
        // Skip malformed individual conversations without aborting the whole run.
      } finally {
        processedCount += 1;
        postHistorySyncProgress(hooks, processedCount, totalCount, skippedCount, topSessionId, topSessionIds);
      }
    });

    const attemptedConversationCount = pendingEntries.length;
    const syncedConversationCount = outcomes.filter((outcome) => outcome.status === "captured").length;
    const retryableFailureCount = countRetryableHistoryFailures(attemptedConversationCount, syncedConversationCount);
    const driftFailures = outcomes.filter((outcome): outcome is Extract<GeminiConversationSyncOutcome, { status: "provider_drift" }> => {
      return outcome.status === "provider_drift";
    });
    const driftFailureCount = driftFailures.length;
    const firstDriftFailure = driftFailures[0]?.alert ?? null;
    let providerDriftAlert: ProviderDriftAlert | null = null;
    if (
      firstDriftFailure &&
      driftFailureCount > 0 &&
      (syncedConversationCount === 0 || driftFailureCount >= Math.max(2, Math.ceil(attemptedConversationCount / 2)))
    ) {
      const driftFailure = firstDriftFailure as ProviderDriftAlert;
      providerDriftAlert = buildProviderDriftAlert(
        "gemini",
        location.href,
        `Gemini history sync encountered provider drift symptoms in ${driftFailureCount} of ${attemptedConversationCount} conversations.`,
        driftFailure.evidence ?? driftFailure.message
      );
    }

    hooks.postStatus({
      provider: "gemini",
      phase: "completed",
      runId: hooks.runId,
      conversationCount: syncedConversationCount,
      retryableFailureCount,
      processedCount: totalCount,
      totalCount,
      skippedCount,
      topSessionId,
      topSessionIds,
      pageUrl: location.href,
      providerDriftAlert
    });
  } catch (error) {
    hooks.postStatus({
      provider: "gemini",
      phase: "failed",
      runId: hooks.runId,
      pageUrl: location.href,
      message: error instanceof Error ? error.message : String(error),
      providerDriftAlert: isProviderDriftError(error)
        ? buildProviderDriftAlert("gemini", location.href, error.message, error.evidence)
        : null
    });
  }
}
