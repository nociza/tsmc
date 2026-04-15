import { describe, expect, it } from "vitest";

import {
  buildProcessingRepairPrompt,
  extractFirstBalancedJsonObject,
  normalizePartialProcessingResponseJson,
  normalizeProcessingResponseJson
} from "../src/injected/proxy-json";

describe("proxy-json", () => {
  it("extracts the first balanced JSON object from surrounding text", () => {
    const value = 'Here is the result:\n```json\n{"category":"journal","journal":{"entry":"hello"}}\n```\nDone.';

    expect(extractFirstBalancedJsonObject(value)).toBe('{"category":"journal","journal":{"entry":"hello"}}');
  });

  it("handles escaped quotes and nested objects", () => {
    const value =
      '{"category":"journal","classification_reason":"He said \\"ship it\\".","journal":{"entry":"nested","action_items":["one"]},"factual_triplets":[],"idea":null}';

    expect(extractFirstBalancedJsonObject(value)).toBe(value);
  });

  it("returns null for truncated JSON", () => {
    const value = '{"category":"journal","journal":{"entry":"unfinished"}';

    expect(extractFirstBalancedJsonObject(value)).toBeNull();
  });

  it("builds a repair prompt with the backend error and previous response", () => {
    const prompt = buildProcessingRepairPrompt('{"category":"journal"', "Could not parse JSON", [
      { sessionId: "session-a", taskKey: "task_1" },
      { sessionId: "session-b", taskKey: "task_2" }
    ]);

    expect(prompt).toContain("Could not parse JSON");
    expect(prompt).toContain('{"category":"journal"');
    expect(prompt).toContain("return exactly one valid JSON object");
    expect(prompt).toContain("Return compact minified JSON only.");
    expect(prompt).toContain("Expected task_keys: task_1, task_2");
  });

  it("normalizes a valid batched processing response to canonical JSON", () => {
    const normalized = normalizeProcessingResponseJson(
      '```json\n{"results":[{"session_id":"session-a","category":"journal","classification_reason":"ok","journal":{"entry":"hello","action_items":[]},"factual_triplets":[],"idea":null}]}\n```',
      ["session-a"]
    );

    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.jsonText).toContain('"session_id":"session-a"');
      expect(normalized.jsonText).toContain('"task_key":"task_1"');
    }
  });

  it("rejects truncated processing JSON before it reaches the backend", () => {
    const normalized = normalizeProcessingResponseJson(
      '{"results":[{"session_id":"session-a","category":"journal","classification_reason":"unterminated',
      ["session-a"]
    );

    expect(normalized.ok).toBe(false);
    if (!normalized.ok) {
      expect(normalized.error).toContain("Could not parse the processing response as valid JSON");
      expect(normalized.error).toContain("complete JSON object");
    }
  });

  it("rejects multi-session batched responses that do not include the expected session ids", () => {
    const normalized = normalizeProcessingResponseJson(
      '{"results":[{"session_id":"wrong-session","category":"journal","classification_reason":"ok","journal":{"entry":"hello","action_items":[]},"factual_triplets":[],"idea":null}]}',
      [
        { sessionId: "session-a", taskKey: "task_1" },
        { sessionId: "session-b", taskKey: "task_2" }
      ]
    );

    expect(normalized.ok).toBe(false);
    if (!normalized.ok) {
      expect(normalized.error).toContain("exactly these task_keys or session_ids: task_1");
    }
  });

  it("maps task_key replies back to the expected session ids", () => {
    const normalized = normalizeProcessingResponseJson(
      '{"results":[{"task_key":"task_1","category":"journal","classification_reason":"ok","journal":{"entry":"hello","action_items":[]},"factual_triplets":[],"idea":null}]}',
      [{ sessionId: "session-a", taskKey: "task_1" }]
    );

    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.jsonText).toContain('"session_id":"session-a"');
      expect(normalized.jsonText).toContain('"task_key":"task_1"');
    }
  });

  it("coerces a single-result reply onto the expected session id", () => {
    const normalized = normalizeProcessingResponseJson(
      '{"results":[{"session_id":"made-up-id","category":"journal","classification_reason":"ok","journal":{"entry":"hello","action_items":[]},"factual_triplets":[],"idea":null}]}',
      [{ sessionId: "session-a", taskKey: "task_1" }]
    );

    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.jsonText).toContain('"session_id":"session-a"');
    }
  });

  it("extracts a recoverable subset when a batched reply omits one task", () => {
    const normalized = normalizePartialProcessingResponseJson(
      '{"results":[{"task_key":"task_1","category":"journal","classification_reason":"ok","journal":{"entry":"hello","action_items":[]},"factual_triplets":[],"idea":null}]}',
      [
        { sessionId: "session-a", taskKey: "task_1" },
        { sessionId: "session-b", taskKey: "task_2" }
      ]
    );

    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.tasks).toEqual([{ sessionId: "session-a", taskKey: "task_1" }]);
      expect(normalized.jsonText).toContain('"session_id":"session-a"');
      expect(normalized.jsonText).not.toContain('"session_id":"session-b"');
    }
  });
});
