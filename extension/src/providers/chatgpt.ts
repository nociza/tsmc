import type { CapturedNetworkEvent, NormalizedMessage, NormalizedSessionSnapshot } from "../shared/types";
import type { IProviderScraper } from "./provider";
import {
  coerceOccurredAt,
  dedupeMessages,
  extractStructuredCandidates,
  findStringByKeys,
  flattenText,
  normalizeRole,
  resolveCapturedUrl,
  sessionIdFromPageUrl,
  stableId
} from "./helpers";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function isChatGPTHostname(hostname: string): boolean {
  return hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com") || hostname === "chat.openai.com";
}

function isChatGPTConversationCaptureRoute(url: URL): boolean {
  const pathname = url.pathname.replace(/\/$/, "");
  return pathname === "/backend-api/conversation" || /^\/backend-api\/conversation\/[^/]+$/.test(pathname);
}

function conversationIdFromCapturedUrl(url: URL): string | undefined {
  const apiMatch = url.pathname.match(/^\/backend-api\/conversation\/([^/]+)$/);
  if (apiMatch?.[1]) {
    return decodeURIComponent(apiMatch[1]);
  }

  const pageMatch = url.pathname.match(/^\/c\/([^/]+)/);
  return pageMatch?.[1] ? decodeURIComponent(pageMatch[1]) : undefined;
}

function chatGPTContentType(record: JsonRecord): string | undefined {
  const content = asRecord(record.content);
  return typeof content?.content_type === "string" ? content.content_type : undefined;
}

