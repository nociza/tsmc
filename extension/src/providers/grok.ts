import type { CapturedNetworkEvent, NormalizedMessage, NormalizedSessionSnapshot } from "../shared/types";
import type { IProviderScraper } from "./provider";
import {
  coerceOccurredAt,
  collectStrings,
  dedupeMessages,
  extractStructuredCandidates,
  findStringByKeys,
  flattenText,
  normalizeRole,
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

function buildExplicitMessage(item: unknown, index: number, externalSessionId: string): NormalizedMessage | null {
  const record = asRecord(item);
  if (!record) {
    return null;
  }

  const role = normalizeRole(record.role ?? record.sender ?? record.author);
  const content = flattenText(record.content ?? record.message ?? record.query ?? record.text ?? record.body);
  if (!content) {
    return null;
  }

  const explicitId = typeof record.id === "string" && record.id.trim() ? record.id.trim() : undefined;
  const parentId =
    typeof record.parentId === "string" && record.parentId.trim()
      ? record.parentId.trim()
      : typeof record.parentResponseId === "string" && record.parentResponseId.trim()
        ? record.parentResponseId.trim()
        : typeof record.parent_id === "string" && record.parent_id.trim()
          ? record.parent_id.trim()
          : typeof record.threadParentId === "string" && record.threadParentId.trim()
            ? record.threadParentId.trim()
            : undefined;

  return {
    id: explicitId ?? stableId("grok-msg", `${externalSessionId}:${role}:${index}:${content}`),
    parentId,
    role,
    content,
    occurredAt: coerceOccurredAt(record.occurredAt ?? record.occurred_at ?? record.createdAt ?? record.createTime),
    raw: record
  };
}

function buildGenericMessage(value: unknown): NormalizedMessage | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const role = normalizeRole(record.role ?? record.sender ?? record.author);
  const content = flattenText(record.content ?? record.text ?? record.body ?? record.message);
  if (!content) {
    return null;
  }

  return {
    id:
      (typeof record.id === "string" ? record.id : undefined) ??
      stableId("grok-msg", `${role}:${content}`),
    parentId:
      (typeof record.parentId === "string" ? record.parentId : undefined) ??
      (typeof record.parent_id === "string" ? record.parent_id : undefined),
    role,
    content,
    occurredAt:
      typeof record.createdAt === "string"
        ? record.createdAt
        : typeof record.created_at === "string"
          ? record.created_at
          : undefined,
    raw: record
  };
}

export class GrokScraper implements IProviderScraper {
  readonly provider = "grok" as const;

  matches(event: CapturedNetworkEvent): boolean {
    const url = resolveCapturedUrl(event.url, event.pageUrl);
    if (!url) {
      return false;
    }

    return /grok\.com|x\.com/.test(url.hostname) && /app-chat|conversation|grok|chat/i.test(url.pathname + url.search);
  }

  parse(event: CapturedNetworkEvent): NormalizedSessionSnapshot | null {
    const requestCandidates = [event.requestBody?.json, ...extractStructuredCandidates(event.requestBody?.text)].filter(Boolean);
    const responseCandidates = [event.response.json, ...extractStructuredCandidates(event.response.text)].filter(Boolean);
    const structured = [...requestCandidates, ...responseCandidates];

    const messages: NormalizedMessage[] = [];
    let title = findStringByKeys(structured, ["title", "conversationTitle"]);
    const externalSessionId =
      findStringByKeys(structured, ["conversationId", "conversation_id"]) ??
      event.url.match(/conversations\/([^/?]+)/)?.[1] ??
      sessionIdFromPageUrl(event.pageUrl) ??
      stableId("grok-session", event.pageUrl);

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

    for (const candidate of structured) {
      const record = asRecord(candidate);
      if (!record) {
        continue;
      }

      title ??= findStringByKeys(record, ["title", "conversationTitle"]);
      for (const key of ["messages", "items", "conversationItems", "entries"]) {
        const value = record[key];
        if (Array.isArray(value)) {
          for (const item of value) {
            const built = buildGenericMessage(item);
            if (built) {
              messages.push(built);
            }
          }
        }
      }

      const direct = buildGenericMessage(record.message ?? record);
      if (direct) {
        messages.push(direct);
      }
    }

    if (!messages.length) {
      const prompt = pickLikelyText(requestCandidates.flatMap((value) => collectStrings(value)), false);
      const reply = pickLikelyText(responseCandidates.flatMap((value) => collectStrings(value)), true);
      if (prompt) {
        messages.push({
          id: stableId("grok-user", `${event.requestId}:${prompt}`),
          role: "user",
          content: prompt,
          occurredAt: event.capturedAt,
          raw: requestCandidates[0]
        });
      }
      if (reply) {
        messages.push({
          id: stableId("grok-assistant", `${event.requestId}:${reply}`),
          role: "assistant",
          content: reply,
          occurredAt: event.capturedAt,
          raw: responseCandidates[0]
        });
      }
    }

    const normalized = sortMessages(dedupeMessages(messages));
    if (!normalized.length) {
      return null;
    }

    return {
      provider: this.provider,
      externalSessionId,
      title,
      sourceUrl: event.pageUrl,
      capturedAt: event.capturedAt,
      messages: normalized
    };
  }
}
