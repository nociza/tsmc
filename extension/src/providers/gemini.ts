import type { CapturedNetworkEvent, NormalizedMessage, NormalizedSessionSnapshot } from "../shared/types";
import type { IProviderScraper } from "./provider";
import {
  coerceOccurredAt,
  collectStrings,
  dedupeMessages,
  extractStructuredCandidates,
  findStringByKeys,
  pickLikelyText,
  resolveCapturedUrl,
  sessionIdFromPageUrl,
  sortMessages,
  stableId
} from "./helpers";

type JsonRecord = Record<string, unknown>;

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

function buildExplicitMessage(item: unknown, index: number, externalSessionId: string): NormalizedMessage | null {
  const record = asRecord(item);
  if (!record) {
    return null;
  }

  const contentCandidate =
    typeof record.content === "string"
      ? record.content
      : typeof record.text === "string"
        ? record.text
        : Array.isArray(record.parts)
          ? record.parts.filter((part): part is string => typeof part === "string").join("\n")
          : "";
  const content = contentCandidate.trim();
  if (!content) {
    return null;
  }

  const role =
    record.role === "user" || record.role === "assistant" || record.role === "system" || record.role === "tool"
      ? record.role
      : "unknown";
  const explicitId = typeof record.id === "string" && record.id.trim() ? record.id.trim() : undefined;
  const parentId = typeof record.parentId === "string" && record.parentId.trim() ? record.parentId.trim() : undefined;

  return {
    id: explicitId ?? stableId("gemini-msg", `${externalSessionId}:${role}:${index}:${content}`),
    parentId,
    role,
    content,
    occurredAt: coerceOccurredAt(record.occurredAt ?? record.occurred_at ?? record.createdAt ?? record.create_time),
    raw: record
  };
}

function parseRequestBody(body?: unknown): unknown[] {
  if (typeof body !== "string" || !body) {
    return [];
  }

  const candidates = [...extractStructuredCandidates(body)];
  try {
    const params = new URLSearchParams(body);
    const encoded = params.get("f.req");
    if (encoded) {
      const parsed = JSON.parse(encoded);
      candidates.push(parsed);
    }
  } catch {
    // Gemini request formats vary and often are not clean URLSearchParams payloads.
  }

  return candidates;
}

export class GeminiScraper implements IProviderScraper {
  readonly provider = "gemini" as const;

  matches(event: CapturedNetworkEvent): boolean {
    const url = resolveCapturedUrl(event.url, event.pageUrl);
    if (!url) {
      return false;
    }

    return /gemini\.google\.com/.test(url.hostname) && /batchexecute|BardFrontendService|StreamGenerate|conversation/i.test(url.pathname + url.search);
  }

  parse(event: CapturedNetworkEvent): NormalizedSessionSnapshot | null {
    const requestCandidates = [
      event.requestBody?.json,
      ...parseRequestBody(event.requestBody?.text)
    ].filter(Boolean);
    const responseCandidates = [
      event.response.json,
      ...extractStructuredCandidates(event.response.text)
    ].filter(Boolean);

    const title =
      findStringByKeys(responseCandidates, ["title", "conversationTitle"]) ??
      findStringByKeys(requestCandidates, ["title", "conversationTitle"]);
    const externalSessionId =
      normalizeGeminiConversationId(findStringByKeys(responseCandidates, ["conversationId", "conversation_id", "chat_id"])) ??
      normalizeGeminiConversationId(findStringByKeys(requestCandidates, ["conversationId", "conversation_id", "chat_id"])) ??
      normalizeGeminiConversationId(sessionIdFromPageUrl(event.pageUrl)) ??
      stableId("gemini-session", event.pageUrl);

    const explicitMessages = dedupeMessages(
      responseCandidates.flatMap((candidate) => {
        const record = asRecord(candidate);
        if (!record || !Array.isArray(record.messages)) {
          return [];
        }

        return record.messages
          .map((message, index) => buildExplicitMessage(message, index, externalSessionId))
          .filter((message): message is NormalizedMessage => Boolean(message));
      })
    );

    if (explicitMessages.length) {
      return {
        provider: this.provider,
        externalSessionId,
        title,
        sourceUrl: event.pageUrl,
        capturedAt: event.capturedAt,
        messages: sortMessages(explicitMessages)
      };
    }

    const prompt = pickLikelyText(requestCandidates.flatMap((value) => collectStrings(value)), false);
    const reply = pickLikelyText(responseCandidates.flatMap((value) => collectStrings(value)), true);

    const messages = dedupeMessages(
      [
        prompt
          ? {
              id: stableId("gemini-user", `${event.requestId}:${prompt}`),
              role: "user" as const,
              content: prompt,
              occurredAt: event.capturedAt,
              raw: requestCandidates[0]
            }
          : null,
        reply
          ? {
              id: stableId("gemini-assistant", `${event.requestId}:${reply}`),
              role: "assistant" as const,
              content: reply,
              occurredAt: event.capturedAt,
              raw: responseCandidates[0]
            }
          : null
      ].filter(Boolean) as NonNullable<NormalizedSessionSnapshot["messages"][number]>[]
    );

    if (!messages.length) {
      return null;
    }

    return {
      provider: this.provider,
      externalSessionId,
      title,
      sourceUrl: event.pageUrl,
      capturedAt: event.capturedAt,
      messages: sortMessages(messages)
    };
  }
}
