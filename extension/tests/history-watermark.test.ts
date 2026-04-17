import { describe, expect, it } from "vitest";

import { activeHistoryWatermarks, shouldCommitHistoryWatermark } from "../src/background/history-watermark";
import type { HistorySyncUpdate } from "../src/shared/types";

function update(partial: Partial<HistorySyncUpdate>): HistorySyncUpdate {
  return {
    provider: "gemini",
    phase: "completed",
    pageUrl: "https://gemini.google.com/app",
    ...partial
  };
}

describe("history sync watermark", () => {
  it("commits only clean completed runs", () => {
    expect(shouldCommitHistoryWatermark(update({ topSessionIds: ["u0__latest"] }))).toBe(true);
  });

  it("does not commit progress updates", () => {
    expect(shouldCommitHistoryWatermark(update({ phase: "started", topSessionIds: ["u0__latest"] }))).toBe(false);
  });

  it("does not commit completed runs with provider drift", () => {
    expect(
      shouldCommitHistoryWatermark(
        update({
          providerDriftAlert: {
            provider: "gemini",
            detectedAt: "2026-04-15T18:59:00.000Z",
            pageUrl: "https://gemini.google.com/app",
            message: "Gemini history sync encountered provider drift symptoms in 144 of 170 conversations."
          }
        })
      )
    ).toBe(false);
  });

  it("does not commit when backend ingestion failed after capture", () => {
    expect(shouldCommitHistoryWatermark(update({ topSessionIds: ["u0__latest"] }), "Backend responded 500")).toBe(false);
  });

  it("does not commit when any conversation remains retryable", () => {
    expect(shouldCommitHistoryWatermark(update({ retryableFailureCount: 1, topSessionIds: ["u0__latest"] }))).toBe(false);
  });

  it("uses stored watermarks when no drift alert is active", () => {
    expect(
      activeHistoryWatermarks(
        "gemini",
        {
          lastTopSessionId: "u0__old",
          lastTopSessionIds: ["u0__latest", "u1__latest"]
        },
        null
      )
    ).toEqual(["u0__latest", "u1__latest"]);
  });

  it("ignores stored watermarks while provider drift is active", () => {
    expect(
      activeHistoryWatermarks(
        "gemini",
        {
          lastTopSessionIds: ["u0__latest"],
          lastDriftAlert: {
            provider: "gemini",
            detectedAt: "2026-04-15T18:59:00.000Z",
            pageUrl: "https://gemini.google.com/app",
            message: "Gemini drift"
          }
        },
        null
      )
    ).toBeUndefined();
  });

  it("ignores stored watermarks when the global status has provider drift", () => {
    expect(
      activeHistoryWatermarks(
        "gemini",
        {
          lastTopSessionIds: ["u0__latest"]
        },
        {
          provider: "gemini",
          detectedAt: "2026-04-15T18:59:00.000Z",
          pageUrl: "https://gemini.google.com/app",
          message: "Gemini drift"
        }
      )
    ).toBeUndefined();
  });
});
