import type { MessageRole, NormalizedMessage } from "../shared/types";

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function resolveCapturedUrl(url: string, pageUrl: string): URL | null {
  try {
    return new URL(url, pageUrl);
  } catch {
    return null;
  }
}

export function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function extractStructuredCandidates(value?: unknown): unknown[] {
  if (typeof value !== "string" || !value) {
    return [];
  }

  const text = value;
  const candidates: unknown[] = [];
  const direct = safeJsonParse(text);
  if (direct !== null) {
    candidates.push(direct);
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith("data:")) {
      const payload = trimmed.slice(5).trim();
      if (payload && payload !== "[DONE]") {
        const parsed = safeJsonParse(payload);
        if (parsed !== null) {
          candidates.push(parsed);
        }
      }
      continue;
    }

    if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("\"[{")) {
      const parsed = safeJsonParse(trimmed);
      if (parsed !== null) {
        candidates.push(parsed);
      }
    }
  }

  return candidates;
}

export function collectStrings(value: unknown, bucket = new Set<string>()): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      bucket.add(trimmed);
      const parsed = safeJsonParse(trimmed);
      if (parsed !== null) {
        collectStrings(parsed, bucket);
      }
    }
    return [...bucket];
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, bucket);
    }
    return [...bucket];
  }

  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectStrings(nested, bucket);
    }
  }

  return [...bucket];
}

export function flattenText(value: unknown): string {
  if (typeof value === "string") {
    return normalizeWhitespace(value);
  }

  if (Array.isArray(value)) {
    return value.map(flattenText).filter(Boolean).join("\n");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  const fragments: string[] = [];
  for (const key of ["text", "content", "body", "message", "value", "markdown", "parts", "chunks"]) {
    if (key in record) {
      const fragment = flattenText(record[key]);
      if (fragment) {
        fragments.push(fragment);
      }
    }
  }

  if (fragments.length) {
    return fragments.join("\n");
  }

  return collectStrings(record)
    .map(normalizeWhitespace)
    .filter(Boolean)
    .slice(0, 3)
    .join("\n");
}

export function normalizeRole(value: unknown): MessageRole {
  const role = typeof value === "string" ? value.toLowerCase() : "";
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

export function coerceOccurredAt(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    return new Date(milliseconds).toISOString();
  }

  if (typeof value === "string" && value.trim()) {
    const candidate = new Date(value);
    if (!Number.isNaN(candidate.getTime())) {
      return candidate.toISOString();
    }
  }

  return undefined;
}

export function findStringByKeys(value: unknown, keys: string[]): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nestedResult = findStringByKeys(item, keys);
      if (nestedResult) {
        return nestedResult;
      }
    }
    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  for (const nested of Object.values(record)) {
    const nestedResult = findStringByKeys(nested, keys);
    if (nestedResult) {
      return nestedResult;
    }
  }

  return undefined;
}

export function sessionIdFromPageUrl(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    const conversationIndex = segments.findIndex((segment) =>
      ["c", "chat", "conversation", "conversations", "app", "immersive"].includes(segment)
    );
    if (conversationIndex >= 0 && segments[conversationIndex + 1]) {
      return segments[conversationIndex + 1];
    }

    const longSegment = [...segments].reverse().find((segment) => segment.length >= 8);
    return longSegment ?? null;
  } catch {
    return null;
  }
}

export function pickLikelyText(strings: string[], preferLast = true): string | null {
  const candidates = strings
    .map(normalizeWhitespace)
    .filter((value) => /[A-Za-z]/.test(value) && /\s/.test(value) && value.length >= 12)
    .filter((value) => !value.startsWith("http") && !/^[\[\{].*[\]\}]$/.test(value));

  if (!candidates.length) {
    return null;
  }

  const scored = candidates.map((value, index) => ({
    value,
    score:
      value.length +
      (value.match(/\s/g)?.length ?? 0) * 2 +
      (preferLast ? index : candidates.length - index)
  }));
  scored.sort((left, right) => right.score - left.score);
  return scored[0]?.value ?? null;
}

export function stableId(prefix: string, source: string): string {
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) >>> 0;
  }
  return `${prefix}-${hash.toString(16)}`;
}

export function dedupeMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  const seen = new Map<string, NormalizedMessage>();
  for (const message of messages) {
    if (!message.content.trim()) {
      continue;
    }
    seen.set(message.id, message);
  }
  return [...seen.values()];
}

export function sortMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  return [...messages].sort((left, right) => {
    const leftTime = left.occurredAt ? Date.parse(left.occurredAt) : Number.MAX_SAFE_INTEGER;
    const rightTime = right.occurredAt ? Date.parse(right.occurredAt) : Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.id.localeCompare(right.id);
  });
}
