import { describe, expect, it } from "vitest";

import { GeminiScraper } from "../src/providers/gemini";
import type { CapturedNetworkEvent } from "../src/shared/types";

describe("GeminiScraper", () => {
  it("parses proactive history sync payloads with explicit messages", () => {
    const scraper = new GeminiScraper();

    const event: CapturedNetworkEvent = {
      source: "tsmc-network-observer",
      providerHint: "gemini",
      pageUrl: "https://gemini.google.com/app/gemini-e2e-session",
      requestId: "req-gemini-history-1",
      method: "POST",
      url: "https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb",
      capturedAt: "2026-04-01T12:00:00.000Z",
      requestBody: {
        text: "f.req=%5B%5D&at=e2e-token&"
      },
      response: {
        status: 200,
        ok: true,
        contentType: "application/json",
        text: `)]}'
42
[["wrb.fr","hNvQHb","[]",null,null,null,"generic"]]
`,
        json: {
          conversationId: "c_gemini-e2e-session",
          title: "Gemini E2E Sync",
          messages: [
            {
              id: "msg-user-1",
              role: "user",
              content: "Explain proactive Gemini history sync.",
              occurredAt: "2026-04-01T11:59:00.000Z"
            },
            {
              id: "msg-assistant-1",
              parentId: "msg-user-1",
              role: "assistant",
              content: "It fetches historical Gemini chats through batchexecute and imports them automatically.",
              occurredAt: "2026-04-01T11:59:05.000Z"
            }
          ]
        }
      }
    };

    const snapshot = scraper.parse(event);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.externalSessionId).toBe("gemini-e2e-session");
    expect(snapshot?.title).toBe("Gemini E2E Sync");
    expect(snapshot?.messages.map((message) => message.id)).toEqual(["msg-user-1", "msg-assistant-1"]);
    expect(snapshot?.messages.map((message) => message.content)).toEqual([
      "Explain proactive Gemini history sync.",
      "It fetches historical Gemini chats through batchexecute and imports them automatically."
    ]);
    expect(snapshot?.messages[1]?.parentId).toBe("msg-user-1");
  });

  it("ignores non-string request and response text payloads without throwing", () => {
    const scraper = new GeminiScraper();

    const event = {
      source: "tsmc-network-observer",
      providerHint: "gemini",
      pageUrl: "https://gemini.google.com/app/runtime-shape-test",
      requestId: "req-gemini-runtime-shape",
      method: "POST",
      url: "/_/BardFrontendService/StreamGenerate?rpcids=runtimeShape",
      capturedAt: "2026-04-01T12:00:00.000Z",
      requestBody: {
        text: { unexpected: true } as unknown as string
      },
      response: {
        status: 200,
        ok: true,
        contentType: "application/json",
        text: [{ not: "a string" }] as unknown as string,
        json: {
          conversationId: "c_runtime-shape-test",
          messages: [
            {
              id: "msg-user-shape",
              role: "user",
              content: "Test prompt"
            },
            {
              id: "msg-assistant-shape",
              role: "assistant",
              content: "Test reply"
            }
          ]
        }
      }
    } satisfies CapturedNetworkEvent;

    const snapshot = scraper.parse(event);

    expect(() => scraper.parse(event)).not.toThrow();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.messages).toHaveLength(2);
    expect(snapshot?.messages.map((message) => message.id).sort()).toEqual([
      "msg-assistant-shape",
      "msg-user-shape"
    ]);
  });
});
