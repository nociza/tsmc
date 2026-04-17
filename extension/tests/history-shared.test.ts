import { describe, expect, it } from "vitest";

import { countRetryableHistoryFailures } from "../src/injected/history-shared";

describe("history shared helpers", () => {
  it("counts pending conversations that did not produce a synced capture", () => {
    expect(countRetryableHistoryFailures(5, 5)).toBe(0);
    expect(countRetryableHistoryFailures(5, 3)).toBe(2);
  });

  it("does not return negative retryable counts", () => {
    expect(countRetryableHistoryFailures(2, 3)).toBe(0);
  });
});
