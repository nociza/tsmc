import { describe, expect, it } from "vitest";

import { buildInsertionText, prioritizeKnowledgeResults, resultKindLabel } from "../src/content/quick-search-model";

describe("quick search model", () => {
  it("prioritizes entity and factual results ahead of other result types", () => {
    const ordered = prioritizeKnowledgeResults([
      {
        kind: "session",
        title: "Journal note",
        snippet: "Personal reflection",
        category: "journal",
        user_categories: []
      },
      {
        kind: "todo_list",
        title: "To-Do List",
        snippet: "Buy milk",
        user_categories: []
      },
      {
        kind: "session",
        title: "Rust session",
        snippet: "Rust uses ownership",
        category: "factual",
        user_categories: []
      },
      {
        kind: "entity",
        title: "Rust",
        snippet: "Rust | uses | ownership",
        user_categories: []
      }
    ]);

    expect(ordered.map((item) => item.title)).toEqual(["Rust", "Rust session", "To-Do List", "Journal note"]);
  });

  it("builds concise insertion text for entities and sessions", () => {
    expect(
      buildInsertionText({
        kind: "entity",
        title: "Rust",
        snippet: "Rust | uses | ownership",
        user_categories: []
      })
    ).toBe("Rust | uses | ownership");

    expect(
      buildInsertionText({
        kind: "session",
        title: "Rust session",
        snippet: "Rust uses ownership to manage memory safely.",
        user_categories: []
      })
    ).toBe("Rust session: Rust uses ownership to manage memory safely.");
  });

  it("maps result types to readable labels", () => {
    expect(
      resultKindLabel({
        kind: "session",
        title: "Fact note",
        snippet: "Rust uses ownership.",
        category: "factual",
        user_categories: []
      })
    ).toBe("Fact");
    expect(
      resultKindLabel({
        kind: "entity",
        title: "Rust",
        snippet: "Rust | uses | ownership",
        user_categories: []
      })
    ).toBe("Entity");
  });
});
