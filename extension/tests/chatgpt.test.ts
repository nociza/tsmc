import { describe, expect, it } from "vitest";

import { ChatGPTScraper } from "../src/providers/chatgpt";
import type { CapturedNetworkEvent } from "../src/shared/types";

describe("ChatGPTScraper", () => {
  it("extracts messages from conversation mapping payloads", () => {
    const scraper = new ChatGPTScraper();
    const event: CapturedNetworkEvent = {
      source: "savemycontext-network-observer",
      providerHint: "chatgpt",
      pageUrl: "https://chatgpt.com/c/abc123",
      requestId: "req-1",
      method: "GET",
      url: "https://chatgpt.com/backend-api/conversation/abc123",
      capturedAt: "2026-03-30T10:00:00.000Z",
      response: {
        status: 200,
        ok: true,
        contentType: "application/json",
        text: "",
        json: {
          conversation_id: "abc123",
          title: "Test Conversation",
          mapping: {
            one: {
              id: "one",
              message: {
                id: "msg-1",
                author: { role: "user" },
                create_time: 1711792800,
                content: { parts: ["Plan this project."] }
              }
            },
            two: {
              id: "two",
              parent: "msg-1",
              message: {
                id: "msg-2",
                author: { role: "assistant" },
                create_time: 1711792810,
                content: { parts: ["Start with the backend contract."] }
              }
            }
          }
        }
      }
    };

    const snapshot = scraper.parse(event);
    expect(snapshot?.externalSessionId).toBe("abc123");
    expect(snapshot?.title).toBe("Test Conversation");
    expect(snapshot?.messages).toHaveLength(2);
    expect(snapshot?.messages[0]?.role).toBe("user");
    expect(snapshot?.messages[1]?.parentId).toBe("msg-1");
  });
});

