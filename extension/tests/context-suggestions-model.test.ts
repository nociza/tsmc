import { describe, expect, it } from "vitest";

import {
  buildContextSuggestionQueries,
  rankContextualSuggestions
} from "../src/content/context-suggestions-model";

describe("context suggestions model", () => {
  it("builds search queries from the draft and recent user turns", () => {
    const queries = buildContextSuggestionQueries({
      provider: "chatgpt",
      title: "Extension planning",
      draftText: "Add a Grammarly style hover button that injects saved notes into the chat composer.",
      messages: [
        {
          id: "u1",
          role: "user",
          content: "Plan contextual note suggestions for the extension."
        }
      ]
    });

    expect(queries).toContain("grammarly style hover");
    expect(queries.some((query) => query.includes("hover"))).toBe(true);
    expect(queries.length).toBeLessThanOrEqual(6);
  });

  it("keeps only strong factual or entity matches for the current chat", () => {
    const ranked = rankContextualSuggestions(
      {
        provider: "chatgpt",
        title: "Context suggestions",
        draftText: "Add a Grammarly style hover button that injects saved notes into the chat composer.",
        messages: [
          {
            id: "u1",
            role: "user",
            content: "Plan contextual note suggestions for the extension."
          }
        ]
      },
      [
        {
          kind: "session",
          title: "Hover button note injection",
          snippet: "A Grammarly style hover button can insert saved notes into a chat composer without auto-sending.",
          category: "factual",
          user_categories: []
        },
        {
          kind: "entity",
          title: "Grammarly",
          snippet: "Grammarly | uses | hover button affordances near text inputs",
          user_categories: []
        },
        {
          kind: "session",
          title: "Morning journal",
          snippet: "Today I walked to the coffee shop and wrote in my notebook.",
          category: "journal",
          user_categories: []
        },
        {
          kind: "session",
          title: "Generic extension notes",
          snippet: "An extension can have a popup and a settings page.",
          category: "factual",
          user_categories: []
        }
      ]
    );

    expect(ranked.map((result) => result.title)).toEqual(["Hover button note injection", "Grammarly"]);
  });

  it("suppresses weak one-word overlap that would create false suggestions", () => {
    const ranked = rankContextualSuggestions(
      {
        provider: "chatgpt",
        title: "Chat input",
        draftText: "Inject relevant notes into the current chat input box.",
        messages: [
          {
            id: "u1",
            role: "user",
            content: "Make the chat smarter."
          }
        ]
      },
      [
        {
          kind: "session",
          title: "Input validation",
          snippet: "Validate form input before saving extension settings.",
          category: "factual",
          user_categories: []
        }
      ]
    );

    expect(ranked).toEqual([]);
  });
});
