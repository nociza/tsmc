type JsonRecord = Record<string, unknown>;

export interface GeminiConversationBlock {
  userText: string;
  assistantText: string;
  occurredAt?: string;
}

export interface GeminiDecodeAttempt {
  strategy: string;
  blockCount: number;
}

export interface GeminiDecodeDiagnostics {
  payloadCount: number;
  payloadShape: string;
  attempts: GeminiDecodeAttempt[];
  selectedStrategy?: string;
}

export interface GeminiDecodeResult {
  blocks: GeminiConversationBlock[];
  diagnostics: GeminiDecodeDiagnostics;
}

interface GeminiDecodeStrategy {
  name: string;
  decode: (payloads: unknown[]) => GeminiConversationBlock[];
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function isGeminiTimestampPair(node: unknown): node is [number, number] {
  return (
    Array.isArray(node) &&
    node.length === 2 &&
    typeof node[0] === "number" &&
    typeof node[1] === "number" &&
    node[0] > 1_600_000_000
  );
}

function timestampPairToIso(pair: [number, number] | null): string | undefined {
  if (!pair) {
    return undefined;
  }

  return new Date(pair[0] * 1000).toISOString();
}

function getNestedArrayValue(root: unknown, path: number[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!Array.isArray(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function flattenGeminiText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => flattenGeminiText(item))
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (value && typeof value === "object") {
    return Object.values(value as JsonRecord)
      .map((item) => flattenGeminiText(item))
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return "";
}

function isStrictUserNode(node: unknown): node is unknown[] {
  return (
    Array.isArray(node) &&
    node.length >= 2 &&
    Array.isArray(node[0]) &&
    node[0].length >= 1 &&
    node[0].every((part) => typeof part === "string") &&
    (node[1] === 1 || node[1] === 2)
  );
}

function isLooseUserNode(node: unknown): node is unknown[] {
  return (
    Array.isArray(node) &&
    node.length >= 2 &&
    Array.isArray(node[0]) &&
    (node[1] === 1 || node[1] === 2) &&
    Boolean(flattenGeminiText(node[0]))
  );
}

function strictAssistantText(node: unknown): string {
  if (
    !Array.isArray(node) ||
    node.length < 2 ||
    typeof node[0] !== "string" ||
    !node[0].startsWith("rc_") ||
    !Array.isArray(node[1]) ||
    typeof node[1][0] !== "string"
  ) {
    return "";
  }

  return node[1][0].trim();
}

function looseAssistantText(node: unknown): string {
  if (!Array.isArray(node) || node.length < 2 || typeof node[0] !== "string" || !node[0].trim()) {
    return "";
  }

  return flattenGeminiText(node[1]);
}

function findAssistantNode(
  node: unknown,
  assistantTextForNode: (candidate: unknown) => string,
  depth = 0
): unknown[] | null {
  if (!Array.isArray(node) || depth > 3) {
    return null;
  }

  if (assistantTextForNode(node)) {
    return node;
  }

  for (const child of node) {
    const assistantNode = findAssistantNode(child, assistantTextForNode, depth + 1);
    if (assistantNode) {
      return assistantNode;
    }
  }

  return null;
}

function extractTurnBlock(
  node: unknown,
  options: {
    userNodeMatches: (candidate: unknown) => candidate is unknown[];
    assistantTextForNode: (candidate: unknown) => string;
  }
): GeminiConversationBlock | null {
  if (!Array.isArray(node)) {
    return null;
  }

  let userNode: unknown[] | null = null;
  let assistantNode: unknown[] | null = null;
  let timestampPair: [number, number] | null = null;

  for (const child of node) {
    if (!userNode && options.userNodeMatches(child)) {
      userNode = child;
      continue;
    }
    if (!assistantNode) {
      assistantNode = findAssistantNode(child, options.assistantTextForNode);
      if (assistantNode) {
        continue;
      }
    }
    if (isGeminiTimestampPair(child)) {
      timestampPair = child;
    }
  }

  if (!userNode || !assistantNode) {
    return null;
  }

  const userText = flattenGeminiText(userNode[0]);
  const assistantText = options.assistantTextForNode(assistantNode);
  if (!userText || !assistantText) {
    return null;
  }

  return {
    userText,
    assistantText,
    occurredAt: timestampPairToIso(timestampPair)
  };
}

function scanPayloadsForBlocks(
  payloads: unknown[],
  options: {
    userNodeMatches: (candidate: unknown) => candidate is unknown[];
    assistantTextForNode: (candidate: unknown) => string;
  }
): GeminiConversationBlock[] {
  const blocks: GeminiConversationBlock[] = [];
  const seen = new Set<string>();

  const scan = (node: unknown): void => {
    if (!Array.isArray(node)) {
      if (node && typeof node === "object") {
        for (const value of Object.values(node as JsonRecord)) {
          scan(value);
        }
      }
      return;
    }

    const block = extractTurnBlock(node, options);
    if (block) {
      const composite = `${block.userText}\n---\n${block.assistantText}\n---\n${block.occurredAt ?? ""}`;
      if (!seen.has(composite)) {
        seen.add(composite);
        blocks.push(block);
      }
    }

    for (const child of node) {
      scan(child);
    }
  };

  for (const payload of payloads) {
    scan(payload);
  }

  return blocks.sort((left, right) => {
    const leftTime = left.occurredAt ? Date.parse(left.occurredAt) : Number.MAX_SAFE_INTEGER;
    const rightTime = right.occurredAt ? Date.parse(right.occurredAt) : Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.userText.localeCompare(right.userText);
  });
}

function decodeStrictTurnBlocks(payloads: unknown[]): GeminiConversationBlock[] {
  return scanPayloadsForBlocks(payloads, {
    userNodeMatches: isStrictUserNode,
    assistantTextForNode: strictAssistantText
  });
}

function decodeLooseTurnBlocks(payloads: unknown[]): GeminiConversationBlock[] {
  return scanPayloadsForBlocks(payloads, {
    userNodeMatches: isLooseUserNode,
    assistantTextForNode: looseAssistantText
  });
}

function decodeNestedPathFallback(payloads: unknown[]): GeminiConversationBlock[] {
  const blocks: GeminiConversationBlock[] = [];
  const seen = new Set<string>();

  const scan = (node: unknown): void => {
    if (!Array.isArray(node)) {
      if (node && typeof node === "object") {
        for (const value of Object.values(node as JsonRecord)) {
          scan(value);
        }
      }
      return;
    }

    const userText = flattenGeminiText(getNestedArrayValue(node, [2, 0, 0]));
    const assistantText =
      flattenGeminiText(getNestedArrayValue(node, [3, 0, 1, 0])) ||
      flattenGeminiText(getNestedArrayValue(node, [3, 0, 22, 0]));

    if (userText && assistantText) {
      const composite = `${userText}\n---\n${assistantText}`;
      if (!seen.has(composite)) {
        seen.add(composite);
        blocks.push({
          userText,
          assistantText
        });
      }
    }

    for (const child of node) {
      scan(child);
    }
  };

  for (const payload of payloads) {
    scan(payload);
  }

  return blocks;
}

function messageRole(value: unknown): "user" | "assistant" | null {
  if (value === "user" || value === "human") {
    return "user";
  }
  if (value === "assistant" || value === "model" || value === "bot") {
    return "assistant";
  }
  return null;
}

function messageContent(record: JsonRecord): string {
  return flattenGeminiText(record.content ?? record.text ?? record.parts ?? record.message ?? record.body);
}

function decodeExplicitMessageObjects(payloads: unknown[]): GeminiConversationBlock[] {
  const blocks: GeminiConversationBlock[] = [];

  const scan = (node: unknown): void => {
    const record = asRecord(node);
    if (record && Array.isArray(record.messages)) {
      let pendingUserText = "";
      let pendingOccurredAt: string | undefined;

      for (const item of record.messages) {
        const itemRecord = asRecord(item);
        if (!itemRecord) {
          continue;
        }

        const role = messageRole(itemRecord.role ?? itemRecord.sender ?? itemRecord.author);
        const content = messageContent(itemRecord);
        if (!role || !content) {
          continue;
        }

        if (role === "user") {
          pendingUserText = content;
          pendingOccurredAt = typeof itemRecord.occurredAt === "string" ? itemRecord.occurredAt : undefined;
          continue;
        }

        if (pendingUserText) {
          blocks.push({
            userText: pendingUserText,
            assistantText: content,
            occurredAt: pendingOccurredAt
          });
          pendingUserText = "";
          pendingOccurredAt = undefined;
        }
      }
    }

    if (Array.isArray(node)) {
      for (const child of node) {
        scan(child);
      }
      return;
    }

    if (record) {
      for (const value of Object.values(record)) {
        scan(value);
      }
    }
  };

  for (const payload of payloads) {
    scan(payload);
  }

  return blocks;
}

function shapeOf(value: unknown, depth = 0): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    if (depth >= 3) {
      return `array(${value.length})`;
    }
    return `array(${value.length})[${value
      .slice(0, 5)
      .map((item) => shapeOf(item, depth + 1))
      .join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as JsonRecord;
    if (depth >= 3) {
      return `object(${Object.keys(record).length})`;
    }
    return `object{${Object.keys(record)
      .sort()
      .slice(0, 8)
      .map((key) => `${key}:${shapeOf(record[key], depth + 1)}`)
      .join(",")}}`;
  }
  return typeof value;
}

function payloadShape(payloads: unknown[]): string {
  return payloads
    .slice(0, 3)
    .map((payload) => shapeOf(payload))
    .join("|")
    .slice(0, 700);
}

const geminiDecodeStrategies: GeminiDecodeStrategy[] = [
  {
    name: "strict-turn-block-v1",
    decode: decodeStrictTurnBlocks
  },
  {
    name: "loose-turn-block-v1",
    decode: decodeLooseTurnBlocks
  },
  {
    name: "nested-path-fallback-v1",
    decode: decodeNestedPathFallback
  },
  {
    name: "explicit-message-objects-v1",
    decode: decodeExplicitMessageObjects
  }
];

export function decodeGeminiConversationBlocks(payloads: unknown[]): GeminiDecodeResult {
  const attempts: GeminiDecodeAttempt[] = [];

  for (const strategy of geminiDecodeStrategies) {
    const blocks = strategy.decode(payloads);
    attempts.push({
      strategy: strategy.name,
      blockCount: blocks.length
    });
    if (blocks.length) {
      return {
        blocks,
        diagnostics: {
          payloadCount: payloads.length,
          payloadShape: payloadShape(payloads),
          attempts,
          selectedStrategy: strategy.name
        }
      };
    }
  }

  return {
    blocks: [],
    diagnostics: {
      payloadCount: payloads.length,
      payloadShape: payloadShape(payloads),
      attempts
    }
  };
}

export function formatGeminiDecodeDiagnostics(diagnostics: GeminiDecodeDiagnostics): string {
  const attempts = diagnostics.attempts
    .map((attempt) => `${attempt.strategy}:${attempt.blockCount}`)
    .join(",");
  const selected = diagnostics.selectedStrategy ? ` selected=${diagnostics.selectedStrategy}` : "";
  return `payloads=${diagnostics.payloadCount}${selected} attempts=${attempts || "none"} shape=${diagnostics.payloadShape || "empty"}`;
}
