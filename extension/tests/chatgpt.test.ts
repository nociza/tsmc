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

  it("keeps only user-visible messages from the active ChatGPT mapping path", () => {
    const scraper = new ChatGPTScraper();
    const event: CapturedNetworkEvent = {
      source: "savemycontext-network-observer",
      providerHint: "chatgpt",
      pageUrl: "https://chatgpt.com/c/current-session",
      requestId: "req-current-1",
      method: "GET",
      url: "https://chatgpt.com/backend-api/conversation/current-session",
      capturedAt: "2026-04-16T18:00:00.000Z",
      response: {
        status: 200,
        ok: true,
        contentType: "application/json",
        text: "",
        json: {
          conversation_id: "current-session",
          current_node: "reasoning-node",
          mapping: {
            root: { id: "root", message: null, parent: null },
            "user-node": {
              id: "user-node",
              parent: "root",
              message: {
                id: "user-msg",
                author: { role: "user" },
                create_time: 1776194532,
                content: {
                  content_type: "multimodal_text",
                  parts: [
                    {
                      content_type: "image_asset_pointer",
                      asset_pointer: "sediment://file_00000000000000000000000000000000"
                    },
                    "What are the color codes?"
                  ]
                }
              }
            },
            "python-call": {
              id: "python-call",
              parent: "user-node",
              message: {
                id: "assistant-code",
                author: { role: "assistant" },
                recipient: "python",
                create_time: 1776194533,
                content: { content_type: "code", parts: ["from PIL import Image"] }
              }
            },
            "tool-output": {
              id: "tool-output",
              parent: "python-call",
              message: {
                id: "tool-output-msg",
                author: { role: "tool", name: "python" },
                create_time: 1776194534,
                content: { content_type: "text", parts: ["#008AFC"] }
              }
            },
            "assistant-final": {
              id: "assistant-final",
              parent: "tool-output",
              message: {
                id: "assistant-msg",
                author: { role: "assistant" },
                recipient: "all",
                channel: "final",
                create_time: 1776194535,
                metadata: { parent_id: "user-msg" },
                content: { content_type: "text", parts: ["The colors are #008AFC and #44C3FD."] }
              }
            },
            "reasoning-node": {
              id: "reasoning-node",
              parent: "assistant-final",
              message: {
                id: "reasoning-msg",
                author: { role: "assistant" },
                recipient: "all",
                create_time: 1776194536,
                content: { content_type: "reasoning_recap", parts: ["Thought for 14s"] }
              }
            },
            "alternate-branch": {
              id: "alternate-branch",
              parent: "user-node",
              message: {
                id: "alternate-msg",
                author: { role: "assistant" },
                recipient: "all",
                create_time: 1776194537,
                content: { content_type: "text", parts: ["Discarded branch."] }
              }
            }
          }
        }
      }
    };

    const snapshot = scraper.parse(event);

    expect(snapshot?.externalSessionId).toBe("current-session");
    expect(snapshot?.messages.map((message) => message.id)).toEqual(["user-msg", "assistant-msg"]);
    expect(snapshot?.messages.map((message) => message.content)).toEqual([
      "What are the color codes?",
      "The colors are #008AFC and #44C3FD."
    ]);
    expect(snapshot?.messages[1]?.parentId).toBe("user-msg");
  });

  it("captures user requests and assistant SSE messages from the current conversation route", () => {
    const scraper = new ChatGPTScraper();
    const event: CapturedNetworkEvent = {
      source: "savemycontext-network-observer",
      providerHint: "chatgpt",
      pageUrl: "https://chatgpt.com/c/stream-session",
      requestId: "req-stream-1",
      method: "POST",
      url: "https://chatgpt.com/backend-api/conversation",
      capturedAt: "2026-04-16T18:00:00.000Z",
      requestBody: {
        json: {
          conversation_id: "stream-session",
          messages: [
            {
              id: "request-user-msg",
              author: { role: "user" },
              content: { content_type: "text", parts: ["Say hello."] }
            }
          ]
        }
      },
      response: {
        status: 200,
        ok: true,
        contentType: "text/event-stream",
        text:
          'data: {"conversation_id":"stream-session","message":{"id":"assistant-stream-msg","author":{"role":"assistant"},"recipient":"all","metadata":{"parent_id":"request-user-msg"},"content":{"content_type":"text","parts":["Hello there."]}}}\n\n' +
          "data: [DONE]\n",
        json: undefined
      }
    };

    const snapshot = scraper.parse(event);

    expect(snapshot?.externalSessionId).toBe("stream-session");
    expect(snapshot?.messages.map((message) => message.content)).toEqual(["Say hello.", "Hello there."]);
    expect(snapshot?.messages[1]?.parentId).toBe("request-user-msg");
  });

  it("rejects ChatGPT history list payloads and deceptive hosts", () => {
    const scraper = new ChatGPTScraper();
    const listEvent: CapturedNetworkEvent = {
      source: "savemycontext-network-observer",
      providerHint: "chatgpt",
      pageUrl: "https://chatgpt.com/",
      requestId: "req-list-1",
      method: "GET",
      url: "https://chatgpt.com/backend-api/conversations?offset=0&limit=100&order=updated",
      capturedAt: "2026-04-16T18:00:00.000Z",
      response: {
        status: 200,
        ok: true,
        contentType: "application/json",
        text: "",
        json: { items: [{ id: "listed-session", title: "Listed conversation" }] }
      }
    };
    const deceptiveEvent: CapturedNetworkEvent = {
      ...listEvent,
      requestId: "req-deceptive-1",
      url: "https://notchatgpt.com/backend-api/conversation/listed-session"
    };

    expect(scraper.matches(listEvent)).toBe(false);
    expect(scraper.parse(listEvent)).toBeNull();
    expect(scraper.matches(deceptiveEvent)).toBe(false);
    expect(scraper.parse(deceptiveEvent)).toBeNull();
  });
});
