import { describe, expect, it } from "vitest";

import { GrokScraper } from "../src/providers/grok";
import type { CapturedNetworkEvent } from "../src/shared/types";

describe("GrokScraper", () => {
  it("parses proactive history sync payloads with explicit messages", () => {
    const scraper = new GrokScraper();

    const event: CapturedNetworkEvent = {
      source: "tsmc-network-observer",
      providerHint: "grok",
      pageUrl: "https://grok.com/c/grok-e2e-session",
      requestId: "req-grok-history-1",
      method: "GET",
      url: "https://grok.com/rest/app-chat/conversations/grok-e2e-session/responses?includeThreads=true",
      capturedAt: "2026-04-01T12:00:00.000Z",
      response: {
        status: 200,
        ok: true,
        contentType: "application/json",
        text: JSON.stringify({
          conversationId: "grok-e2e-session",
          title: "Grok E2E Sync",
          messages: [
            {
              id: "grok-user-1",
              role: "user",
              content: "Explain proactive Grok history sync.",
              occurredAt: "2026-04-01T11:59:00.000Z"
            },
            {
              id: "grok-assistant-1",
              parentId: "grok-user-1",
              role: "assistant",
              content: "It backfills Grok conversations from the website history routes.",
              occurredAt: "2026-04-01T11:59:05.000Z"
            }
          ]
        }),
        json: {
          conversationId: "grok-e2e-session",
          title: "Grok E2E Sync",
          messages: [
            {
              id: "grok-user-1",
              role: "user",
              content: "Explain proactive Grok history sync.",
              occurredAt: "2026-04-01T11:59:00.000Z"
            },
            {
              id: "grok-assistant-1",
              parentId: "grok-user-1",
              role: "assistant",
              content: "It backfills Grok conversations from the website history routes.",
              occurredAt: "2026-04-01T11:59:05.000Z"
            }
          ]
        }
      }
    };

    const snapshot = scraper.parse(event);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.externalSessionId).toBe("grok-e2e-session");
    expect(snapshot?.title).toBe("Grok E2E Sync");
    expect(snapshot?.messages.map((message) => message.id)).toEqual(["grok-user-1", "grok-assistant-1"]);
    expect(snapshot?.messages.map((message) => message.content)).toEqual([
      "Explain proactive Grok history sync.",
      "It backfills Grok conversations from the website history routes."
    ]);
    expect(snapshot?.messages[1]?.parentId).toBe("grok-user-1");
  });
});
