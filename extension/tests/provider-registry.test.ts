import { describe, expect, it } from "vitest";

import { providerRegistry } from "../src/providers/registry";
import { detectProviderFromUrl } from "../src/shared/provider";
import type { CapturedNetworkEvent } from "../src/shared/types";

describe("providerRegistry", () => {
  it("matches Gemini events with relative website URLs without throwing", () => {
    const event: CapturedNetworkEvent = {
      source: "savemycontext-network-observer",
      providerHint: "gemini",
      pageUrl: "https://gemini.google.com/app/abc123",
      requestId: "req-gemini-1",
      method: "POST",
      url: "/_/BardFrontendService/StreamGenerate?rpcids=abc123",
      capturedAt: "2026-03-31T12:00:00.000Z",
      requestBody: {
        text: "f.req=%5B%5D"
      },
      response: {
        status: 200,
        ok: true,
        contentType: "application/json",
        text: "[]"
      }
    };

    expect(() => providerRegistry.find((provider) => provider.matches(event))).not.toThrow();
    expect(providerRegistry.find((provider) => provider.matches(event))?.provider).toBe("gemini");
  });

  it("does not classify X OAuth pages as Grok provider pages", () => {
    expect(detectProviderFromUrl("https://x.com/i/oauth2/authorize?redirect_uri=https%3A%2F%2Faccounts.x.ai%2Fexchange-token")).toBeNull();
    expect(detectProviderFromUrl("https://grok.com/c/example")).toBe("grok");
  });

  it("does not classify deceptive ChatGPT hostnames as ChatGPT pages", () => {
    expect(detectProviderFromUrl("https://notchatgpt.com/backend-api/conversation/abc123")).toBeNull();
    expect(detectProviderFromUrl("https://chatgpt.com/c/example")).toBe("chatgpt");
  });
});
