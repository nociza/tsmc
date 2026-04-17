import { describe, expect, it } from "vitest";

import { decodeGeminiConversationBlocks, formatGeminiDecodeDiagnostics } from "../src/injected/gemini-decoder";

function buildStrictTurnBlock(
  userText: string,
  assistantText: string,
  timestampSeconds: number,
  assistantId = "rc_test"
): unknown[] {
  return [
    [[userText], 2],
    [[[assistantId, [assistantText]]]],
    [timestampSeconds, 1]
  ];
}

describe("Gemini history decoder", () => {
  it("decodes the strict Gemini turn block shape", () => {
    const result = decodeGeminiConversationBlocks([[buildStrictTurnBlock("Prompt", "Reply", 1711842000)]]);

    expect(result.blocks).toEqual([
      {
        userText: "Prompt",
        assistantText: "Reply",
        occurredAt: "2024-03-30T23:40:00.000Z"
      }
    ]);
    expect(result.diagnostics.selectedStrategy).toBe("strict-turn-block-v1");
  });

  it("falls back to the loose turn decoder for renamed assistant ids and nested user parts", () => {
    const result = decodeGeminiConversationBlocks([
      [
        [
          [["Summarize this", ["attachment name"]], 2],
          [[["response_1", [["Nested", "reply"]]]]],
          [1711842060, 1]
        ]
      ]
    ]);

    expect(result.blocks).toEqual([
      {
        userText: "Summarize this\nattachment name",
        assistantText: "Nested\nreply",
        occurredAt: "2024-03-30T23:41:00.000Z"
      }
    ]);
    expect(result.diagnostics.selectedStrategy).toBe("loose-turn-block-v1");
  });

  it("can decode explicit message object payloads when Gemini returns structured records", () => {
    const result = decodeGeminiConversationBlocks([
      {
        messages: [
          { role: "user", content: "Object prompt", occurredAt: "2026-04-01T12:00:00.000Z" },
          { role: "model", content: "Object reply" }
        ]
      }
    ]);

    expect(result.blocks).toEqual([
      {
        userText: "Object prompt",
        assistantText: "Object reply",
        occurredAt: "2026-04-01T12:00:00.000Z"
      }
    ]);
    expect(result.diagnostics.selectedStrategy).toBe("explicit-message-objects-v1");
  });

  it("returns strategy diagnostics when no decoder matches", () => {
    const result = decodeGeminiConversationBlocks([{ unexpected: ["shape"] }]);

    expect(result.blocks).toEqual([]);
    expect(result.diagnostics.attempts.map((attempt) => attempt.strategy)).toEqual([
      "strict-turn-block-v1",
      "loose-turn-block-v1",
      "nested-path-fallback-v1",
      "explicit-message-objects-v1"
    ]);
    expect(formatGeminiDecodeDiagnostics(result.diagnostics)).toContain("payloads=1");
    expect(formatGeminiDecodeDiagnostics(result.diagnostics)).toContain("attempts=strict-turn-block-v1:0");
    expect(result.diagnostics.payloadShape).toContain("unexpected");
  });
});