function chatGPTContentText(value: unknown): string {
  if (typeof value === "string") {
    return flattenText(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === "string" ? flattenText(part) : chatGPTContentText(part)))
      .filter(Boolean)
      .join("\n");
  }

  const record = asRecord(value);
  if (!record) {
    return "";
  }

  const parts = record.parts;
  if (Array.isArray(parts)) {
    return parts
      .map((part) => {
        if (typeof part === "string") {
          return flattenText(part);
        }
        const partRecord = asRecord(part);
        return typeof partRecord?.text === "string" ? flattenText(partRecord.text) : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (typeof record.text === "string") {
    return flattenText(record.text);
  }
  if (typeof record.content === "string") {
    return flattenText(record.content);
  }

  return "";
}

function isVisibleChatGPTMessage(record: JsonRecord): boolean {
  const author = asRecord(record.author);
  const role = normalizeRole(author?.role ?? record.role);
  if (role !== "user" && role !== "assistant") {
    return false;
  }

  const metadata = asRecord(record.metadata);
  if (metadata?.is_visually_hidden_from_conversation === true) {
    return false;
  }

  const contentType = chatGPTContentType(record);
  if (contentType && ["reasoning_recap", "thoughts", "model_editable_context"].includes(contentType)) {
    return false;
  }

  const recipient = typeof record.recipient === "string" ? record.recipient : undefined;
  if (role === "assistant" && recipient && recipient !== "all" && recipient !== "assistant") {
    return false;
  }

  return true;
}

function buildMessage(record: JsonRecord, fallbackParent?: string): NormalizedMessage | null {
  if (!isVisibleChatGPTMessage(record)) {
    return null;
  }

  const content = chatGPTContentText(record.content ?? record.parts ?? record.text ?? record.message);
  if (!content) {
    return null;
  }

  const author = asRecord(record.author);
  const metadata = asRecord(record.metadata);
  const role = normalizeRole(author?.role ?? record.role);
  const id = typeof record.id === "string" ? record.id : stableId("chatgpt-msg", `${role}:${content}`);
  const parentId =
    (typeof record.parent === "string" ? record.parent : undefined) ??
    (typeof record.parent_id === "string" ? record.parent_id : undefined) ??
    (typeof metadata?.parent_id === "string" ? metadata.parent_id : undefined) ??
    fallbackParent;

  return {
    id,
    parentId,
    role,
    content,
    occurredAt: coerceOccurredAt(record.create_time ?? record.createTime ?? record.update_time),
    raw: record
  };
}

function extractFromMapping(mapping: JsonRecord, currentNode?: string): NormalizedMessage[] {
  return extractFromMappingPath(mapping, currentNode).flatMap(({ message, parent }) => {
    const built = buildMessage(message, parent);
    return built ? [built] : [];
  });
}

function extractFromMappingPath(mapping: JsonRecord, currentNode?: string): Array<{ message: JsonRecord; parent?: string }> {
  if (currentNode && asRecord(mapping[currentNode])) {
    const path: Array<{ node: JsonRecord; parent?: string }> = [];
    const seen = new Set<string>();
    let cursor: string | undefined = currentNode;

    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const node = asRecord(mapping[cursor]);
      if (!node) {
        break;
      }
      path.push({
        node,
        parent: typeof node.parent === "string" ? node.parent : undefined
      });
      cursor = typeof node.parent === "string" ? node.parent : undefined;
    }

    return path.reverse().flatMap(({ node, parent }) => {
      const message = asRecord(node.message);
      return message ? [{ message, parent }] : [];
    });
  }

  const fallbackPath: Array<{ message: JsonRecord; parent?: string }> = [];
  for (const node of Object.values(mapping)) {
    const record = asRecord(node);
    const message = asRecord(record?.message);
    if (message) {
      fallbackPath.push({
        message,
        parent: typeof record?.parent === "string" ? record.parent : undefined
      });
    }
  }
  return fallbackPath;
}

function extractMessagesFromCandidate(candidate: unknown): NormalizedMessage[] {
  const record = asRecord(candidate);
  if (!record) {
    return [];
  }

  const messages: NormalizedMessage[] = [];
  const mapping = asRecord(record.mapping);
  if (mapping) {
    messages.push(...extractFromMapping(mapping, typeof record.current_node === "string" ? record.current_node : undefined));
  }

  if (Array.isArray(record.messages)) {
    for (const item of record.messages) {
      const built = asRecord(item) ? buildMessage(item as JsonRecord) : null;
      if (built) {
        messages.push(built);
      }
    }
  }

  const messageRecord = asRecord(record.message);
  if (messageRecord) {
    const built = buildMessage(messageRecord, findStringByKeys(record, ["parent_message_id", "parent"]));
    if (built) {
      messages.push(built);
    }
  }

  return messages;
}

export class ChatGPTScraper implements IProviderScraper {
  readonly provider = "chatgpt" as const;

  matches(event: CapturedNetworkEvent): boolean {
    const url = resolveCapturedUrl(event.url, event.pageUrl);
    if (!url) {
      return false;
    }

    return isChatGPTHostname(url.hostname) && isChatGPTConversationCaptureRoute(url);
  }

  parse(event: CapturedNetworkEvent): NormalizedSessionSnapshot | null {
    const capturedUrl = resolveCapturedUrl(event.url, event.pageUrl);
    if (!capturedUrl || !isChatGPTHostname(capturedUrl.hostname) || !isChatGPTConversationCaptureRoute(capturedUrl)) {
      return null;
    }

    const requestCandidates = [event.requestBody?.json, ...extractStructuredCandidates(event.requestBody?.text)].filter(Boolean);
    const responseCandidates = [event.response.json, ...extractStructuredCandidates(event.response.text)].filter(Boolean);
    const structured = [...requestCandidates, ...responseCandidates];
    const messages: NormalizedMessage[] = [];
    let title: string | undefined;
    let externalSessionId: string | undefined =
      findStringByKeys(structured, ["conversation_id", "conversationId"]) ??
      conversationIdFromCapturedUrl(capturedUrl) ??
      sessionIdFromPageUrl(event.pageUrl) ??
      stableId("chatgpt-session", event.pageUrl);

    for (const candidate of structured) {
      const record = asRecord(candidate);
      if (!record) {
        continue;
      }

      title ??= findStringByKeys(record, ["title"]);
      externalSessionId ||= findStringByKeys(record, ["conversation_id", "conversationId"]);
      messages.push(...extractMessagesFromCandidate(record));
    }

    const normalized = dedupeMessages(messages);
    if (!normalized.length) {
      return null;
    }

    const resolvedSessionId = externalSessionId ?? stableId("chatgpt-session", event.pageUrl);

    return {
      provider: this.provider,
      externalSessionId: resolvedSessionId,
      title,
      sourceUrl: event.pageUrl,
      capturedAt: event.capturedAt,
      messages: normalized
    };
  }
}
